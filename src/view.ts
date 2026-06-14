import { App, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type DeepSidianPlugin from "../main";
import {
  DeepSeekMessage,
  DeepSeekToolCall,
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
import { AgentType, getToolsForAgentType, ToolContext, VAULT_TOOL_DEFINITIONS } from "./vaultTools";

const MAX_HISTORY_MESSAGES = 20;

const SYSTEM_PROMPT = `你是 DeepSidian，运行在 Obsidian 内的 DeepSeek 助手。
你要用中文优先回答，语气简洁、可靠、像一个熟悉用户知识库的协作伙伴。
你是工具型 Agent，不是单纯聊天框。遇到当前笔记、选中内容、库内资料、文件路径、URL、整理/改写/写入请求时，要主动调用合适工具。
可用能力包括：读取当前笔记、读取选区、列文件、搜笔记、读文件、打开笔记、抓网页、联网搜索、看图、写 TODO、创建/编辑/追加/插入笔记、派发子任务。
如果用户给图片路径或图片 URL，调用 read_image；如果用户要求保存外链图片，调用 download_image。
只有用户开启写入权限时，才可以创建、编辑、追加或插入笔记；写入前要尽量说明将做什么。
如果提供了当前笔记上下文，优先基于上下文回答；如果上下文不足，要主动调用搜索、读取或网页工具补足。

任务编排原则：
- 遇到需要多步骤、跨多个文件或先调研后整理的复杂请求，先用 todo_write 写一个有序清单，然后逐项推进，每完成一项就用 todo_write 更新状态；所有项标记为 done 之前不要结束任务。
- 当某个子问题需要翻阅大量笔记/网页、或几个子问题彼此独立时，用 dispatch_agent 派发子任务（explore 只读调研、summarize 长文摘要、general 可写执行），只取它返回的结论，保持主线干净。
- 工具失败时阅读错误信息并自我纠正后重试，不要直接放弃。

真实性与执行边界：
- 不要把计划、意图或下一步说成已经完成；只有实际调用工具并收到 ok:true，才可以说“已读取 / 已搜索 / 已抓取 / 已写入 / 已完成”。
- 需要联网搜索、抓取网页、读取库内资料、查看图片、写入文件或执行命令时，必须先调用工具；不能只凭常识或编造内容冒充工具结果。
- 如果 web_search 未配置、fetch-proxy 未启动、缺少 URL、写入权限未开启或命令执行不可用，要直接说明“尚未执行”和具体原因，并给出可行下一步。
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

export class DeepSidianView extends ItemView {
  private conversation: DeepSeekMessage[] = [];
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
  private sessionPromptTokens = 0;
  private sessionCompletionTokens = 0;
  private sessionCostUsd = 0;

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
    this.writeToggleEl.addEventListener("change", async () => {
      this.plugin.settings.enableVaultWrites = this.writeToggleEl.checked;
      await this.plugin.saveSettings();
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

    const tavilyRow = this.settingsPanelEl.createDiv({ cls: "deepsidian-setting-row" });
    tavilyRow.createEl("label", { text: "Tavily Key" });
    const tavilyInput = tavilyRow.createEl("input", {
      attr: {
        type: "password",
        placeholder: "tvly-...",
        autocomplete: "off"
      }
    });
    tavilyInput.value = this.plugin.settings.tavilyApiKey;
    tavilyInput.addEventListener("change", async () => {
      this.plugin.settings.tavilyApiKey = tavilyInput.value.trim();
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
    writeLabel.createSpan({ text: "允许写入笔记" });
    writeToggle.addEventListener("change", async () => {
      this.plugin.settings.enableVaultWrites = writeToggle.checked;
      await this.plugin.saveSettings();
    });

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
    }
    this.appendBubble("user", userText);

    const pendingEl = this.appendBubble("assistant", "正在思考...");

    try {
      // 始终带工具走 Agent 循环；不再用关键词猜测，避免模型在无工具时“用文字编造”工具调用。
      const result = await this.runAgent(userText, abort.signal, pendingEl);

      this.addUsage(result.usage);

      if (abort.signal.aborted) {
        await this.renderMarkdown(pendingEl, result.content || "已中断。");
        return;
      }

      this.conversation.push({ role: "user", content: userText });
      this.conversation.push({ role: "assistant", content: result.content });
      await this.persistCurrentSession(userText);

      await this.renderAssistantInto(pendingEl, result.content);
    } catch (error) {
      if (abort.signal.aborted) {
        pendingEl.setText("已中断。");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      pendingEl.setText(`出错了：${message}`);
      new Notice(`DeepSidian 请求失败：${message}`, 8000);
    } finally {
      this.currentAbort = null;
      this.setBusy(false);
    }
  }

  private async runAgent(userText: string, signal: AbortSignal, pendingEl: HTMLElement) {
    const config = THINKING_CONFIG[this.plugin.settings.thinkingLevel];
    const loop = new AgentLoop({
      client: this.plugin.createClient(),
      tools: VAULT_TOOL_DEFINITIONS,
      toolContext: this.buildToolContext(signal, true),
      maxSteps: this.plugin.settings.maxToolSteps,
      thinking: config.thinking,
      requireToolUse: this.shouldRequireToolUse(userText),
      requiredToolGroups: this.inferRequiredToolGroups(userText),
      reflectionRounds: config.reflectionRounds,
      signal,
      callbacks: {
        onToolStart: (toolCall, args) => this.startToolCard(toolCall, args),
        onToolFinish: (card, ok, content) => this.finishToolCard(card as ToolCardHandle, ok, content),
        onTodoUpdate: (markdown) => this.renderTodoPanel(markdown),
        onReflect: (round, total) => pendingEl.setText(`正在第 ${round}/${total} 轮自我反思…`)
      }
    });

    return loop.run(await this.buildMessages(userText));
  }

  private shouldRequireToolUse(userText: string): boolean {
    return /\bhttps?:\/\/|搜索|查找|全库|文件|笔记|当前笔记|选中|选区|打开|创建|写入|编辑|修改|追加|插入|保存|网页|链接|URL|图片|截图|图像|看图|下载|读取|导入|抓取|抓一篇|抓|爬取|联网|新闻|BBC|整理到|放到|开始整理|继续整理|开始写入|继续执行/i.test(userText);
  }

  private inferRequiredToolGroups(userText: string): RequiredToolGroup[] {
    const groups = new Set<RequiredToolGroup>();
    const asksImage = /图片|截图|图像|看图|读图|识图|OCR|下载.*图/i.test(userText);
    const asksWeb =
      /网页|抓取|抓一篇|爬取|联网|新闻|BBC|web|website|article/i.test(userText) ||
      (!asksImage && /\bhttps?:\/\/|链接|URL/i.test(userText));

    if (asksWeb) {
      groups.add("web");
    }

    if (/全库|文件|笔记|当前笔记|选中|选区|打开|读取/i.test(userText) || (!asksWeb && /搜索|查找/i.test(userText))) {
      groups.add("vault");
    }

    if (/创建|写入|编辑|修改|追加|插入|保存|整理到|放到|改写|替换|开始写入/i.test(userText)) {
      groups.add("write");
    }

    if (asksImage) {
      groups.add("image");
    }

    if (/bash|shell|终端|命令行|执行命令|运行命令/i.test(userText)) {
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
      summarizeText: (text: string, prompt: string) => this.summarizeText(text, prompt),
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

    // 只回注最近若干轮历史，控制上下文体积与成本（conversation 里只有 user/assistant，裁剪安全）。
    const recentHistory = this.conversation.slice(-MAX_HISTORY_MESSAGES);
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
    const cardEl = this.transcriptEl.createEl("details", {
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
    return { cardEl, statusEl, resultEl };
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
    this.transcriptEl.scrollTo({ top: this.transcriptEl.scrollHeight });
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

  private async summarizeText(text: string, prompt: string): Promise<string> {
    const result = await this.plugin.createClient().chat([
      {
        role: "system",
        content: "你是网页摘要助手。只依据给定的网页正文回答，用简明中文，不要编造正文之外的信息。"
      },
      {
        role: "user",
        content: `网页正文：\n${text.slice(0, 12000)}\n\n请针对以下要求作答：${prompt}`
      }
    ]);

    return result.content;
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

    const total = this.sessionPromptTokens + this.sessionCompletionTokens;
    this.tokenMetaEl.empty();
    this.tokenMetaEl.setAttribute(
      "title",
      `本会话累计：输入 ${this.sessionPromptTokens} / 输出 ${this.sessionCompletionTokens} tokens，估算 $${this.sessionCostUsd.toFixed(4)}`
    );
    setIcon(this.tokenMetaEl.createSpan({ cls: "deepsidian-pill-icon" }), "coins");
    this.tokenMetaEl.createSpan({
      text: `${this.formatTokens(total)} · $${this.sessionCostUsd.toFixed(4)}`
    });
  }

  private formatTokens(value: number): string {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }

    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}k`;
    }

    return String(value);
  }

  private resetSessionUsage() {
    this.sessionPromptTokens = 0;
    this.sessionCompletionTokens = 0;
    this.sessionCostUsd = 0;
    this.renderTokenMeta();
  }

  private async persistCurrentSession(firstUserMessage?: string) {
    if (!this.currentSession) {
      return;
    }

    if (firstUserMessage && this.currentSession.title === "New Chat") {
      this.currentSession.title = firstUserMessage.trim().replace(/\s+/g, " ").slice(0, 32) || "New Chat";
    }

    this.currentSession.messages = [...this.conversation];

    if (this.currentSession.messages.length) {
      await this.plugin.saveSession(this.currentSession);
      this.sessions = await this.plugin.listSessions();
    }
  }
}
