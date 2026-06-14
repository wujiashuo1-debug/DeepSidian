import { extractFromHtml } from "./extract";
import { assertSafeHost, parseAndValidateUrl } from "./security";
import type { FetchResult } from "./types";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const DEFAULT_MAX_BYTES = 100_000;
const HARD_MAX_BYTES = 5_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export async function fetchUrl(rawUrl: string, maxBytes?: number): Promise<FetchResult> {
  const limit = clampMaxBytes(maxBytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let current = parseAndValidateUrl(rawUrl);
    let response: Response | undefined;

    // 手动跟随重定向，对每一跳都做内网校验，防止重定向到内网。
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertSafeHost(current);

      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        // 不携带 cookie、不发送 Referer。
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });

      const location = res.headers.get("location");

      if (res.status >= 300 && res.status < 400 && location) {
        // 丢弃重定向响应体，释放连接。
        await res.arrayBuffer().catch(() => undefined);
        current = parseAndValidateUrl(new URL(location, current).toString());
        continue;
      }

      response = res;
      break;
    }

    if (!response) {
      throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）。`);
    }

    const finalUrl = current.toString();
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const { buffer, byteCount, truncated } = await readBodyWithLimit(response, limit);
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");

    if (!isHtml) {
      // 非 HTML：直接返回原文前 maxBytes。
      return {
        ok: true,
        text: buffer.toString("utf8"),
        title: "",
        finalUrl,
        byteCount,
        truncated
      };
    }

    const { title, text } = extractFromHtml(buffer.toString("utf8"));

    return {
      ok: true,
      text,
      title,
      finalUrl,
      byteCount,
      truncated
    };
  } catch (error) {
    // 中断错误可能是 DOMException（不一定 instanceof Error），按 name 判断更稳。
    const name = (error as { name?: unknown } | null)?.name;

    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error(`请求超时（${TIMEOUT_MS}ms）。`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function clampMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_BYTES;
  }

  return Math.min(Math.floor(value), HARD_MAX_BYTES);
}

async function readBodyWithLimit(
  response: Response,
  limit: number
): Promise<{ buffer: Buffer; byteCount: number; truncated: boolean }> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer: buffer.subarray(0, limit),
      byteCount: buffer.length,
      truncated: buffer.length > limit
    };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let storedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      byteCount += value.byteLength;

      if (storedBytes < limit) {
        const remaining = limit - storedBytes;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(Buffer.from(chunk));
        storedBytes += chunk.byteLength;
      }

      if (byteCount > limit) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    buffer: Buffer.concat(chunks, storedBytes),
    byteCount,
    truncated
  };
}
