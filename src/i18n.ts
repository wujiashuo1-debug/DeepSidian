import { Lang } from "./types";

// 中文为字符串来源(source of truth)；英文必须覆盖同一组 key（类型会强制）。
const ZH = {
  // 设置页
  settingsIntro: "配置 DeepSeek API 后，DeepSidian 就可以在侧边栏里对话，并自动带上当前笔记上下文。",
  language: "界面语言 / Language",
  languageDesc: "切换插件界面与回复语言（更改后重新打开侧栏生效）。",
  apiKeyDesc: "保存到当前 Obsidian 库的插件数据中。",
  baseUrl: "Base URL",
  baseUrlDesc: "默认使用 DeepSeek 官方 OpenAI 兼容接口。",
  model: "模型",
  modelDesc: "日常对话建议 flash；复杂规划和 Agent 后续可切到 pro。",
  temperature: "Temperature",
  temperatureDesc: "越低越稳定，越高越发散。",
  includeNote: "自动加入当前笔记",
  includeNoteDesc: "发送消息时，把当前打开笔记的路径和内容作为上下文。",
  maxContext: "当前笔记上下文字数",
  maxContextDesc: "避免一次发送过多内容。",
  maxSteps: "最大工具轮数",
  maxStepsDesc: "Agent 最多连续调用多少轮工具，避免陷入循环。",
  allowWrite: "允许 AI 写入笔记（总开关）",
  allowWriteDesc: "总开关。开启后再按下面的细项授权具体写入动作。",
  permCreate: "允许创建新笔记",
  permEdit: "允许编辑已有笔记",
  permAppend: "允许追加到当前笔记",
  permInsert: "允许修改当前选区/光标",
  permDownload: "允许下载附件",
  permDependsOn: "仅在“允许 AI 写入笔记”总开关开启时生效。",
  thinkingDepth: "思考深度",
  thinkingDepthDesc: "Low=不思考(最快最省)；Med/High/Max 开启思考，并在给出答案后分别再做 1/2/3 轮自我反思改进。",
  bash: "命令执行（bash）",
  bashDesc: "仅桌面端。开启后 AI 可在库根目录执行 shell 命令；高危命令始终被拦截。默认关闭。",
  bashAuto: "自动批准命令",
  bashAutoDesc: "开启后命令直接执行、不再逐条弹窗确认（YOLO，谨慎使用）。",
  testConn: "连接测试",
  testConnDesc: "用当前配置向 DeepSeek 发送一条很短的测试消息。",
  testBtn: "测试连接",
  testing: "测试中...",

  // 侧栏内联设置面板（短标签）
  inlineModel: "模型",
  inlineIncludeNote: "自动带上当前笔记",
  inlineAllowWrite: "允许写入笔记（总开关）",
  permShortCreate: "新建",
  permShortEdit: "编辑",
  permShortAppend: "追加",
  permShortInsert: "选区",
  permShortDownload: "附件",

  // 聊天界面
  inputPlaceholder: "有什么可以帮你的？",
  write: "写入",
  command: "命令",
  send: "发送",
  stop: "停止",
  pickModel: "选择模型",
  pickThinking: "选择思考深度",
  modelHintFlash: "便宜快，日常首选",
  modelHintPro: "更强，复杂任务",
  thinkHintOff: "不思考，最快",
  emptyTitle: "在忙些什么？",
  emptySubtitle: "读笔记、搜库、改写选区、抓网页，或者让 DeepSidian 直接整理当前文件。",
  thinking: "思考中",
  copy: "复制",
  todoProgress: "任务进度",
  newChat: "新建对话",
  history: "历史对话",
  toolRunning: "运行中",
  toolDone: "完成",
  toolFailed: "失败",

  // 提示
  needApiKey: "请先点击侧边栏右上角设置，填写 DeepSeek API Key。",
  requestFailed: "DeepSidian 请求失败：",
  interrupted: "已中断。",
  sessionNotFound: "没有找到这个会话。",

  // 注入给模型的回复语言指令
  replyDirective: "始终用中文回答。"
} as const;

