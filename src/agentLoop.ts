import { DeepSeekClient } from "./deepseekClient";
import { DeepSeekMessage, DeepSeekToolCall, DeepSeekToolDefinition, TokenUsage } from "./types";
import { executeVaultTool, ToolContext } from "./vaultTools";

export interface AgentCallbacks {
  /** 工具开始执行，返回一个不透明的卡片句柄交回给 onToolFinish。 */
  onToolStart?: (toolCall: DeepSeekToolCall, args: Record<string, unknown>) => unknown;
  onToolFinish?: (card: unknown, ok: boolean, content: string) => void;
  /** todo_write 更新后回调，用于渲染 UI 进度面板。 */
  onTodoUpdate?: (markdown: string) => void;
  /** 进入第 round/total 轮自我反思前回调，用于更新状态提示。 */
  onReflect?: (round: number, total: number) => void;
}

export type RequiredToolGroup = "vault" | "web" | "write" | "image" | "bash";

export interface AgentLoopOptions {
  client: DeepSeekClient;
  tools: DeepSeekToolDefinition[];
  toolContext: ToolContext;
  maxSteps: number;
  thinking?: boolean;
  /** 当前请求明显需要读取、搜索、抓取、写入或执行时，至少给模型一次纠偏机会去调用工具。 */
  requireToolUse?: boolean;
  /** 更精确的工具成功要求：例如联网任务必须至少有 web 类工具成功，写入任务必须至少有 write 类工具成功。 */
  requiredToolGroups?: RequiredToolGroup[];
  /** 给出答案后再做几轮“自我反思/再思考”，0 表示不反思。 */
  reflectionRounds?: number;
  signal?: AbortSignal;
  callbacks?: AgentCallbacks;
}

const REFLECTION_PROMPT = `请严格自我审视你上面的最终回答：是否完整覆盖了我的需求？有没有事实错误、遗漏、不准确或可以更深入/更清晰的地方？如有需要可再调用工具核实。然后直接输出改进后的【完整】回答；如果原回答确实已经足够好，就保持结论原样并简洁重述。不要解释你改了什么。`;
const REQUIRED_TOOL_RETRY_PROMPT = `这个请求涉及可验证的外部动作或库内动作，但你上一轮没有成功完成必要工具调用。请重新处理：
- 需要读取、搜索、抓取、写入、打开、编辑、下载、看图或执行命令时，必须先调用对应工具。
- 只有工具返回 ok:true 后，才能说“已读取 / 已搜索 / 已抓取 / 已写入 / 已完成”。
- 本助手没有联网搜索能力：用户只给了主题/没有具体链接时，不要假装搜索，直接说明无法联网搜索、可基于已有知识回答，并请对方提供 URL。
- 如果缺少 URL、fetch-proxy 未启动、写入未开启或其它条件不足，直接说明“尚未执行”以及原因，不要承诺“马上”、不要编造结果。`;
const NON_EVIDENCE_TOOLS = new Set(["todo_write"]);
const TOOL_GROUPS: Record<RequiredToolGroup, Set<string>> = {
  vault: new Set(["get_active_note", "get_selection", "list_files", "read_file", "search_notes", "open_note"]),
  web: new Set(["web_fetch"]),
  write: new Set(["write_file", "append_to_active_note", "insert_at_cursor", "edit_file", "download_image"]),
  image: new Set(["read_image", "download_image"]),
  bash: new Set(["bash"])
};

interface PhaseResult {
  content: string;
  aborted: boolean;
  steps: number;
}

export interface AgentRunResult {
  content: string;
  aborted: boolean;
  steps: number;
  usage: TokenUsage;
}

/**
 * 与 UI、Obsidian 解耦的工具调用循环；主 Agent 和 dispatch_agent 子任务都复用它。
 * 终止条件：模型不再发起 tool_calls，或到达 maxSteps，或收到中断信号。
 */
export class AgentLoop {
  private todoMessageIndex: number | null = null;
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(private options: AgentLoopOptions) {}

