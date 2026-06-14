export const VIEW_TYPE_DEEPSIDIAN = "deepsidian-chat-view";

export type ThinkingLevel = "low" | "med" | "high" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = ["low", "med", "high", "max"];

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: "Low",
  med: "Med",
  high: "High",
  max: "Max"
};

/**
 * 思考深度：除了开启 V4 thinking 模式，更高等级还让 Agent 在给出答案后做多轮“自我反思/再思考”
 * （审视上一轮答案→必要时再调用工具→输出改进版）。轮数越多越深、越慢、越贵。
 */
export const THINKING_CONFIG: Record<ThinkingLevel, { thinking: boolean; reflectionRounds: number }> = {
  low: { thinking: false, reflectionRounds: 0 },
  med: { thinking: true, reflectionRounds: 1 },
  high: { thinking: true, reflectionRounds: 2 },
  max: { thinking: true, reflectionRounds: 3 }
};

export function thinkingEnabled(level: ThinkingLevel): boolean {
  return THINKING_CONFIG[level].thinking || THINKING_CONFIG[level].reflectionRounds > 0;
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