export type TKey = keyof typeof ZH;

const EN: Record<TKey, string> = {
  settingsIntro: "Set your DeepSeek API key and DeepSidian can chat in the sidebar with your current note as context.",
  language: "界面语言 / Language",
  languageDesc: "Switch the plugin's interface and reply language (reopen the sidebar to apply).",
  apiKeyDesc: "Stored in this vault's plugin data.",
  baseUrl: "Base URL",
  baseUrlDesc: "Defaults to DeepSeek's official OpenAI-compatible endpoint.",
  model: "Model",
  modelDesc: "Use flash for everyday chat; switch to pro for complex planning and agent work.",
  temperature: "Temperature",
  temperatureDesc: "Lower is more stable, higher is more creative.",
  includeNote: "Include current note",
  includeNoteDesc: "Send the open note's path and content as context with each message.",
  maxContext: "Current-note context size",
  maxContextDesc: "Avoid sending too much content at once.",
  maxSteps: "Max tool steps",
  maxStepsDesc: "How many tool rounds the agent may chain, to avoid loops.",
  allowWrite: "Allow AI to write notes (master)",
  allowWriteDesc: "Master switch. Turn it on, then grant the specific write actions below.",
  permCreate: "Allow creating new notes",
  permEdit: "Allow editing existing notes",
  permAppend: "Allow appending to the current note",
  permInsert: "Allow editing the current selection/cursor",
  permDownload: "Allow downloading attachments",
  permDependsOn: "Only applies while the master \"Allow AI to write notes\" switch is on.",
  thinkingDepth: "Thinking depth",
  thinkingDepthDesc: "Low = no thinking (fastest/cheapest). Med/High/Max enable thinking plus 1/2/3 self-reflection passes.",
  bash: "Command execution (bash)",
  bashDesc: "Desktop only. Lets the AI run shell commands in the vault root; high-risk commands are always blocked. Off by default.",
  bashAuto: "Auto-approve commands",
  bashAutoDesc: "Run commands directly without a per-command confirmation (YOLO; use with care).",
  testConn: "Connection test",
  testConnDesc: "Send a tiny test message to DeepSeek with the current settings.",
  testBtn: "Test connection",
  testing: "Testing…",

  inlineModel: "Model",
  inlineIncludeNote: "Include current note",
  inlineAllowWrite: "Allow writes (master)",
  permShortCreate: "New",
  permShortEdit: "Edit",
  permShortAppend: "Append",
  permShortInsert: "Sel.",
  permShortDownload: "Files",

  inputPlaceholder: "How can I help you today?",
  write: "Write",
  command: "Cmd",
  send: "Send",
  stop: "Stop",
  pickModel: "Choose model",
  pickThinking: "Choose thinking depth",
  modelHintFlash: "cheap & fast, default",
  modelHintPro: "stronger, complex tasks",
  thinkHintOff: "no thinking, fastest",
  emptyTitle: "How's it going?",
  emptySubtitle: "Read notes, search the vault, rewrite a selection, fetch a page, or let DeepSidian tidy the current file.",
  thinking: "Thinking",
  copy: "Copy",
  todoProgress: "Task progress",
  newChat: "New chat",
  history: "Chat history",
  toolRunning: "running",
  toolDone: "done",
  toolFailed: "failed",

  needApiKey: "Open settings (top-right of the sidebar) and enter your DeepSeek API key first.",
  requestFailed: "DeepSidian request failed: ",
  interrupted: "Stopped.",
  sessionNotFound: "Conversation not found.",

  replyDirective: "Always respond in English."
};

const TABLE: Record<Lang, Record<TKey, string>> = { zh: ZH, en: EN };

export type Translator = (key: TKey) => string;

export function createTranslator(lang: Lang): Translator {
  const dict = TABLE[lang] ?? ZH;
  return (key: TKey) => dict[key] ?? ZH[key];
}
