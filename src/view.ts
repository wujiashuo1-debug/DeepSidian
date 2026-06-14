import { App, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type DeepSidianPlugin from "../main";
import {
  DeepSeekMessage,
  DeepSeekToolCall,
  DeepSidianToolRun,
  DeepSidianUndoSnapshot,
  DeepSidianSession,
  MODEL_OPTIONS,
  MODEL_PRICING,
  THINKING_CONFIG,
  THINKING_LEVEL_LABELS,
  THINKING_LEVELS,
  ThinkingLevel,
  thinkingEnabled,
  TokenUsage,
  VIEW_TYPE_DEEPSIDIAN
} from "./types";
import { AgentLoop, RequiredToolGroup } from "./agentLoop";
import { AgentType, executeVaultTool, getToolsForAgentType, ToolContext, UndoSnapshotInput, VAULT_TOOL_DEFINITIONS, WriteConfirmationRequest } from "./vaultTools";

const MAX_HISTORY_MESSAGES = 20;
// 上下文预算（token）：环形表的分母；用量接近上限即自动压缩早期对话。可调（越大越省压缩、越费 token）。
const CONTEXT_BUDGET_TOKENS = 60000;
const COMPACT_AT_RATIO = 0.85;
const KEEP_RECENT_MESSAGES = 8;

const SYSTEM_PROMPT = `你是 DeepSidian，运行在 Obsidian 内的 DeepSeek 助手。
你要用中文优先回答，语气简洁、可靠、像一个熟悉用户知识库的协作伙伴。
你是工具型 Agent，不是单纯聊天框。遇到当前笔记、选中内容、库内资料、文件路径、URL、整理/改写/写入请求时，要主动调用合适工具。
可用能力包括：读取当前笔记、读取选区、列文件、搜笔记、读文件、打开笔记、抓网页（需用户给出 URL）、看图、写 TODO、创建/编辑/追加/插入笔记、派发子任务、执行命令。
你没有联网搜索能力：如果用户要"找资料/搜新闻"但没给具体链接，要说明你无法联网搜索、可基于已有知识回答，并请对方提供 URL 让你用 web_fetch 抓取。
如果用户给图片路径或图片 URL，调用 read_image；如果用户要求保存外链图片，调用 download_image。
只有用户开启写入权限时，才可以创建、编辑、追加或插入笔记；写入前要尽量说明将做什么。
如果提供了当前笔记上下文，优先基于上下文回答；如果上下文不足，要主动调用搜索、读取或网页工具补足。

任务编排原则：
- 遇到需要多步骤、跨多个文件或先调研后整理的复杂请求，先用 todo_write 写一个有序清单，然后逐项推进，每完成一项就用 todo_write 更新状态；所有项标记为 done 之前不要结束任务。
- 当某个子问题需要翻阅大量笔记/网页、或几个子问题彼此独立时，用 dispatch_agent 派发子任务（explore 只读调研、summarize 长文摘要、general 可写执行），只取它返回的结论，保持主线干净。
- 工具失败时阅读错误信息并自我纠正后重试，不要直接放弃。

真实性与执行边界：
- 不要把计划、意图或下一步说成已经完成；只有实际调用工具并收到 ok:true，才可以说“已读取 / 已搜索 / 已抓取 / 已写入 / 已完成”。
- 当用户给了 URL、明确指向库内笔记/文件、或要求写入/执行命令时，必须先调用对应工具，不能只凭常识或编造内容冒充工具结果。
- 但如果只是一般知识或解释类问题（没有具体 URL、不涉及库内某个对象），就正常直接回答，不要强行调用工具，也不要因为"没调工具"而拒绝回答。
- 如果 fetch-proxy 未启动、缺少 URL、写入权限未开启或命令执行不可用，要直接说明“尚未执行”和具体原因，并给出可行下一步。
- 如果用户询问进度，只同步真实状态：已调用哪些工具、哪些成功/失败、还差什么；不要用“马上”“快好了”掩盖未执行。`;

const SUBAGENT_PROMPTS: Record<AgentType, string> = {
  explore: `你是 DeepSidian 的只读调研子 Agent。你只能读取、搜索、列举库内笔记并抓取网页，不能写入。
高效地检索定位信息，完成后用中文给出**结构化、精炼的结论**（关键发现 + 涉及的文件路径/链接），不要堆砌原文。
只有实际调用工具并成功后，才可以声称已读取、已搜索或已抓取；工具不可用或失败时要明确说明尚未完成。`,
  summarize: `你是 DeepSidian 的只读摘要子 Agent。读取指定笔记或文件后，用中文产出忠实、紧凑的摘要，保留关键事实、数据与结论，去掉冗余。
只有实际读取成功后，才可以声称已完成摘要；读取失败或路径缺失时要明确说明。`,
  general: `你是 DeepSidian 的通用执行子 Agent，拥有完整工具（含写入，受用户全局写入开关约束）。
独立完成交给你的任务，必要时读写库内文件，完成后用中文简要汇报你做了什么、产出在哪里。
不要把计划或尝试说成完成；只有工具返回成功后，才可以报告已写入、已修改或已完成。`
};

interface ToolCardHandle {
  cardEl: HTMLDetailsElement;
  statusEl: HTMLElement;
  resultEl: HTMLElement;
  runId?: string;
}

/** bash 命令执行前的确认弹窗，关闭=拒绝。 */
class CommandConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private command: string,
    private description: string | undefined,
    private onChoice: (approved: boolean) => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("执行命令？");

    if (this.description) {
      this.contentEl.createEl("p", { cls: "deepsidian-confirm-desc", text: this.description });
    }

    this.contentEl.createEl("pre", { cls: "deepsidian-confirm-cmd" }).setText(this.command);

    const actionsEl = this.contentEl.createDiv({ cls: "deepsidian-confirm-actions" });
    const denyButton = actionsEl.createEl("button", { text: "拒绝" });
    const allowButton = actionsEl.createEl("button", { cls: "mod-cta", text: "允许执行" });

    denyButton.addEventListener("click", () => this.choose(false));
    allowButton.addEventListener("click", () => this.choose(true));
  }

  onClose() {
    this.choose(false);
  }

  private choose(approved: boolean) {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.onChoice(approved);
    this.close();
  }
}

/** 写入 Obsidian 库或当前编辑器前的确认弹窗。 */
class WriteConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private request: WriteConfirmationRequest,
    private onChoice: (approved: boolean) => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("确认写入？");

    this.contentEl.createEl("p", {
      cls: "deepsidian-confirm-desc",
      text: `${this.request.action}：${this.request.target}`
    });
    renderDiffPreview(this.contentEl, this.request);

    const actionsEl = this.contentEl.createDiv({ cls: "deepsidian-confirm-actions" });
    const denyButton = actionsEl.createEl("button", { text: "取消" });
    const allowButton = actionsEl.createEl("button", { cls: "mod-cta", text: "确认写入" });

    denyButton.addEventListener("click", () => this.choose(false));
    allowButton.addEventListener("click", () => this.choose(true));
  }

  onClose() {
    this.choose(false);
  }

  private choose(approved: boolean) {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.onChoice(approved);
    this.close();
  }
}