  async run(messages: DeepSeekMessage[]): Promise<AgentRunResult> {
    this.promptTokens = 0;
    this.completionTokens = 0;
    const reflectionRounds = Math.max(0, Math.min(5, this.options.reflectionRounds ?? 0));

    let phase = await this.runPhase(messages, this.options.requireToolUse === true);

    // 高思考等级：给出答案后再做若干轮自我反思，每轮把上一答案喂回让模型审视并改进。
    for (let round = 1; round <= reflectionRounds && !phase.aborted; round += 1) {
      if (this.options.signal?.aborted) {
        break;
      }

      this.options.callbacks?.onReflect?.(round, reflectionRounds);
      messages.push({ role: "assistant", content: phase.content });
      messages.push({ role: "user", content: REFLECTION_PROMPT });
      phase = await this.runPhase(messages, false);
    }

    return {
      content: phase.content,
      aborted: phase.aborted,
      steps: phase.steps,
      usage: this.makeUsage()
    };
  }

  private async runPhase(messages: DeepSeekMessage[], requireToolUse: boolean): Promise<PhaseResult> {
    const { client, tools, toolContext, signal, callbacks } = this.options;
    const maxSteps = Math.max(1, Math.min(30, this.options.maxSteps));
    let retriedMissingRequiredTool = false;
    let meaningfulToolAttempted = false;
    let meaningfulToolSucceeded = false;
    const requiredGroups = new Set(this.options.requiredToolGroups ?? []);
    const satisfiedGroups = new Set<RequiredToolGroup>();
    const failedEvidenceTools: string[] = [];

    for (let step = 0; step < maxSteps; step += 1) {
      if (signal?.aborted) {
        return { content: "已中断。", aborted: true, steps: step };
      }

      const result = await client.createCompletion(messages, tools, {
        thinking: this.options.thinking,
        signal
      });
      this.promptTokens += result.usage?.prompt_tokens ?? 0;
      this.completionTokens += result.usage?.completion_tokens ?? 0;
      const toolCalls = result.toolCalls ?? [];

      if (!toolCalls.length) {
        if (requireToolUse && tools.length && !retriedMissingRequiredTool) {
          const hasRequiredEvidence = this.hasRequiredEvidence(
            meaningfulToolAttempted,
            meaningfulToolSucceeded,
            requiredGroups,
            satisfiedGroups
          );

          if (hasRequiredEvidence) {
            return {
              content: result.content || "我没有拿到可显示的回复。",
              aborted: false,
              steps: step + 1
            };
          }

          retriedMissingRequiredTool = true;
          messages.push({
            role: "assistant",
            content: result.content || "（模型未调用工具，也没有给出可显示回复。）"
          });
          messages.push({
            role: "system",
            content: REQUIRED_TOOL_RETRY_PROMPT
          });
          continue;
        }

        if (
          requireToolUse &&
          tools.length &&
          !this.hasRequiredEvidence(meaningfulToolAttempted, meaningfulToolSucceeded, requiredGroups, satisfiedGroups)
        ) {
          return {
            content: this.makeUnfinishedToolAnswer(meaningfulToolAttempted, failedEvidenceTools, requiredGroups, satisfiedGroups),
            aborted: false,
            steps: step + 1
          };
        }

        return {
          content: result.content || "我没有拿到可显示的回复。",
          aborted: false,
          steps: step + 1
        };
      }

      messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: toolCalls
      });

      // 同一轮的多个工具并行执行；卡片先按顺序同步创建，保证 UI 顺序稳定。
      const pending = toolCalls.map((toolCall) => {
        const args = parseToolArguments(toolCall);
        const card = callbacks?.onToolStart?.(toolCall, args);
        return { toolCall, args, card };
      });

      const executed = await Promise.all(
        pending.map(async ({ toolCall, args, card }) => {
          const toolResult = await executeVaultTool(toolContext, toolCall.function.name, args);
          callbacks?.onToolFinish?.(card, toolResult.ok, toolResult.content);
          return { toolCall, toolResult };
        })
      );

