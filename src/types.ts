export const VIEW_TYPE_DEEPSIDIAN = "deepsidian-chat-view";

export type Lang = "zh" | "en";

export type ThinkingLevel = "low" | "med" | "high" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = ["low", "med", "high", "max"];

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: "Low",
  med: "Med",
  high: "High",
  max: "Max"
};

export type EffortLevel = "direct" | "reason" | "thorough" | "max";

/**
 * 思考深度 = 给出答案“之前”想得多深、查得多全（原生思考链 + 取证强度 + 工具预算），
 * 不再做答案出炉后的“自我反思/重写”——那只是反刍，会覆盖好的回复，对质量没帮助。
 * - thinking：开启 V4 原生思考链（出答案前先推理）。
 * - effort：注入给模型的“思考/取证”力度提示。
 * - stepBoost：额外放宽的工具步数，让高等级能多取证、多调研。
 */
export const THINKING_CONFIG: Record<ThinkingLevel, { thinking: boolean; effort: EffortLevel; stepBoost: number }> = {
  low: { thinking: false, effort: "direct", stepBoost: 0 },
  med: { thinking: true, effort: "reason", stepBoost: 0 },
  high: { thinking: true, effort: "thorough", stepBoost: 4 },
  max: { thinking: true, effort: "max", stepBoost: 12 }
};

export function thinkingEnabled(level: ThinkingLevel): boolean {
  return THINKING_CONFIG[level].thinking;
}

export const MODEL_OPTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

/** 单位：美元 / 100 万 token（2026-06 联网核实）。pro 为官方永久 75% 折后实际价。 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87 }
};

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface DeepSidianSettings {
  language: Lang;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  includeActiveNote: boolean;
  maxContextCharacters: number;
  maxToolSteps: number;
  enableVaultWrites: boolean;
  writePermissions: DeepSidianWritePermissions;
  thinkingLevel: ThinkingLevel;
  enableBash: boolean;
  bashAutoApprove: boolean;
}

export interface DeepSidianWritePermissions {
  createNotes: boolean;
  editNotes: boolean;
  appendActiveNote: boolean;
  insertAtCursor: boolean;
  downloadAttachments: boolean;
}

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
  /** DeepSidian 会话内的用户回合 ID；不会发送给模型，只用于 UI 与工具轨迹关联。 */
  turnId?: string;
}

export interface DeepSeekToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekChatResult {
  content: string;
  message?: DeepSeekMessage;
  toolCalls?: DeepSeekToolCall[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface DeepSidianSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: DeepSeekMessage[];
  toolRuns?: DeepSidianToolRun[];
  undoSnapshots?: DeepSidianUndoSnapshot[];
  memory?: DeepSidianSessionMemory;
  /** 滚动压缩摘要：覆盖 conversation 前 summarizedCount 条消息的中文要点。 */
  summary?: string;
  summarizedCount?: number;
  /** 随会话持久化的累计用量与费用，切会话/重开插件都跟着会话走，不再丢失。 */
  usage?: DeepSidianSessionUsage;
}

export interface DeepSidianSessionUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  contextTokens: number;
}

export interface DeepSidianToolRun {
  id: string;
  turnId: string;
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean | null;
  content: string;
  startedAt: number;
  finishedAt?: number;
}

export interface DeepSidianUndoSnapshot {
  id: string;
  turnId: string;
  action: string;
  target: string;
  path: string;
  beforeContent: string | null;
  afterContent: string;
  createdAt: number;
  undoneAt?: number;
}

export interface DeepSidianSessionMemory {
  updatedAt: number;
  currentGoal?: string;
  completed: string[];
  blockers: string[];
  files: string[];
  notes: string[];
}

export const DEFAULT_SETTINGS: DeepSidianSettings = {
  language: "zh",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0.2,
  includeActiveNote: true,
  maxContextCharacters: 12000,
  maxToolSteps: 8,
  enableVaultWrites: false,
  writePermissions: {
    createNotes: false,
    editNotes: false,
    appendActiveNote: false,
    insertAtCursor: false,
    downloadAttachments: false
  },
  thinkingLevel: "low",
  enableBash: false,
  bashAutoApprove: false
};