function renderDiffPreview(containerEl: HTMLElement, request: WriteConfirmationRequest) {
  if (typeof request.before !== "undefined" && typeof request.after === "string") {
    const diffEl = containerEl.createDiv({ cls: "deepsidian-diff-preview" });
    const headerEl = diffEl.createDiv({ cls: "deepsidian-diff-header", text: "Before / After diff" });
    const bodyEl = diffEl.createDiv({ cls: "deepsidian-diff-body" });

    for (const line of buildLineDiff(request.before ?? "", request.after)) {
      const cls = line.type === "added"
        ? "deepsidian-diff-line is-added"
        : line.type === "removed"
          ? "deepsidian-diff-line is-removed"
          : "deepsidian-diff-line is-context";
      const prefix = line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  ";
      bodyEl.createDiv({ cls, text: `${prefix}${line.text}` });
    }

    if (!bodyEl.children.length) {
      bodyEl.createDiv({ cls: "deepsidian-diff-line is-context", text: "  （无变化）" });
    }

    headerEl.setAttribute("title", "红色为删除，绿色为新增。");
    return;
  }

  containerEl.createEl("pre", { cls: "deepsidian-confirm-cmd" }).setText(request.preview);
}

type DiffLine = { type: "context" | "added" | "removed"; text: string };