      for (const { toolCall, toolResult } of executed) {
        if (!NON_EVIDENCE_TOOLS.has(toolCall.function.name)) {
          meaningfulToolAttempted = true;

          if (toolResult.ok) {
            meaningfulToolSucceeded = true;
            for (const group of this.groupsForTool(toolCall.function.name)) {
              satisfiedGroups.add(group);
            }
          } else {
            failedEvidenceTools.push(`${toolCall.function.name}: ${truncateForPrompt(toolResult.content, 1200)}`);
          }
        }

        if (toolResult.todoMarkdown) {
          this.applyTodo(messages, toolResult.todoMarkdown);
          callbacks?.onTodoUpdate?.(toolResult.todoMarkdown);
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: toolResult.ok, content: toolResult.content })
        });
      }
    }

    return {
      content: `工具调用已达到上限（${maxSteps} 轮）。我先停在这里，避免无限循环。`,
      aborted: false,
      steps: maxSteps
    };
  }

  private makeUsage(): TokenUsage {
    return {
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
      total_tokens: this.promptTokens + this.completionTokens
    };
  }

  private hasRequiredEvidence(
    meaningfulToolAttempted: boolean,
    meaningfulToolSucceeded: boolean,
    requiredGroups: Set<RequiredToolGroup>,
    satisfiedGroups: Set<RequiredToolGroup>
  ) {
    if (requiredGroups.size) {
      for (const group of requiredGroups) {
        if (!satisfiedGroups.has(group)) {
          return false;
        }
      }

      return true;
    }

    return meaningfulToolAttempted && meaningfulToolSucceeded;
  }

  private makeUnfinishedToolAnswer(
    meaningfulToolAttempted: boolean,
    failedEvidenceTools: string[],
    requiredGroups: Set<RequiredToolGroup>,
    satisfiedGroups: Set<RequiredToolGroup>
  ) {
    const missingGroups = [...requiredGroups].filter((group) => !satisfiedGroups.has(group));
    const parts = ["尚未完成：必要工具没有成功执行，所以我不能把这件事报告为已完成。"];

    if (missingGroups.length) {
      parts.push(`缺少成功结果的工具类别：${missingGroups.join(", ")}。`);
    }

    if (!meaningfulToolAttempted) {
      parts.push("本轮没有成功发起读取、搜索、抓取、写入、看图或命令执行类工具。");
    }

    if (failedEvidenceTools.length) {
      parts.push(`最近的工具失败信息：\n${failedEvidenceTools.slice(-3).join("\n")}`);
    }

    parts.push("请补齐上面的条件后再试，或把需要处理的原文/链接直接发给我。");
    return parts.join("\n\n");
  }

  private groupsForTool(toolName: string): RequiredToolGroup[] {
    return (Object.keys(TOOL_GROUPS) as RequiredToolGroup[]).filter((group) => TOOL_GROUPS[group].has(toolName));
  }

  /**
   * 把最新 TODO 作为一条 system 消息固定在主 system prompt 之后，每轮原地更新，
   * 让模型始终“看得到”还剩哪些步骤，不会提前收工。
   */
  private applyTodo(messages: DeepSeekMessage[], markdown: string) {
    const content = `当前任务 TODO（每轮自动更新，所有项标记为 done 之前不要结束任务）：\n${markdown}`;

    if (this.todoMessageIndex === null) {
      const insertAt = messages.length && messages[0].role === "system" ? 1 : 0;
      messages.splice(insertAt, 0, { role: "system", content });
      this.todoMessageIndex = insertAt;
    } else {
      messages[this.todoMessageIndex].content = content;
    }
  }
}

function truncateForPrompt(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function parseToolArguments(toolCall: DeepSeekToolCall): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {
      _parseError: "工具参数不是合法 JSON。",
      raw: toolCall.function.arguments
    };
  }
}
