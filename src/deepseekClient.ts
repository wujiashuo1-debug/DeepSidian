import { requestUrl } from "obsidian";
import {
  DeepSeekChatResult,
  DeepSeekMessage,
  DeepSeekToolCall,
  DeepSeekToolDefinition,
  DeepSidianSettings
} from "./types";

interface DeepSeekApiResponse {
  choices?: Array<{
    message?: DeepSeekMessage;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
  usage?: DeepSeekChatResult["usage"];
}

export interface CompletionOptions {
  /** 开启 V4 thinking（深度思考）模式，适合规划/复杂推理。默认关闭以省钱提速。 */
  thinking?: boolean;
  /** 协作式中断信号；在发起请求前会检查，已中断则抛出 AbortError。 */
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error("已中断。");
  error.name = "AbortError";
  return error;
}

export class DeepSeekClient {
  constructor(private settings: DeepSidianSettings) {}

  async describeImage(dataUrl: string, prompt = "请详细描述这张图片，并提取其中所有可见文字。"): Promise<string> {
    const apiKey = this.settings.apiKey.trim();

    if (!apiKey) {
      throw new Error("缺少 DeepSeek API Key。");
    }

    const baseUrl = this.settings.baseUrl.trim().replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${baseUrl}/chat/completions`,
      method: "POST",
      throw: false,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              }
            ]
          }
        ],
        temperature: 0.1,
        stream: false,
        thinking: {
          type: "disabled"
        }
      })
    });

    const payload = this.parsePayload(response.json ?? response.text);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
    }

    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("图片识别返回为空。");
    }

    return content;
  }

  async streamChat(
    messages: DeepSeekMessage[],
    onDelta: (delta: string) => void,
    signal?: AbortSignal
  ): Promise<DeepSeekChatResult> {
    const apiKey = this.settings.apiKey.trim();

    if (!apiKey) {
      throw new Error("缺少 DeepSeek API Key。");
    }

    const baseUrl = this.settings.baseUrl.trim().replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages: messages.map((message) => this.serializeMessage(message)),
        temperature: this.settings.temperature,
        stream: true,
        stream_options: {
          include_usage: true
        },
        thinking: {
          type: "disabled"
        }
      })
    });

    if (!response.ok) {
      throw new Error(await response.text() || `HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("当前环境不支持流式响应。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: DeepSeekChatResult["usage"];

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed.startsWith("data:")) {
            continue;
          }

          const data = trimmed.slice(5).trim();

          if (data === "[DONE]") {
            return {
              content,
              usage
            };
          }

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                };
              }>;
              usage?: DeepSeekChatResult["usage"];
            };
            const delta = chunk.choices?.[0]?.delta?.content ?? "";

            if (chunk.usage) {
              usage = chunk.usage;
            }

            if (delta) {
              content += delta;
              onDelta(delta);
            }
          } catch {
            // Ignore malformed stream keepalive chunks.
          }
        }
      }
    } catch (error) {
      // 用户中断时返回已收集到的部分内容，而不是当成错误抛出。
      if (signal?.aborted) {
        return { content, usage };
      }

      throw error;
    }

    return {
      content,
      usage
    };
  }

  async chat(messages: DeepSeekMessage[]): Promise<DeepSeekChatResult> {
    const result = await this.createCompletion(messages);
    const content = result.message?.content;

    if (!content) {
      throw new Error("DeepSeek 返回为空。");
    }

    return {
      content,
      message: result.message,
      toolCalls: result.toolCalls,
      usage: result.usage
    };
  }

  async createCompletion(
    messages: DeepSeekMessage[],
    tools: DeepSeekToolDefinition[] = [],
    options: CompletionOptions = {}
  ): Promise<DeepSeekChatResult> {
    const apiKey = this.settings.apiKey.trim();

    if (!apiKey) {
      throw new Error("缺少 DeepSeek API Key。");
    }

    if (options.signal?.aborted) {
      throw abortError();
    }

    const baseUrl = this.settings.baseUrl.trim().replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: messages.map((message) => this.serializeMessage(message)),
      temperature: this.settings.temperature,
      stream: false,
      thinking: {
        type: options.thinking ? "enabled" : "disabled"
      }
    };

    if (tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await this.requestWithRetry(baseUrl, apiKey, body, options.signal);
    const payload = this.parsePayload(response.json ?? response.text);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
    }

    const message = payload.choices?.[0]?.message;

    if (!message) {
      throw new Error("DeepSeek 返回为空。");
    }

    return {
      content: message.content ?? "",
      message,
      toolCalls: this.normalizeToolCalls(message.tool_calls),
      usage: payload.usage
    };
  }

  private async requestWithRetry(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    attempts = 3
  ) {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) {
        throw abortError();
      }

      try {
        const response = await requestUrl({
          url: `${baseUrl}/chat/completions`,
          method: "POST",
          throw: false,
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });

        // 限流或服务端错误时重试，其它状态（含 4xx）直接交给调用方处理。
        if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
          lastError = new Error(`HTTP ${response.status}`);
          await this.delay(600 * (attempt + 1));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;

        if (attempt < attempts - 1) {
          await this.delay(600 * (attempt + 1));
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private parsePayload(payload: unknown): DeepSeekApiResponse {
    if (typeof payload === "string") {
      try {
        return JSON.parse(payload) as DeepSeekApiResponse;
      } catch {
        return {
          error: {
            message: payload
          }
        };
      }
    }

    return payload as DeepSeekApiResponse;
  }

  private serializeMessage(message: DeepSeekMessage) {
    const serialized: Record<string, unknown> = {
      role: message.role,
      content: message.content
    };

    if (message.tool_call_id) {
      serialized.tool_call_id = message.tool_call_id;
    }

    if (message.tool_calls) {
      serialized.tool_calls = message.tool_calls;
    }

    return serialized;
  }

  private normalizeToolCalls(toolCalls: DeepSeekToolCall[] | undefined) {
    return Array.isArray(toolCalls) ? toolCalls : [];
  }
}