function buildLineDiff(before: string, after: string): DiffLine[] {
  const maxInputLines = 360;
  const beforeAll = before.split("\n");
  const afterAll = after.split("\n");
  const beforeLines = beforeAll.slice(0, maxInputLines);
  const afterLines = afterAll.slice(0, maxInputLines);
  const maxLines = 240;
  const matrix: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
    Array(afterLines.length + 1).fill(0)
  );

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = beforeLines[i] === afterLines[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length && result.length < maxLines) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: "context", text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      result.push({ type: "removed", text: beforeLines[i] });
      i += 1;
    } else {
      result.push({ type: "added", text: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length && result.length < maxLines) {
    result.push({ type: "removed", text: beforeLines[i] });
    i += 1;
  }

  while (j < afterLines.length && result.length < maxLines) {
    result.push({ type: "added", text: afterLines[j] });
    j += 1;
  }

  if (i < beforeLines.length || j < afterLines.length) {
    result.push({ type: "context", text: "… diff 过长，已截断。" });
  }

  if (beforeAll.length > maxInputLines || afterAll.length > maxInputLines) {
    result.push({ type: "context", text: "… 文件过长，仅预览前 360 行。" });
  }

  return result;
}

export class DeepSidianView extends ItemView {
  private conversation: DeepSeekMessage[] = [];
  private toolRuns: DeepSidianToolRun[] = [];
  private undoSnapshots: DeepSidianUndoSnapshot[] = [];
  private timelineEls = new Map<string, HTMLElement>();
  private currentSession!: DeepSidianSession;
  private sessions: DeepSidianSession[] = [];
  private transcriptEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private sessionBarEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private settingsPanelEl!: HTMLElement;
  private writeToggleEl!: HTMLInputElement;
  private todoPanelEl!: HTMLElement;
  private tokenMetaEl!: HTMLElement;
  private settingsOpen = false;
  private isBusy = false;
  private currentAbort: AbortController | null = null;
  private activeTurnId: string | null = null;
  private sessionPromptTokens = 0;
  private sessionCompletionTokens = 0;
  private sessionCostUsd = 0;
  private currentContextTokens = 0;
  private compacting = false;

  constructor(leaf: WorkspaceLeaf, private plugin: DeepSidianPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_DEEPSIDIAN;
  }

  getDisplayText() {
    return "DeepSidian";
  }

  getIcon() {
    return "deepsidian";
  }

  async onOpen() {
    this.sessions = await this.plugin.listSessions();
    this.currentSession = this.sessions[0] ?? this.plugin.createSession();
    this.conversation = [...this.currentSession.messages];
    this.toolRuns = [...(this.currentSession.toolRuns ?? [])];
    this.undoSnapshots = [...(this.currentSession.undoSnapshots ?? [])];
    this.render();
  }

  async onClose() {
    await this.persistCurrentSession();
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("deepsidian-view");

    const headerEl = container.createDiv({ cls: "deepsidian-header" });
    const titleEl = headerEl.createDiv({ cls: "deepsidian-title" });
    const logoWrapEl = titleEl.createSpan({ cls: "deepsidian-mark" });
    logoWrapEl.createEl("img", {
      attr: {
        src: this.plugin.getAssetUrl("assets/deepsidian-orb-512.png"),
        alt: ""
      }
    });
    titleEl.createSpan({ text: "DeepSidian" });

    const actionsEl = headerEl.createDiv({ cls: "deepsidian-actions" });
    const settingsButton = actionsEl.createEl("button", {
      cls: "deepsidian-icon-button",
      attr: {
        "aria-label": "设置",
        "title": "设置"
      }
    });
    setIcon(settingsButton, "settings");
    settingsButton.addEventListener("click", () => {
      this.settingsOpen = !this.settingsOpen;
      this.renderInlineSettings();
    });

    const clearButton = actionsEl.createEl("button", {
      cls: "deepsidian-icon-button",
      attr: {
        "aria-label": "清空对话",
        "title": "清空对话"
      }
    });
    setIcon(clearButton, "trash-2");
    clearButton.addEventListener("click", () => {
      void this.startNewSession();
    });

    this.settingsPanelEl = container.createDiv({ cls: "deepsidian-inline-settings" });
    this.renderInlineSettings();

    this.transcriptEl = container.createDiv({ cls: "deepsidian-transcript" });
    this.renderConversation();

    const composerEl = container.createDiv({ cls: "deepsidian-composer" });
    this.todoPanelEl = composerEl.createDiv({ cls: "deepsidian-todo-panel is-hidden" });
    this.sessionBarEl = composerEl.createDiv({ cls: "deepsidian-sessionbar" });
    this.renderSessionBar();

    const inputShellEl = composerEl.createDiv({ cls: "deepsidian-input-shell" });
    this.inputEl = inputShellEl.createEl("textarea", {
      cls: "deepsidian-input",
      attr: {
        placeholder: "How can I help you today?"
      }
    });

    const composerFooterEl = inputShellEl.createDiv({ cls: "deepsidian-composer-footer" });
    const footerLeftEl = composerFooterEl.createDiv({ cls: "deepsidian-composer-meta" });

    // 模型切换：flash / pro
    const modelPill = footerLeftEl.createEl("button", {
      cls: "deepsidian-pill deepsidian-model-pill",
      attr: { type: "button", title: "切换模型（flash / pro）" }
    });
    const renderModelPill = () => modelPill.setText(this.plugin.settings.model.replace("deepseek-v4-", ""));
    renderModelPill();
    modelPill.addEventListener("click", async () => {
      const index = MODEL_OPTIONS.indexOf(this.plugin.settings.model as (typeof MODEL_OPTIONS)[number]);
      this.plugin.settings.model = MODEL_OPTIONS[(index + 1) % MODEL_OPTIONS.length];
      await this.plugin.saveSettings();
      renderModelPill();
      this.renderTokenMeta();
    });

    // 思考深度：Low / Med / High / Max
    const thinkingPill = footerLeftEl.createEl("button", {
      cls: "deepsidian-pill deepsidian-thinking-pill",
      attr: { type: "button", title: "思考深度（Low / Med / High / Max）" }
    });
    const renderThinkingPill = () => {
      thinkingPill.empty();
      setIcon(thinkingPill.createSpan({ cls: "deepsidian-pill-icon" }), "brain");
      thinkingPill.createSpan({ text: THINKING_LEVEL_LABELS[this.plugin.settings.thinkingLevel] });
      thinkingPill.toggleClass("is-on", thinkingEnabled(this.plugin.settings.thinkingLevel));
    };
    renderThinkingPill();
    thinkingPill.addEventListener("click", async () => {
      const index = THINKING_LEVELS.indexOf(this.plugin.settings.thinkingLevel);
      this.plugin.settings.thinkingLevel = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
      await this.plugin.saveSettings();
      renderThinkingPill();
    });

    // token 计费
    this.tokenMetaEl = footerLeftEl.createSpan({ cls: "deepsidian-token-meta" });
    this.renderTokenMeta();

    const composerActionsEl = composerFooterEl.createDiv({ cls: "deepsidian-composer-actions" });

    const writeLabelEl = composerActionsEl.createEl("label", { cls: "deepsidian-write-toggle" });
    this.writeToggleEl = writeLabelEl.createEl("input", {
      attr: {
        type: "checkbox"
      }
    });
    this.writeToggleEl.checked = this.plugin.settings.enableVaultWrites;
    writeLabelEl.createSpan({ text: "写入" });
    // 底栏“写入”= 总开关：一开即放开全部细粒度写入权限；想精细控制再去设置里关单项。
    this.writeToggleEl.addEventListener("change", async () => {
      const on = this.writeToggleEl.checked;
      this.plugin.settings.enableVaultWrites = on;
      this.setAllWritePermissions(on);
      await this.plugin.saveSettings();
      this.renderInlineSettings();
    });

    const bashLabelEl = composerActionsEl.createEl("label", {
      cls: "deepsidian-write-toggle",
      attr: { title: "允许执行 shell 命令（桌面端，默认每条需确认）" }
    });
    const bashToggle = bashLabelEl.createEl("input", { attr: { type: "checkbox" } });
    bashToggle.checked = this.plugin.settings.enableBash;
    bashLabelEl.createSpan({ text: "命令" });
    bashToggle.addEventListener("change", async () => {
      this.plugin.settings.enableBash = bashToggle.checked;
      await this.plugin.saveSettings();
    });

    this.sendButtonEl = composerActionsEl.createEl("button", {
      cls: "deepsidian-send",
      attr: {
        "aria-label": "发送",
        "title": "发送"
      }
    });
    setIcon(this.sendButtonEl, "send-horizontal");

    this.sendButtonEl.addEventListener("click", () => {
      if (this.isBusy) {
        this.currentAbort?.abort();
        return;
      }

      void this.sendMessage();
    });

    this.inputEl.addEventListener("keydown", (event) => {
      // Enter 发送，Shift+Enter 换行。中文输入法选词时按 Enter 不发送（isComposing / keyCode 229）。
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();

        if (!this.isBusy) {
          void this.sendMessage();
        }
      }
    });
  }

  private renderSessionBar() {
    this.sessionBarEl.empty();

    const recentSessions = [this.currentSession, ...this.sessions.filter((session) => session.id !== this.currentSession.id)]
      .slice(0, 3);

    recentSessions.forEach((session, index) => {
      const button = this.sessionBarEl.createEl("button", {
        cls: session.id === this.currentSession.id
          ? "deepsidian-session-button is-active"
          : "deepsidian-session-button",
        text: String(index + 1),
        attr: {
          title: session.title
        }
      });
      button.addEventListener("click", () => {
        void this.openSession(session.id);
      });
    });

    const newChatButton = this.sessionBarEl.createEl("button", {
      cls: "deepsidian-session-button",
      attr: {
        "aria-label": "New Chat",
        "title": "New Chat"
      }
    });
    setIcon(newChatButton, "plus");
    newChatButton.addEventListener("click", () => {
      void this.startNewSession();
    });

    const historyButton = this.sessionBarEl.createEl("button", {
      cls: "deepsidian-session-button",
      attr: {
        "aria-label": "Chat history",
        "title": "Chat history"
      }
    });
    setIcon(historyButton, "history");
    historyButton.addEventListener("click", () => {
      this.showSessionHistoryNotice();
    });
  }

  private async startNewSession() {
    await this.persistCurrentSession();
    this.currentSession = this.plugin.createSession();
    this.conversation = [];
    this.toolRuns = [];
    this.undoSnapshots = [];
    this.sessions = [this.currentSession, ...this.sessions.filter((session) => session.id !== this.currentSession.id)];
    this.clearTodoPanel();
    this.resetSessionUsage();
    this.renderConversation();
    this.renderSessionBar();
  }

  private async openSession(sessionId: string) {
    await this.persistCurrentSession();

    const session = await this.plugin.loadSession(sessionId);

    if (!session) {
      new Notice("没有找到这个会话。");
      return;
    }

    this.currentSession = session;
    this.conversation = [...session.messages];
    this.toolRuns = [...(session.toolRuns ?? [])];
    this.undoSnapshots = [...(session.undoSnapshots ?? [])];
    this.sessions = await this.plugin.listSessions();
    this.clearTodoPanel();
    this.resetSessionUsage();
    this.renderConversation();
    this.renderSessionBar();
  }

  private showSessionHistoryNotice() {
    const titles = this.sessions
      .slice(0, 5)
      .map((session, index) => `${index + 1}. ${session.title}`)
      .join("\n");

    new Notice(titles || "暂无历史会话。", 6000);
  }

  private renderConversation() {
    this.transcriptEl.empty();
    this.timelineEls.clear();

    if (!this.conversation.length) {
      this.renderEmptyState();
      return;
    }

    for (const message of this.conversation) {
      if (message.role === "user") {
        this.appendBubble("user", message.content ?? "");
      } else if (message.role === "assistant") {
        const bubbleEl = this.transcriptEl.createDiv({ cls: "deepsidian-bubble deepsidian-bubble-assistant" });
        void this.renderAssistantInto(bubbleEl, message.content ?? "");
        this.renderToolHistory(message.turnId);
        this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
      }
    }
  }

  private renderEmptyState() {
    this.transcriptEl.empty();
    this.emptyStateEl = this.transcriptEl.createDiv({ cls: "deepsidian-empty" });
    this.emptyStateEl.createEl("img", {
      cls: "deepsidian-empty-art",
      attr: {
        src: this.plugin.getAssetUrl("assets/deepsidian-orb-512.png"),
        alt: ""
      }
    });
    this.emptyStateEl.createDiv({ cls: "deepsidian-empty-title", text: "How's it going?" });
    this.emptyStateEl.createDiv({
      cls: "deepsidian-empty-subtitle",
      text: "读笔记、搜库、改写选区、抓网页，或者让 DeepSidian 直接整理当前文件。"
    });
  }

  private renderInlineSettings() {
    if (!this.settingsPanelEl) {
      return;
    }

    this.settingsPanelEl.empty();
    this.settingsPanelEl.toggleClass("is-hidden", !this.settingsOpen);

    if (!this.settingsOpen) {
      return;
    }

    const apiRow = this.settingsPanelEl.createDiv({ cls: "deepsidian-setting-row" });
    apiRow.createEl("label", { text: "API Key" });
    const apiInput = apiRow.createEl("input", {
      attr: {
        type: "password",
        placeholder: "sk-...",
        autocomplete: "off"
      }
    });
    apiInput.value = this.plugin.settings.apiKey;
    apiInput.addEventListener("change", async () => {
      this.plugin.settings.apiKey = apiInput.value.trim();
      await this.plugin.saveSettings();
    });

    const baseUrlRow = this.settingsPanelEl.createDiv({ cls: "deepsidian-setting-row" });
    baseUrlRow.createEl("label", { text: "Base URL" });
    const baseUrlInput = baseUrlRow.createEl("input", {
      attr: {
        type: "text",
        placeholder: "https://api.deepseek.com"
      }
    });
    baseUrlInput.value = this.plugin.settings.baseUrl;
    baseUrlInput.addEventListener("change", async () => {
      this.plugin.settings.baseUrl = baseUrlInput.value.trim() || "https://api.deepseek.com";
      await this.plugin.saveSettings();
    });

    const modelRow = this.settingsPanelEl.createDiv({ cls: "deepsidian-setting-row" });
    modelRow.createEl("label", { text: "模型" });
    const modelSelect = modelRow.createEl("select");
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      modelSelect.createEl("option", {
        text: model,
        value: model
      });
    }
    modelSelect.value = this.plugin.settings.model;
    modelSelect.addEventListener("change", async () => {
      this.plugin.settings.model = modelSelect.value;
      await this.plugin.saveSettings();
      this.render();
    });

    const toggleRow = this.settingsPanelEl.createDiv({ cls: "deepsidian-setting-row deepsidian-setting-row-inline" });
    const contextLabel = toggleRow.createEl("label");
    const contextToggle = contextLabel.createEl("input", { attr: { type: "checkbox" } });
    contextToggle.checked = this.plugin.settings.includeActiveNote;
    contextLabel.createSpan({ text: "自动带上当前笔记" });
    contextToggle.addEventListener("change", async () => {
      this.plugin.settings.includeActiveNote = contextToggle.checked;
      await this.plugin.saveSettings();
    });

    const writeLabel = toggleRow.createEl("label");
    const writeToggle = writeLabel.createEl("input", { attr: { type: "checkbox" } });
    writeToggle.checked = this.plugin.settings.enableVaultWrites;
    writeLabel.createSpan({ text: "允许写入笔记（总开关）" });
    writeToggle.addEventListener("change", async () => {
      const on = writeToggle.checked;
      this.plugin.settings.enableVaultWrites = on;
      this.setAllWritePermissions(on);
      if (this.writeToggleEl) {
        this.writeToggleEl.checked = on;
      }
      await this.plugin.saveSettings();
      this.renderInlineSettings();
    });

    const permissionRow = this.settingsPanelEl.createDiv({ cls: "deepsidian-setting-row deepsidian-setting-row-inline deepsidian-write-permissions" });
    this.renderInlineWritePermission(permissionRow, "createNotes", "新建");
    this.renderInlineWritePermission(permissionRow, "editNotes", "编辑");
    this.renderInlineWritePermission(permissionRow, "appendActiveNote", "追加");
    this.renderInlineWritePermission(permissionRow, "insertAtCursor", "选区");
    this.renderInlineWritePermission(permissionRow, "downloadAttachments", "附件");

    const testButton = this.settingsPanelEl.createEl("button", { cls: "deepsidian-secondary-button" });
    testButton.setText("测试连接");
    testButton.addEventListener("click", async () => {
      testButton.disabled = true;
      testButton.setText("测试中...");
      await this.plugin.testConnection();
      testButton.disabled = false;
      testButton.setText("测试连接");
    });
  }

  private setAllWritePermissions(value: boolean) {
    const perms = this.plugin.settings.writePermissions;
    (Object.keys(perms) as (keyof typeof perms)[]).forEach((key) => {
      perms[key] = value;
    });
  }

  private renderInlineWritePermission(
    containerEl: HTMLElement,
    key: keyof typeof this.plugin.settings.writePermissions,
    label: string
  ) {
    const itemEl = containerEl.createEl("label");
    const checkbox = itemEl.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = this.plugin.settings.writePermissions[key];
    itemEl.createSpan({ text: label });
    checkbox.addEventListener("change", async () => {
      this.plugin.settings.writePermissions[key] = checkbox.checked;
      await this.plugin.saveSettings();
    });
  }

  private async sendMessage() {
    const userText = this.inputEl.value.trim();

    if (!userText) {
      return;
    }

    if (!this.plugin.settings.apiKey.trim()) {
      new Notice("请先点击侧边栏右上角设置，填写 DeepSeek API Key。");
      this.settingsOpen = true;
      this.renderInlineSettings();
      return;
    }

    this.inputEl.value = "";
    const abort = new AbortController();
    this.currentAbort = abort;
    this.setBusy(true);
    if (this.emptyStateEl?.isConnected) {
      this.transcriptEl.empty();
      this.timelineEls.clear();
    }
    this.appendBubble("user", userText);

    const pendingEl = this.appendBubble("assistant", "正在思考...");
    const turnId = this.createTurnId();
    this.activeTurnId = turnId;

    try {
      // 始终带工具走 Agent 循环；不再用关键词猜测，避免模型在无工具时“用文字编造”工具调用。
      const result = await this.runAgent(userText, abort.signal, pendingEl);

      this.currentContextTokens = result.contextTokens || this.currentContextTokens;
      this.addUsage(result.usage);

      if (abort.signal.aborted) {
        await this.renderMarkdown(pendingEl, result.content || "已中断。");
        return;
      }

      this.conversation.push({ role: "user", content: userText, turnId });
      this.conversation.push({ role: "assistant", content: result.content, turnId });
      this.updateSessionMemory(userText, result.content, turnId);
      await this.persistCurrentSession(userText);

      await this.renderAssistantInto(pendingEl, result.content);

      // 上下文用量接近预算 → 后台压缩早期对话，下一轮上下文变小、环掉下来。
      void this.maybeCompactHistory();
    } catch (error) {
      if (abort.signal.aborted) {
        pendingEl.setText("已中断。");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      pendingEl.setText(`出错了：${message}`);
      new Notice(`DeepSidian 请求失败：${message}`, 8000);
    } finally {
      this.activeTurnId = null;
      this.currentAbort = null;
      this.setBusy(false);
    }
  }

  private async runAgent(userText: string, signal: AbortSignal, pendingEl: HTMLElement) {
    const config = THINKING_CONFIG[this.plugin.settings.thinkingLevel];
    const requiredGroups = this.inferRequiredToolGroups(userText);

    // 流式渲染：节流 ~80ms + 串行化，避免并发渲染同一个气泡。
    let lastRender = 0;
    let latest = "";
    let renderChain: Promise<void> = Promise.resolve();
    const flushStream = () => {
      renderChain = renderChain
        .then(() => this.renderMarkdown(pendingEl, latest))
        .then(() => {
          this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
        });
    };

    const loop = new AgentLoop({
      client: this.plugin.createClient(),
      tools: VAULT_TOOL_DEFINITIONS,
      toolContext: this.buildToolContext(signal, true),
      maxSteps: this.plugin.settings.maxToolSteps,
      thinking: config.thinking,
      // 只有识别出"明确需要某类工具"时才强制 + 纠偏；普通知识/解释类问题正常直接回答。
      requireToolUse: requiredGroups.length > 0,
      requiredToolGroups: requiredGroups,
      reflectionRounds: config.reflectionRounds,
      signal,
      callbacks: {
        onToolStart: (toolCall, args) => this.startToolCard(toolCall, args),
        onToolFinish: (card, ok, content) => this.finishToolCard(card as ToolCardHandle, ok, content),
        onTodoUpdate: (markdown) => this.renderTodoPanel(markdown),
        onReflect: (round, total) => pendingEl.setText(`正在第 ${round}/${total} 轮自我反思…`),
        onAssistantDelta: (content) => {
          latest = content;
          const now = Date.now();
          if (now - lastRender >= 80) {
            lastRender = now;
            flushStream();
          }
        }
      }
    });

    const result = await loop.run(await this.buildMessages(userText));
    await renderChain; // 等最后一帧流式渲染落地，避免与 sendMessage 的最终渲染打架
    return result;
  }

  /**
   * 只在“明确需要某类工具”时返回对应组，用于强制 + 纠偏。
   * 故意保守：宁可少判（模型仍带着全部工具、靠系统提示自行决定），也不要把普通问答误判成必须调工具而拒答。
   */
  private inferRequiredToolGroups(userText: string): RequiredToolGroup[] {
    const groups = new Set<RequiredToolGroup>();
    const hasUrl = /\bhttps?:\/\/\S+/i.test(userText);
    const hasImagePath = /\S+\.(png|jpe?g|webp|gif|bmp|svg|avif)\b/i.test(userText);

    // 抓网页：只有给了真实的非图片 URL 才强制（没 URL 抓不了，也没有联网搜索工具）。
    if (hasUrl && !hasImagePath) {
      groups.add("web");
    }

    // 看图：给了图片路径/链接，或明确指向某张图。
    if (hasImagePath || /这张图|这幅图|这个截图|截图里|图中文字|识别.*图|看这张|读这张/i.test(userText)) {
      groups.add("image");
    }

    // 库内：明确指向库里的某个对象 / 选区 / 全库检索。
    if (/当前笔记|这篇笔记|这个笔记|本笔记|这条笔记|当前文件|这个文件|我的笔记|笔记里|库里|全库|整个库|选中|选区|搜笔记|搜索笔记/i.test(userText)) {
      groups.add("vault");
    }

    // 写入：明确的创建 / 保存 / 应用意图（不含模糊的“改写/编辑”，以免误改文档或误拒答）。
    if (/创建|新建|写入|保存到|存到|存为|另存|追加到|追加进|插入到|替换为|替换成|整理到|归档到|写到/i.test(userText)) {
      groups.add("write");
    }

    // 命令：明确要求执行 shell。
    if (/\bbash\b|shell|终端|命令行|执行命令|运行命令|跑(一下|个)?命令/i.test(userText)) {
      groups.add("bash");
    }

    return [...groups];
  }

  private async runSubAgent(task: string, agentType: AgentType, signal?: AbortSignal): Promise<string> {
    const loop = new AgentLoop({
      client: this.plugin.createClient(),
      tools: getToolsForAgentType(agentType),
      toolContext: this.buildToolContext(signal, false),
      maxSteps: Math.min(12, Math.max(1, this.plugin.settings.maxToolSteps)),
      thinking: false,
      signal
    });

    const result = await loop.run([
      { role: "system", content: SUBAGENT_PROMPTS[agentType] ?? SUBAGENT_PROMPTS.explore },
      { role: "user", content: task }
    ]);

    return result.content;
  }

  private buildToolContext(signal: AbortSignal | undefined, allowDispatch: boolean): ToolContext {
    const context: ToolContext = {
      app: this.app,
      settings: this.plugin.settings,
      saveTaskList: (markdown: string) => this.plugin.saveTaskList(markdown),
      describeImage: (dataUrl: string, prompt?: string) =>
        this.plugin.createClient().describeImage(dataUrl, prompt),
      confirmWrite: (request: WriteConfirmationRequest) => this.confirmWrite(request),
      recordUndo: (snapshot: UndoSnapshotInput) => this.recordUndo(snapshot),
      confirmCommand: (command: string, description?: string) => this.confirmCommand(command, description)
    };

    // 仅主 Agent 拿到派发能力；子 Agent 拿不到 → 深度 ≤ 1，无法无限嵌套。
    if (allowDispatch) {
      context.dispatchAgent = (subTask: string, subType: AgentType) =>
        this.runSubAgent(subTask, subType, signal);
    }

    return context;
  }

  private async buildMessages(userText: string): Promise<DeepSeekMessage[]> {
    const messages: DeepSeekMessage[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      }
    ];

    const activeNoteContext = await this.plugin.getActiveNoteContext();

    if (activeNoteContext) {
      messages.push({
        role: "system",
        content: activeNoteContext
      });
    }

    const selectionContext = this.getSelectionContext();

    if (selectionContext) {
      messages.push({
        role: "system",
        content: selectionContext
      });
    }

    const memoryContext = this.formatSessionMemory();

    if (memoryContext) {
      messages.push({
        role: "system",
        content: memoryContext
      });
    }

    // 已压缩的早期对话作为“前情提要”注入；其后的近期消息原样回注。
    const summarizedCount = Math.min(this.currentSession?.summarizedCount ?? 0, this.conversation.length);
    const summary = this.currentSession?.summary?.trim();

    if (summary) {
      messages.push({
        role: "system",
        content: `对话前情提要（早期内容的压缩，仅作延续参考）：\n${summary}`
      });
    }

    // 未压缩的近期消息（compaction 由 token 预算驱动，会把更早的折进摘要）。再兜底一道防极端长尾。
    const recentHistory = this.conversation.slice(summarizedCount).slice(-MAX_HISTORY_MESSAGES);
    messages.push(...recentHistory);
    messages.push({
      role: "user",
      content: userText
    });

    return messages;
  }

  private appendBubble(role: "user" | "assistant", content: string) {
    const bubbleEl = this.transcriptEl.createDiv({
      cls: `deepsidian-bubble deepsidian-bubble-${role}`
    });

    void this.renderMarkdown(bubbleEl, content);
    this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
    return bubbleEl;
  }

  private startToolCard(toolCall: DeepSeekToolCall, args: Record<string, unknown>): ToolCardHandle {
    const runId = this.createTurnId();
    const run: DeepSidianToolRun = {
      id: runId,
      turnId: this.activeTurnId ?? "unknown",
      toolCallId: toolCall.id,
      name: toolCall.function.name,
      args: this.cloneToolArgs(args),
      ok: null,
      content: "",
      startedAt: Date.now()
    };
    this.toolRuns.push(run);

    const timelineEl = this.ensureToolTimeline(run.turnId);
    const cardEl = timelineEl.createEl("details", {
      cls: "deepsidian-tool-card is-running"
    });
    cardEl.open = true;
    const summaryEl = cardEl.createEl("summary");
    summaryEl.createSpan({ cls: "deepsidian-tool-name", text: toolCall.function.name });
    const statusEl = summaryEl.createSpan({ cls: "deepsidian-tool-status", text: "运行中" });

    const argsEl = cardEl.createEl("pre", { cls: "deepsidian-tool-args" });
    argsEl.setText(JSON.stringify(args, null, 2));

    const resultEl = cardEl.createEl("pre", { cls: "deepsidian-tool-result" });
    resultEl.setText("...");

    this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
    return { cardEl, statusEl, resultEl, runId };
  }

  private finishToolCard(
    elements: ToolCardHandle,
    ok: boolean,
    content: string
  ) {
    elements.cardEl.removeClass("is-running");
    elements.cardEl.addClass(ok ? "is-ok" : "is-error");
    elements.statusEl.setText(ok ? "完成" : "失败");
    elements.resultEl.setText(content);
    elements.cardEl.open = false;

    if (elements.runId) {
      const run = this.toolRuns.find((item) => item.id === elements.runId);

      if (run) {
        run.ok = ok;
        run.content = this.clipToolContent(content);
        run.finishedAt = Date.now();
        this.renderToolActionButtons(elements.cardEl, run);
      }
    }

    this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
  }

  private renderToolHistory(turnId: string | undefined) {
    if (!turnId) {
      return;
    }

    const runs = this.toolRuns.filter((run) => run.turnId === turnId);

    if (!runs.length && !this.hasUndoableSnapshots(turnId)) {
      return;
    }

    const timelineEl = this.ensureToolTimeline(turnId);

    for (const run of runs) {
      const cardEl = timelineEl.createEl("details", {
        cls: `deepsidian-tool-card ${run.ok === false ? "is-error" : run.ok === null ? "is-running" : "is-ok"}`
      });
      const summaryEl = cardEl.createEl("summary");
      summaryEl.createSpan({ cls: "deepsidian-tool-name", text: run.name });
      summaryEl.createSpan({ cls: "deepsidian-tool-status", text: run.ok === false ? "失败" : run.ok === null ? "未完成" : "完成" });

      const argsEl = cardEl.createEl("pre", { cls: "deepsidian-tool-args" });
      argsEl.setText(JSON.stringify(run.args, null, 2));

      const resultEl = cardEl.createEl("pre", { cls: "deepsidian-tool-result" });
      resultEl.setText(run.content || "(无结果预览)");
      this.renderToolActionButtons(cardEl, run);
    }
  }

  private ensureToolTimeline(turnId: string) {
    const cached = this.timelineEls.get(turnId);

    if (cached?.isConnected) {
      return cached;
    }

    const timelineEl = this.transcriptEl.createDiv({ cls: "deepsidian-tool-timeline" });
    const headerEl = timelineEl.createDiv({ cls: "deepsidian-tool-timeline-header" });
    headerEl.createSpan({ text: "执行时间线" });

    if (this.hasUndoableSnapshots(turnId)) {
      const undoButton = headerEl.createEl("button", {
        cls: "deepsidian-tool-action",
        text: "撤销本轮写入"
      });
      undoButton.addEventListener("click", () => {
        void this.undoTurnWrites(turnId);
      });
    }

    this.timelineEls.set(turnId, timelineEl);
    return timelineEl;
  }

  private renderToolActionButtons(cardEl: HTMLElement, run: DeepSidianToolRun) {
    const old = cardEl.querySelector(".deepsidian-tool-actions");

    if (old) {
      old.remove();
    }

    if (run.ok !== false) {
      return;
    }

    const actionsEl = cardEl.createDiv({ cls: "deepsidian-tool-actions" });
    const retryButton = actionsEl.createEl("button", { cls: "deepsidian-tool-action", text: "重试工具" });
    retryButton.addEventListener("click", () => {
      void this.retryToolRun(run, cardEl as HTMLDetailsElement);
    });

    if (run.content.includes("fetch-proxy") || run.content.includes("127.0.0.1:3001")) {
      const copyButton = actionsEl.createEl("button", { cls: "deepsidian-tool-action", text: "复制启动命令" });
      copyButton.addEventListener("click", async () => {
        await navigator.clipboard.writeText("cd fetch-proxy && npm run dev");
        new Notice("已复制 fetch-proxy 启动命令。");
      });
    }

    if (/未配置|未启用|权限不足|API Key|写入权限/.test(run.content)) {
      const settingsButton = actionsEl.createEl("button", { cls: "deepsidian-tool-action", text: "打开设置" });
      settingsButton.addEventListener("click", () => {
        this.settingsOpen = true;
        this.renderInlineSettings();
      });
    }
  }

  private async retryToolRun(run: DeepSidianToolRun, cardEl: HTMLDetailsElement) {
    cardEl.removeClass("is-error");
    cardEl.addClass("is-running");
    const statusEl = cardEl.querySelector(".deepsidian-tool-status") as HTMLElement | null;
    const resultEl = cardEl.querySelector(".deepsidian-tool-result") as HTMLElement | null;
    statusEl?.setText("运行中");
    resultEl?.setText("...");

    const previousTurnId = this.activeTurnId;
    this.activeTurnId = run.turnId;

    try {
      const result = await executeVaultTool(this.buildToolContext(undefined, true), run.name, run.args);
      run.ok = result.ok;
      run.content = this.clipToolContent(result.content);
      run.finishedAt = Date.now();

      cardEl.removeClass("is-running");
      cardEl.addClass(result.ok ? "is-ok" : "is-error");
      statusEl?.setText(result.ok ? "完成" : "失败");
      resultEl?.setText(result.content);
      this.renderToolActionButtons(cardEl, run);
      await this.persistCurrentSession();
    } finally {
      this.activeTurnId = previousTurnId;
    }
  }

  private async renderMarkdown(targetEl: HTMLElement, content: string) {
    targetEl.empty();
    await MarkdownRenderer.render(this.app, content, targetEl, "", this);
  }

  // 渲染完整 Markdown 后再挂复制按钮（在 await 之后，避免被 empty() 清掉）。
  private async renderAssistantInto(bubbleEl: HTMLElement, content: string) {
    await this.renderMarkdown(bubbleEl, content);
    this.addCopyButton(bubbleEl, content);
  }

  private addCopyButton(bubbleEl: HTMLElement, content: string) {
    if (!content.trim()) {
      return;
    }

    const button = bubbleEl.createEl("button", {
      cls: "deepsidian-copy-button",
      attr: { "aria-label": "复制", title: "复制" }
    });
    setIcon(button, "copy");

    button.addEventListener("click", async (event) => {
      event.stopPropagation();

      try {
        await navigator.clipboard.writeText(content);
        setIcon(button, "check");
        window.setTimeout(() => setIcon(button, "copy"), 1200);
      } catch {
        new Notice("复制失败。");
      }
    });
  }

  private setBusy(isBusy: boolean) {
    this.isBusy = isBusy;
    this.inputEl.disabled = isBusy;
    // 忙碌时按钮变成“停止”，仍可点击以中断当前请求。
    this.sendButtonEl.empty();
    setIcon(this.sendButtonEl, isBusy ? "square" : "send-horizontal");
    this.sendButtonEl.setAttribute("title", isBusy ? "停止" : "发送");
    this.sendButtonEl.setAttribute("aria-label", isBusy ? "停止" : "发送");
  }

  private confirmCommand(command: string, description?: string): Promise<boolean> {
    return new Promise((resolve) => {
      new CommandConfirmModal(this.app, command, description, resolve).open();
    });
  }

  private confirmWrite(request: WriteConfirmationRequest): Promise<boolean> {
    return new Promise((resolve) => {
      new WriteConfirmModal(this.app, request, resolve).open();
    });
  }

  private recordUndo(snapshot: UndoSnapshotInput) {
    const turnId = this.activeTurnId ?? "manual";
    this.undoSnapshots.push({
      id: this.createTurnId(),
      turnId,
      action: snapshot.action,
      target: snapshot.target,
      path: snapshot.path,
      beforeContent: snapshot.beforeContent,
      afterContent: snapshot.afterContent,
      createdAt: Date.now()
    });
    this.ensureUndoButton(turnId);
  }

  private ensureUndoButton(turnId: string) {
    const timelineEl = this.timelineEls.get(turnId);

    if (!timelineEl || timelineEl.querySelector(".deepsidian-undo-turn")) {
      return;
    }

    const headerEl = timelineEl.querySelector(".deepsidian-tool-timeline-header");
    const undoButton = headerEl?.createEl("button", {
      cls: "deepsidian-tool-action deepsidian-undo-turn",
      text: "撤销本轮写入"
    });
    undoButton?.addEventListener("click", () => {
      void this.undoTurnWrites(turnId);
    });
  }

  private hasUndoableSnapshots(turnId: string) {
    return this.undoSnapshots.some((snapshot) => snapshot.turnId === turnId && !snapshot.undoneAt);
  }

  private async undoTurnWrites(turnId: string) {
    const snapshots = this.undoSnapshots
      .filter((snapshot) => snapshot.turnId === turnId && !snapshot.undoneAt)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (!snapshots.length) {
      new Notice("本轮没有可撤销的写入。");
      return;
    }

    for (const snapshot of snapshots) {
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);

      if (snapshot.beforeContent === null) {
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
        }
      } else if (file instanceof TFile) {
        await this.app.vault.modify(file, snapshot.beforeContent);
      } else {
        await this.plugin.ensureVaultFolderForPath(snapshot.path);
        await this.app.vault.create(snapshot.path, snapshot.beforeContent);
      }

      snapshot.undoneAt = Date.now();
    }

    await this.persistCurrentSession();
    new Notice(`已撤销本轮 ${snapshots.length} 个写入。`);
    this.renderConversation();
    this.renderSessionBar();
  }

  private getSelectionContext(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = view?.editor.getSelection()?.trim();

    if (!selection) {
      return null;
    }

    const clipped = selection.length > 4000 ? `${selection.slice(0, 4000)}\n\n[选区过长，已截断。]` : selection;
    return `用户当前在编辑器中选中的文本：\n${clipped}`;
  }

  private renderTodoPanel(markdown: string) {
    if (!this.todoPanelEl) {
      return;
    }

    this.todoPanelEl.empty();
    this.todoPanelEl.removeClass("is-hidden");
    this.todoPanelEl.createDiv({ cls: "deepsidian-todo-header", text: "任务进度" });
    const bodyEl = this.todoPanelEl.createDiv({ cls: "deepsidian-todo-body" });
    void this.renderMarkdown(bodyEl, markdown);
  }

  private clearTodoPanel() {
    if (!this.todoPanelEl) {
      return;
    }

    this.todoPanelEl.empty();
    this.todoPanelEl.addClass("is-hidden");
  }

  private addUsage(usage: TokenUsage | undefined) {
    if (!usage) {
      return;
    }

    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    this.sessionPromptTokens += prompt;
    this.sessionCompletionTokens += completion;

    const price = MODEL_PRICING[this.plugin.settings.model] ?? MODEL_PRICING["deepseek-v4-flash"];
    this.sessionCostUsd += (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;

    this.renderTokenMeta();
  }

  private renderTokenMeta() {
    if (!this.tokenMetaEl) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, this.currentContextTokens / CONTEXT_BUDGET_TOKENS));
    const pct = Math.round(ratio * 100);

    this.tokenMetaEl.empty();
    this.tokenMetaEl.setAttribute(
      "title",
      `上下文占用：${this.currentContextTokens} / ${CONTEXT_BUDGET_TOKENS} tokens（${pct}%，达到 ${Math.round(COMPACT_AT_RATIO * 100)}% 自动压缩早期对话）\n` +
        `本会话累计：输入 ${this.sessionPromptTokens} / 输出 ${this.sessionCompletionTokens} tokens，估算 $${this.sessionCostUsd.toFixed(4)}`
    );

    this.renderContextRing(this.tokenMetaEl, ratio);
    this.tokenMetaEl.createSpan({ text: `${pct}% · $${this.sessionCostUsd.toFixed(4)}` });
  }

  private renderContextRing(container: HTMLElement, ratio: number) {
    const size = 16;
    const stroke = 2.5;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const color =
      ratio >= COMPACT_AT_RATIO ? "#e05050" : ratio >= 0.6 ? "var(--deepsidian-orange)" : "var(--deepsidian-blue)";
    const center = String(size / 2);

    const svg = container.createSvg("svg", {
      cls: "deepsidian-context-ring",
      attr: { viewBox: `0 0 ${size} ${size}`, width: String(size), height: String(size) }
    });
    svg.createSvg("circle", {
      attr: {
        cx: center,
        cy: center,
        r: String(radius),
        fill: "none",
        stroke: "var(--background-modifier-border)",
        "stroke-width": String(stroke)
      }
    });
    svg.createSvg("circle", {
      attr: {
        cx: center,
        cy: center,
        r: String(radius),
        fill: "none",
        stroke: color,
        "stroke-width": String(stroke),
        "stroke-dasharray": `${(ratio * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
        "stroke-linecap": "round",
        transform: `rotate(-90 ${center} ${center})`
      }
    });
  }


  private resetSessionUsage() {
    this.sessionPromptTokens = 0;
    this.sessionCompletionTokens = 0;
    this.sessionCostUsd = 0;
    this.currentContextTokens = 0;
    this.renderTokenMeta();
  }

  /** 上下文用量接近预算时，把"早期对话"增量压成摘要，缩小后续上下文（环也随之回落）。 */
  private async maybeCompactHistory() {
    if (this.compacting || !this.currentSession) {
      return;
    }

    const ratio = this.currentContextTokens / CONTEXT_BUDGET_TOKENS;
    const summarizedCount = this.currentSession.summarizedCount ?? 0;
    const compactableCount = this.conversation.length - summarizedCount - KEEP_RECENT_MESSAGES;

    if (ratio < COMPACT_AT_RATIO || compactableCount <= 0) {
      return;
    }

    this.compacting = true;

    try {
      const batch = this.conversation.slice(summarizedCount, summarizedCount + compactableCount);
      this.currentSession.summary = await this.summarizeHistory(this.currentSession.summary, batch);
      this.currentSession.summarizedCount = summarizedCount + compactableCount;
      await this.persistCurrentSession();
    } catch {
      // 摘要失败就维持现状，绝不影响后续对话。
    } finally {
      this.compacting = false;
    }
  }

  private async summarizeHistory(existing: string | undefined, batch: DeepSeekMessage[]): Promise<string> {
    const transcript = batch
      .map((message) => `${message.role === "user" ? "用户" : "助手"}：${(message.content ?? "").slice(0, 1500)}`)
      .join("\n");
    const prior = existing?.trim() ? `已有摘要：\n${existing.trim()}\n\n` : "";

    const result = await this.plugin.createClient().chat([
      {
        role: "system",
        content:
          "你是对话压缩助手。把对话压成简洁中文要点，保留：用户的目标与偏好、已确定的事实/文件路径/链接、已完成与未完成事项、关键结论。合并进已有摘要、去重，控制在约 400 字内，只输出摘要本身。"
      },
      {
        role: "user",
        content: `${prior}需要合并进摘要的新对话：\n${transcript}`
      }
    ]);

    return result.content.trim() || existing?.trim() || "";
  }

  private formatSessionMemory(): string | null {
    const memory = this.currentSession?.memory;

    if (!memory) {
      return null;
    }

    const parts: string[] = ["DeepSidian 会话工作记忆（压缩上下文，只作任务延续参考）："];

    if (memory.currentGoal) {
      parts.push(`当前目标：${memory.currentGoal}`);
    }

    if (memory.files.length) {
      parts.push(`相关文件：${memory.files.slice(-8).join("；")}`);
    }

    if (memory.completed.length) {
      parts.push(`已完成：${memory.completed.slice(-8).join("；")}`);
    }

    if (memory.blockers.length) {
      parts.push(`失败/阻塞：${memory.blockers.slice(-6).join("；")}`);
    }

    if (memory.notes.length) {
      parts.push(`关键结论：${memory.notes.slice(-5).join("；")}`);
    }

    return parts.length > 1 ? parts.join("\n") : null;
  }

  private updateSessionMemory(userText: string, assistantText: string, turnId: string) {
    const now = Date.now();
    const memory = this.currentSession.memory ?? {
      updatedAt: now,
      completed: [],
      blockers: [],
      files: [],
      notes: []
    };
    const runs = this.toolRuns.filter((run) => run.turnId === turnId);
    const snapshots = this.undoSnapshots.filter((snapshot) => snapshot.turnId === turnId);

    memory.updatedAt = now;
    memory.currentGoal = userText.trim().replace(/\s+/g, " ").slice(0, 180);
    memory.completed = this.compactMemoryList([
      ...memory.completed,
      ...runs
        .filter((run) => run.ok === true)
        .map((run) => `${run.name}${this.describeToolTarget(run.args)}`)
    ], 16);
    memory.blockers = this.compactMemoryList([
      ...memory.blockers,
      ...runs
        .filter((run) => run.ok === false)
        .map((run) => `${run.name}: ${run.content.replace(/\s+/g, " ").slice(0, 160)}`)
    ], 12);
    memory.files = this.compactMemoryList([
      ...memory.files,
      ...runs.flatMap((run) => this.extractToolPaths(run.args)),
      ...snapshots.map((snapshot) => snapshot.path)
    ], 16);

    const note = assistantText.trim().replace(/\s+/g, " ").slice(0, 220);

    if (note) {
      memory.notes = this.compactMemoryList([...memory.notes, note], 10);
    }

    this.currentSession.memory = memory;
  }

  private compactMemoryList(values: string[], limit: number) {
    const clean = values.map((value) => value.trim()).filter(Boolean);
    return [...new Set(clean)].slice(-limit);
  }

  private describeToolTarget(args: Record<string, unknown>) {
    const target = args.path ?? args.url ?? args.source ?? args.query ?? "";
    return typeof target === "string" && target ? `(${target.slice(0, 80)})` : "";
  }

  private extractToolPaths(args: Record<string, unknown>) {
    return ["path", "source", "filename"]
      .map((key) => args[key])
      .filter((value): value is string => typeof value === "string" && !/^https?:\/\//i.test(value));
  }

  private async persistCurrentSession(firstUserMessage?: string) {
    if (!this.currentSession) {
      return;
    }

    if (firstUserMessage && this.currentSession.title === "New Chat") {
      this.currentSession.title = firstUserMessage.trim().replace(/\s+/g, " ").slice(0, 32) || "New Chat";
    }

    this.currentSession.messages = [...this.conversation];
    this.currentSession.toolRuns = [...this.toolRuns];
    this.currentSession.undoSnapshots = [...this.undoSnapshots];

    if (this.currentSession.messages.length) {
      await this.plugin.saveSession(this.currentSession);
      this.sessions = await this.plugin.listSessions();
    }
  }

  private createTurnId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private cloneToolArgs(args: Record<string, unknown>) {
    try {
      return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    } catch {
      return {
        _unserializable: String(args)
      };
    }
  }

  private clipToolContent(content: string) {
    const maxLength = 4000;
    return content.length > maxLength
      ? `${content.slice(0, maxLength)}\n\n[工具结果过长，历史记录已截断。]`
      : content;
  }
}
