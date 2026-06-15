import { App, ItemView, MarkdownRenderer, MarkdownView, Menu, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type DeepSidianPlugin from "../main";
import {
  DeepSeekMessage,
  DeepSeekToolCall,
  DeepSidianToolRun,
  DeepSidianUndoSnapshot,
  DeepSidianSession,
  EffortLevel,
  Lang,
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
import { createTranslator, Translator } from "./i18n";
import { AgentType, executeVaultTool, getToolsForAgentType, ToolContext, UndoSnapshotInput, VAULT_TOOL_DEFINITIONS, WriteConfirmationRequest } from "./vaultTools";

const MAX_HISTORY_MESSAGES = 20;
// 上下文预算（token）：环形表的分母；用量接近上限即自动压缩早期对话。可调（越大越省压缩、越费 token）。
const CONTEXT_BUDGET_TOKENS = 60000;
const COMPACT_AT_RATIO = 0.85;
const KEEP_RECENT_MESSAGES = 8;

const SYSTEM_PROMPTS: Record<Lang, string> = {
  zh: `始终用中文回答。

你是 DeepSidian，住在用户 Obsidian 知识库里的协作伙伴——既能聊，也能读写笔记、查库、抓网页、看图、执行命令、派工具干活。语气自然不机械；简单的问题就直接、简短地答，别长篇大论，复杂的事才展开。

怎么思考（内化即可，不用念出来）：
- 先分清这是关于用户自己的世界（他的笔记、项目、术语、决定）还是通用知识。前者默认先查库再说（search_notes / read_file / 当前笔记），别凭印象编；后者直接答。
- 用到库内或网页内容时，带上出处（笔记路径、[[双链]] 或来源 URL），方便用户点回去核对；用的是你自己的常识也说一声——别让没核实的话冒充用户的笔记。
- 顺手看到相关的笔记，用 [[双链]] 点出来帮用户把知识连起来——但只在真有帮助时，别硬塞、别刷屏。

写入要当心（你在改用户长期积累的笔记，不是草稿纸）：
- 只在用户明确要写时动手，写前一句话说清改哪儿、改成什么。
- 顺着已有的结构和用户的文风改，动最小范围，别擅自重组或改写风格；新建前先搜有没有重复，沿用用户的文件夹/标签习惯。
- 意图模糊又要写入时，先问一句再动手，别猜着写；纯读取/回答则不必反复确认，给个合理默认即可。
- 只有工具真正成功了才说“已写入 / 已抓取 / 已完成”；做不到（缺 URL、抓取代理没起、没开写入权限等）就直说“还没做 + 原因 + 下一步”，绝不把打算说成做完、不编造结果。

你没有联网搜索：用户只给主题、没给链接时，说明你搜不了、可基于已有知识回答，并请他给 URL 让你用 web_fetch 抓取。

深浅随任务走：记一笔、找某篇、简单问答就直给；跨多篇的综合、整理、搭结构才值得多步深想（先检索铺料 → 再归纳 → 再下结论），这种时候用 todo_write 列清单逐项推进、全部完成前不收尾，子问题彼此独立或要翻大量资料就用 dispatch_agent 派子任务、只取它的结论。`,
  en: `Always reply to the user in English, even if some of these instructions or the context below are written in another language.

You are DeepSidian, a collaborator living inside the user's Obsidian vault — you can chat, and also read/write notes, search the vault, fetch web pages, read images, run commands, and dispatch tools. Keep a natural, non-robotic tone; answer simple questions directly and briefly, and only expand for complex ones.

How to think (internalize, don't narrate):
- First decide whether the question is about the user's own world (their notes, projects, terms, decisions) or general knowledge. For the former, search the vault first (search_notes / read_file / current note) rather than guessing; for the latter, just answer.
- When you use vault or web content, cite the source (note path, [[wikilink]], or source URL) so the user can verify; if you rely on your own general knowledge, say so — never let unverified claims pose as the user's notes.
- When you notice a genuinely relevant note, surface it with a [[wikilink]] to help connect their knowledge — but only when it actually helps; don't spam.

Be careful with writes (you're editing notes the user has built up over time, not a scratchpad):
- Only write when the user clearly asks; before writing, state in one line what you'll change and to what.
- Follow the existing structure and the user's voice, change the smallest scope, and don't reorganize or restyle on your own; before creating a note, search for duplicates and follow the user's folder/tag conventions.
- If intent is unclear and a write is involved, ask one question first; for plain reads/answers, don't keep asking — pick a sensible default.
- Only claim "written / fetched / done" after a tool actually succeeds; if you can't (missing URL, fetch-proxy not running, no write permission, etc.), plainly say "not done yet + reason + next step" — never present a plan as completed, and never fabricate results.

You have no web search: when the user gives only a topic with no link, say you can't search, answer from existing knowledge, and ask for a URL so you can web_fetch it.

Match depth to the task: capture, lookup, and simple Q&A → answer directly; synthesis, tidying, or building structure across many notes → think in steps (gather first → group → conclude), using todo_write to track items (don't wrap up until they're done) and dispatch_agent for independent sub-questions or heavy reading (take only its conclusion).`
};

// 思考深度的“取证/推理力度”提示，按 effort 注入（direct/reason 不加，靠原生思考链）。
const EFFORT_INSTRUCTIONS: Record<EffortLevel, { zh: string; en: string }> = {
  direct: { zh: "", en: "" },
  reason: { zh: "", en: "" },
  thorough: {
    zh: "（思考力度）对不简单的问题：先理清思路，必要时多读几篇相关笔记、多查证、权衡不同角度，再给出一个推敲过的完整答案。",
    en: "(Effort) For non-trivial questions: work out your reasoning first; when useful, read several related notes, verify, and weigh alternatives, then give one well-reasoned, complete answer."
  },
  max: {
    zh: "（深度思考）复杂任务先用 todo_write 拆解步骤、按需用 dispatch_agent 分头调研，把证据收齐、利弊权衡清楚后再综合成一个答案。绝不把同一个答案反复重写。",
    en: "(Deep effort) For complex tasks, break the work down with todo_write, use dispatch_agent to research in parallel when useful, gather and weigh the evidence, then synthesize a single answer. Never rewrite the same answer repeatedly."
  }
};

const SUBAGENT_PROMPTS: Record<AgentType, string> = {
  explore: `你是 DeepSidian 的只读调研子 Agent：只能读、搜、列举库内笔记和抓网页，不能写。高效定位信息，完成后用中文给出结构化、精炼的结论（关键发现 + 涉及的笔记路径/链接），不堆原文。只有工具真正成功才声称读到/搜到/抓到，否则直说没拿到。`,
  summarize: `你是 DeepSidian 的只读摘要子 Agent：读取指定笔记/文件后，产出忠实、紧凑的中文摘要，保留关键事实、数据与结论，去冗余，尽量留住用户原文里的要点与措辞。读不到就直说，别编。`,
  general: `你是 DeepSidian 的通用执行子 Agent，拥有完整工具（含写入，受权限约束）。独立完成任务，写入时顺着已有结构改、动最小范围，完成后用中文简要汇报做了什么、产出在哪。只有工具真正成功才报告已完成。`
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
  private turnFirstTokenAt = 0;
  private t: Translator = createTranslator("zh");

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
    this.loadSessionUsage(this.currentSession);
  }

  async onClose() {
    await this.persistCurrentSession();
  }

  /** 语言等设置变更后由插件调用，重建整个侧栏 UI。 */
  rerender() {
    this.render();
  }

  private render() {
    this.t = createTranslator(this.plugin.settings.language);
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("deepsidian-view");

    const headerEl = container.createDiv({ cls: "deepsidian-header" });
    const titleEl = headerEl.createDiv({ cls: "deepsidian-title" });
    const logoWrapEl = titleEl.createSpan({ cls: "deepsidian-mark" });
    logoWrapEl.createEl("img", {
      attr: {
        src: this.plugin.getAssetUrl("assets/whale.png"),
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
        placeholder: this.t("inputPlaceholder")
      }
    });

    const composerFooterEl = inputShellEl.createDiv({ cls: "deepsidian-composer-footer" });
    const footerLeftEl = composerFooterEl.createDiv({ cls: "deepsidian-composer-meta" });

    // 模型切换：点击弹出菜单选择 flash / pro
    const modelPill = footerLeftEl.createEl("button", {
      cls: "deepsidian-pill deepsidian-model-pill",
      attr: { type: "button", title: this.t("pickModel") }
    });
    const renderModelPill = () => modelPill.setText(this.plugin.settings.model.replace("deepseek-v4-", ""));
    renderModelPill();
    modelPill.addEventListener("click", (event) => {
      const menu = new Menu();
      const hints: Record<string, string> = {
        "deepseek-v4-flash": this.t("modelHintFlash"),
        "deepseek-v4-pro": this.t("modelHintPro")
      };
      for (const model of MODEL_OPTIONS) {
        menu.addItem((item) => {
          item
            .setTitle(`${model.replace("deepseek-v4-", "")} · ${hints[model] ?? ""}`)
            .setChecked(this.plugin.settings.model === model)
            .onClick(async () => {
              this.plugin.settings.model = model;
              await this.plugin.saveSettings();
              renderModelPill();
              this.renderTokenMeta();
            });
        });
      }
      menu.showAtMouseEvent(event);
    });

    // 思考深度：点击弹出菜单选择 Low / Med / High / Max
    const thinkingPill = footerLeftEl.createEl("button", {
      cls: "deepsidian-pill deepsidian-thinking-pill",
      attr: { type: "button", title: this.t("pickThinking") }
    });
    const renderThinkingPill = () => {
      thinkingPill.empty();
      setIcon(thinkingPill.createSpan({ cls: "deepsidian-pill-icon" }), "brain");
      thinkingPill.createSpan({ text: THINKING_LEVEL_LABELS[this.plugin.settings.thinkingLevel] });
      thinkingPill.toggleClass("is-on", thinkingEnabled(this.plugin.settings.thinkingLevel));
    };
    renderThinkingPill();
    thinkingPill.addEventListener("click", (event) => {
      const menu = new Menu();
      for (const level of THINKING_LEVELS) {
        const hintKey =
          level === "low" ? "thinkHintOff" : level === "med" ? "thinkHintMed" : level === "high" ? "thinkHintHigh" : "thinkHintMax";
        menu.addItem((item) => {
          item
            .setTitle(`${THINKING_LEVEL_LABELS[level]} · ${this.t(hintKey)}`)
            .setChecked(this.plugin.settings.thinkingLevel === level)
            .onClick(async () => {
              this.plugin.settings.thinkingLevel = level;
              await this.plugin.saveSettings();
              renderThinkingPill();
            });
        });
      }
      menu.showAtMouseEvent(event);
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
    writeLabelEl.createSpan({ text: this.t("write") });
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
    bashLabelEl.createSpan({ text: this.t("command") });
    bashToggle.addEventListener("change", async () => {
      this.plugin.settings.enableBash = bashToggle.checked;
      await this.plugin.saveSettings();
    });

    this.sendButtonEl = composerActionsEl.createEl("button", {
      cls: "deepsidian-send",
      attr: {
        "aria-label": this.t("send"),
        "title": this.t("send")
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

    // 固定按列表顺序显示最近 3 个会话：当前会话只高亮、不再被钉到 1 号位，所以点哪个就稳稳切到哪个、号码不乱跳。
    const shown = this.sessions.slice(0, 3);
    const recentSessions = shown.some((session) => session.id === this.currentSession.id)
      ? shown
      : [this.currentSession, ...shown].slice(0, 3);

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
        "aria-label": this.t("newChat"),
        "title": this.t("newChat")
      }
    });
    setIcon(newChatButton, "plus");
    newChatButton.addEventListener("click", () => {
      void this.startNewSession();
    });

    const historyButton = this.sessionBarEl.createEl("button", {
      cls: "deepsidian-session-button",
      attr: {
        "aria-label": this.t("history"),
        "title": this.t("history")
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
    if (sessionId === this.currentSession?.id) {
      return; // 已经在这个会话里，点了不动，避免无谓重渲染
    }

    // 保存上一个会话，但切换时不重排列表 —— 号码保持稳定，不会"点一下就跳位"。
    await this.persistCurrentSession(undefined, false);

    const session = await this.plugin.loadSession(sessionId);

    if (!session) {
      new Notice(this.t("sessionNotFound"));
      return;
    }

    this.currentSession = session;
    this.conversation = [...session.messages];
    this.toolRuns = [...(session.toolRuns ?? [])];
    this.undoSnapshots = [...(session.undoSnapshots ?? [])];
    this.clearTodoPanel();
    this.loadSessionUsage(session);
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
        src: this.plugin.getAssetUrl("assets/whale.png"),
        alt: ""
      }
    });
    this.emptyStateEl.createDiv({ cls: "deepsidian-empty-title", text: this.t("emptyTitle") });
    this.emptyStateEl.createDiv({
      cls: "deepsidian-empty-subtitle",
      text: this.t("emptySubtitle")
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
    modelRow.createEl("label", { text: this.t("inlineModel") });
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
    contextLabel.createSpan({ text: this.t("inlineIncludeNote") });
    contextToggle.addEventListener("change", async () => {
      this.plugin.settings.includeActiveNote = contextToggle.checked;
      await this.plugin.saveSettings();
    });

    const writeLabel = toggleRow.createEl("label");
    const writeToggle = writeLabel.createEl("input", { attr: { type: "checkbox" } });
    writeToggle.checked = this.plugin.settings.enableVaultWrites;
    writeLabel.createSpan({ text: this.t("inlineAllowWrite") });
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
    this.renderInlineWritePermission(permissionRow, "createNotes", this.t("permShortCreate"));
    this.renderInlineWritePermission(permissionRow, "editNotes", this.t("permShortEdit"));
    this.renderInlineWritePermission(permissionRow, "appendActiveNote", this.t("permShortAppend"));
    this.renderInlineWritePermission(permissionRow, "insertAtCursor", this.t("permShortInsert"));
    this.renderInlineWritePermission(permissionRow, "downloadAttachments", this.t("permShortDownload"));

    const testButton = this.settingsPanelEl.createEl("button", { cls: "deepsidian-secondary-button" });
    testButton.setText(this.t("testBtn"));
    testButton.addEventListener("click", async () => {
      testButton.disabled = true;
      testButton.setText(this.t("testing"));
      await this.plugin.testConnection();
      testButton.disabled = false;
      testButton.setText(this.t("testBtn"));
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
      new Notice(this.t("needApiKey"));
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

    // 思考气泡：弹跳的小鲸鱼 + 实时计时；开始流式输出后会被正文替换。
    const pendingEl = this.transcriptEl.createDiv({ cls: "deepsidian-bubble deepsidian-bubble-assistant" });
    this.renderThinkingIndicator(pendingEl, this.t("thinking"));
    this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });

    const thinkingStart = Date.now();
    this.turnFirstTokenAt = 0;
    const thinkTimer = window.setInterval(() => {
      const timeEl = pendingEl.querySelector(".deepsidian-think-time");
      if (timeEl) {
        timeEl.textContent = `${((Date.now() - thinkingStart) / 1000).toFixed(1)}s`;
      }
    }, 100);

    const turnId = this.createTurnId();
    this.activeTurnId = turnId;

    try {
      // 始终带工具走 Agent 循环；不再用关键词猜测，避免模型在无工具时“用文字编造”工具调用。
      const result = await this.runAgent(userText, abort.signal, pendingEl);

      this.currentContextTokens = result.contextTokens || this.currentContextTokens;
      this.addUsage(result.usage);

      if (abort.signal.aborted) {
        await this.renderMarkdown(pendingEl, result.content || this.t("interrupted"));
        return;
      }

      this.conversation.push({ role: "user", content: userText, turnId });
      this.conversation.push({ role: "assistant", content: result.content, turnId });
      this.updateSessionMemory(userText, result.content, turnId);
      await this.persistCurrentSession(userText);

      // 思考用时 = 到首个输出 token 的时间（没有则取整轮耗时）。
      const thinkingMs = (this.turnFirstTokenAt || Date.now()) - thinkingStart;
      await this.renderAssistantInto(pendingEl, result.content, thinkingMs);

      // 上下文用量接近预算 → 后台压缩早期对话，下一轮上下文变小、环掉下来。
      void this.maybeCompactHistory();
    } catch (error) {
      if (abort.signal.aborted) {
        pendingEl.setText(this.t("interrupted"));
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      pendingEl.setText(this.t("requestFailed") + message);
      new Notice(this.t("requestFailed") + message, 8000);
    } finally {
      window.clearInterval(thinkTimer);
      this.activeTurnId = null;
      this.currentAbort = null;
      this.setBusy(false);
    }
  }

  private async runAgent(userText: string, signal: AbortSignal, pendingEl: HTMLElement) {
    const config = THINKING_CONFIG[this.plugin.settings.thinkingLevel];
    const requiredGroups = this.inferRequiredToolGroups(userText);

    // 打字机式平滑流式：网络按突发到达（一次给好几个词），但显示按"时间匀速"推进，
    // 把每个突发摊开成连续字流，跟网络节奏解耦 —— 避免"几个词一起蹦、一帧一帧"的卡顿。
    const typewriter = this.createTypewriter(pendingEl);

    const loop = new AgentLoop({
      client: this.plugin.createClient(),
      tools: VAULT_TOOL_DEFINITIONS,
      toolContext: this.buildToolContext(signal, true),
      // 高思考等级放宽工具步数，让它能多取证、多调研。
      maxSteps: Math.min(30, this.plugin.settings.maxToolSteps + config.stepBoost),
      thinking: config.thinking,
      // 只有识别出"明确需要某类工具"时才强制 + 纠偏；普通知识/解释类问题正常直接回答。
      requireToolUse: requiredGroups.length > 0,
      requiredToolGroups: requiredGroups,
      signal,
      callbacks: {
        onToolStart: (toolCall, args) => this.startToolCard(toolCall, args),
        onToolFinish: (card, ok, content) => this.finishToolCard(card as ToolCardHandle, ok, content),
        onTodoUpdate: (markdown) => this.renderTodoPanel(markdown),
        onAssistantDelta: (content) => {
          if (!this.turnFirstTokenAt) {
            this.turnFirstTokenAt = Date.now();
          }
          typewriter.push(content);
        }
      }
    });

    try {
      const result = await loop.run(await this.buildMessages(userText));
      await typewriter.finish(); // 等打字机把剩余字符匀速吐完，再交给 sendMessage 做最终渲染
      return result;
    } finally {
      typewriter.stop(); // 出错/中断时也停掉 rAF 循环，避免泄漏
    }
  }

  /**
   * 打字机：把"目标全文"按时间匀速揭示到气泡里，渲染 Markdown。
   * - push(fullSoFar)：网络每来一段就更新目标全文（突发不直接上屏，由帧循环匀速追上）。
   * - reset()：反思等场景从头开始。
   * - finish()：标记流结束并等待剩余字符吐完。
   */
  private createTypewriter(targetEl: HTMLElement) {
    let target = "";
    let shown = 0;
    let done = false;
    let rendering = false;
    let lastRenderAt = 0;
    let lastFrame = 0;
    let rafId: number | null = null;
    let resolveFinish: (() => void) | null = null;

    const render = async () => {
      if (rendering) {
        return;
      }
      rendering = true;
      lastRenderAt = performance.now();
      try {
        await this.renderMarkdown(targetEl, target.slice(0, shown));
        this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
      } finally {
        rendering = false;
      }
    };

    const frame = (now: number) => {
      const dt = lastFrame ? now - lastFrame : 16;
      lastFrame = now;

      const remaining = target.length - shown;
      if (remaining > 0) {
        // 匀速基线 + 落后越多越快追赶；始终贴着网络又不突跳。
        const cps = Math.max(260, remaining * 12);
        shown = Math.min(target.length, shown + Math.max(1, Math.ceil((cps * dt) / 1000)));
        // 渲染上限 ~30fps，控制 Markdown 重渲染开销；揭示进度仍按时间走，所以观感平滑。
        if (now - lastRenderAt >= 32) {
          void render();
        }
      }

      if (done && shown >= target.length) {
        if (rendering) {
          // 等这帧的渲染落地再结束，避免和 sendMessage 的最终渲染并发写同一个气泡。
          rafId = window.requestAnimationFrame(frame);
          return;
        }
        rafId = null;
        const resolve = resolveFinish;
        resolveFinish = null;
        resolve?.();
        return;
      }

      rafId = window.requestAnimationFrame(frame);
    };

    return {
      push: (fullSoFar: string) => {
        target = fullSoFar;
        if (rafId === null && !done) {
          lastFrame = 0;
          rafId = window.requestAnimationFrame(frame);
        }
      },
      reset: () => {
        target = "";
        shown = 0;
      },
      finish: async () => {
        done = true;
        if (rafId !== null) {
          await new Promise<void>((resolve) => {
            resolveFinish = resolve;
          });
        }
      },
      stop: () => {
        done = true;
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        const resolve = resolveFinish;
        resolveFinish = null;
        resolve?.();
      }
    };
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
        content: SYSTEM_PROMPTS[this.plugin.settings.language] ?? SYSTEM_PROMPTS.zh
      }
    ];

    // 按思考深度注入“想得多深、查得多全”的力度提示（Low/Med 不加，靠原生思考链）。
    const effort = THINKING_CONFIG[this.plugin.settings.thinkingLevel].effort;
    const effortText = EFFORT_INSTRUCTIONS[effort][this.plugin.settings.language] || EFFORT_INSTRUCTIONS[effort].zh;

    if (effortText) {
      messages.push({ role: "system", content: effortText });
    }

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

    const isEn = this.plugin.settings.language === "en";

    if (summary) {
      messages.push({
        role: "system",
        content: isEn
          ? `Conversation summary so far (compressed earlier turns, for continuity only):\n${summary}`
          : `对话前情提要（早期内容的压缩，仅作延续参考）：\n${summary}`
      });
    }

    // 用户消息前再放一条就近的语言提醒，压过上面可能为中文的上下文（笔记/记忆等）。
    messages.push({
      role: "system",
      content: isEn
        ? "Reminder: reply to the user in English, regardless of the language of the notes or context above."
        : "提醒：始终用中文回答。"
    });

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
    const statusEl = summaryEl.createSpan({ cls: "deepsidian-tool-status", text: this.t("toolRunning") });

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
    elements.statusEl.setText(ok ? this.t("toolDone") : this.t("toolFailed"));
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
      statusEl?.setText(result.ok ? this.t("toolDone") : this.t("toolFailed"));
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
  private async renderAssistantInto(bubbleEl: HTMLElement, content: string, thinkingMs?: number) {
    await this.renderMarkdown(bubbleEl, content);

    if (thinkingMs && thinkingMs > 0) {
      const badge = bubbleEl.createDiv({ cls: "deepsidian-think-badge" });
      this.appendWhaleImg(badge, 13);
      const seconds = (thinkingMs / 1000).toFixed(1);
      badge.createSpan({
        text: this.plugin.settings.language === "en" ? `Thought ${seconds}s` : `思考 ${seconds}s`
      });
      bubbleEl.insertBefore(badge, bubbleEl.firstChild);
    }

    this.addCopyButton(bubbleEl, content);
  }

  /** 思考气泡：弹跳的小鲸鱼 + 实时计时（计时由 sendMessage 的定时器更新 .deepsidian-think-time）。 */
  private renderThinkingIndicator(el: HTMLElement, label: string) {
    el.empty();
    const wrap = el.createDiv({ cls: "deepsidian-thinking" });
    this.appendWhaleImg(wrap, 40, "deepsidian-thinking-whale");
    const textEl = wrap.createSpan({ cls: "deepsidian-thinking-text" });
    textEl.createSpan({ text: `${label} ` });
    textEl.createSpan({ cls: "deepsidian-think-time", text: "0.0s" });
  }

  /** 插入鲸鱼图；assets/whale.png 不存在时优雅回退到现有 orb 图，避免裂图。 */
  private appendWhaleImg(parent: HTMLElement, size: number, cls?: string) {
    const img = parent.createEl("img", {
      cls,
      attr: { src: this.plugin.getAssetUrl("assets/whale.png"), alt: "", width: String(size), height: String(size) }
    });
    img.addEventListener(
      "error",
      () => {
        img.src = this.plugin.getAssetUrl("assets/deepsidian-orb-512.png");
      },
      { once: true }
    );
  }

  private addCopyButton(bubbleEl: HTMLElement, content: string) {
    if (!content.trim()) {
      return;
    }

    const button = bubbleEl.createEl("button", {
      cls: "deepsidian-copy-button",
      attr: { "aria-label": this.t("copy"), title: this.t("copy") }
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
    this.sendButtonEl.setAttribute("title", isBusy ? this.t("stop") : this.t("send"));
    this.sendButtonEl.setAttribute("aria-label", isBusy ? this.t("stop") : this.t("send"));
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

    const isEn = this.plugin.settings.language === "en";
    const truncNote = isEn ? "[Selection is long; truncated.]" : "[选区过长，已截断。]";
    const clipped = selection.length > 4000 ? `${selection.slice(0, 4000)}\n\n${truncNote}` : selection;
    return isEn
      ? `Text the user has selected in the editor:\n${clipped}`
      : `用户当前在编辑器中选中的文本：\n${clipped}`;
  }

  private renderTodoPanel(markdown: string) {
    if (!this.todoPanelEl) {
      return;
    }

    this.todoPanelEl.empty();
    this.todoPanelEl.removeClass("is-hidden");
    this.todoPanelEl.createDiv({ cls: "deepsidian-todo-header", text: this.t("todoProgress") });
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

    this.persistSessionUsage();
    this.renderTokenMeta();
  }

  /** 把累计用量写进当前 session 对象，随 persistCurrentSession 一起落盘。 */
  private persistSessionUsage() {
    if (!this.currentSession) {
      return;
    }

    this.currentSession.usage = {
      promptTokens: this.sessionPromptTokens,
      completionTokens: this.sessionCompletionTokens,
      costUsd: this.sessionCostUsd,
      contextTokens: this.currentContextTokens
    };
  }

  /** 切换/打开会话时，从该会话恢复累计用量（没有则为 0）。 */
  private loadSessionUsage(session: DeepSidianSession) {
    const usage = session.usage;
    this.sessionPromptTokens = usage?.promptTokens ?? 0;
    this.sessionCompletionTokens = usage?.completionTokens ?? 0;
    this.sessionCostUsd = usage?.costUsd ?? 0;
    this.currentContextTokens = usage?.contextTokens ?? 0;
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

    const isEn = this.plugin.settings.language === "en";
    const sep = isEn ? "; " : "；";
    const L = isEn
      ? { head: "DeepSidian session working memory (compressed context, for task continuity only):", goal: "Current goal: ", files: "Related files: ", completed: "Completed: ", blockers: "Failed/blocked: ", notes: "Key conclusions: " }
      : { head: "DeepSidian 会话工作记忆（压缩上下文，只作任务延续参考）：", goal: "当前目标：", files: "相关文件：", completed: "已完成：", blockers: "失败/阻塞：", notes: "关键结论：" };

    const parts: string[] = [L.head];

    if (memory.currentGoal) {
      parts.push(`${L.goal}${memory.currentGoal}`);
    }

    if (memory.files.length) {
      parts.push(`${L.files}${memory.files.slice(-8).join(sep)}`);
    }

    if (memory.completed.length) {
      parts.push(`${L.completed}${memory.completed.slice(-8).join(sep)}`);
    }

    if (memory.blockers.length) {
      parts.push(`${L.blockers}${memory.blockers.slice(-6).join(sep)}`);
    }

    if (memory.notes.length) {
      parts.push(`${L.notes}${memory.notes.slice(-5).join(sep)}`);
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

  private async persistCurrentSession(firstUserMessage?: string, refreshList = true) {
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
      if (refreshList) {
        this.sessions = await this.plugin.listSessions();
      }
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
