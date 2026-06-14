import * as http from "http";
import * as https from "https";
import { lookup } from "dns/promises";
import { isIP } from "net";

const DEFAULT_MAX_BYTES = 50000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export interface WebFetchOptions {
  max_bytes?: number;
  timeout_ms?: number;
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface WebFetchResult {
  text: string;
  title: string;
  finalUrl: string;
  byteCount: number;
  truncated: boolean;
  sources: Array<{
    url: string;
    title: string;
    retrievedAt: string;
  }>;
}

interface FetchBytesResult {
  body: Uint8Array;
  byteCount: number;
  contentType: string;
  finalUrl: string;
  statusCode: number;
  truncated: boolean;
}

interface CacheEntry {
  expiresAt: number;
  result: WebFetchResult;
}

const cache = new Map<string, CacheEntry>();

export async function webFetch(url: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const maxBytes = clampInteger(options.max_bytes, DEFAULT_MAX_BYTES, 1, 5_000_000);
  const timeoutMs = clampInteger(options.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 120_000);
  const initialUrl = normalizeHttpUrl(url);
  const cacheKey = `${initialUrl.href}|${maxBytes}|${cachePolicyScope(options)}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cloneResult(cached.result);
  }

  const fetched = await fetchWithRedirects(initialUrl, {
    ...options,
    max_bytes: maxBytes,
    timeout_ms: timeoutMs
  });
  const rawText = decodeBytes(fetched.body);
  const isHtml = isHtmlContent(fetched.contentType, rawText);
  const extracted = isHtml ? extractHtmlText(rawText) : { title: "", text: rawText };
  const text = extracted.text.length < 100 ? rawText.trim() : extracted.text;
  const result: WebFetchResult = {
    text,
    title: extracted.title,
    finalUrl: fetched.finalUrl,
    byteCount: fetched.byteCount,
    truncated: fetched.truncated,
    sources: [
      {
        url: fetched.finalUrl,
        title: extracted.title,
        retrievedAt: new Date().toISOString()
      }
    ]
  };

  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    result: cloneResult(result)
  });

  return result;
}

async function fetchWithRedirects(
  initialUrl: URL,
  options: Required<Pick<WebFetchOptions, "max_bytes" | "timeout_ms">> & WebFetchOptions
): Promise<FetchBytesResult> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertSafeUrl(currentUrl, options);

    const response = await fetchOnce(currentUrl, options.max_bytes, options.timeout_ms);

    if (isRedirect(response.statusCode)) {
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("重定向次数过多");
      }

      const location = response.location;

      if (!location) {
        throw new Error(`重定向缺少 Location 头(${response.statusCode})`);
      }

      currentUrl = normalizeHttpUrl(new URL(location, currentUrl).href);
      continue;
    }

    if (response.statusCode >= 400 && response.statusCode < 500) {
      throw new Error(`请求被拒绝(${response.statusCode})`);
    }

    if (response.statusCode >= 500 && response.statusCode < 600) {
      throw new Error(`服务器错误(${response.statusCode})`);
    }

    if (response.statusCode !== 200) {
      throw new Error(`请求失败(${response.statusCode})`);
    }

    return {
      body: response.body,
      byteCount: response.byteCount,
      contentType: response.contentType,
      finalUrl: currentUrl.href,
      statusCode: response.statusCode,
      truncated: response.truncated
    };
  }

  throw new Error("重定向次数过多");
}

function fetchOnce(
  url: URL,
  maxBytes: number,
  timeoutMs: number
): Promise<{
  body: Uint8Array;
  byteCount: number;
  contentType: string;
  location: string;
  statusCode: number;
  truncated: boolean;
}> {
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(overallTimer);
      fn();
    };
    const request = client.get(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Connection": "close"
        },
        timeout: timeoutMs
      },
      (response) => {
        response.on("data", (chunk: Uint8Array) => {
          if (settled) {
            return;
          }

          const remaining = maxBytes - totalBytes;

          if (chunk.byteLength > remaining) {
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining));
              totalBytes += remaining;
            }

            truncated = true;
            finish(() => {
              response.destroy();
              resolve({
                body: concatBytes(chunks, totalBytes),
                byteCount: totalBytes,
                contentType: headerValue(response.headers["content-type"]),
                location: headerValue(response.headers.location),
                statusCode: response.statusCode ?? 0,
                truncated
              });
            });
            return;
          }

          chunks.push(chunk);
          totalBytes += chunk.byteLength;
        });

        response.on("end", () => {
          finish(() => {
            resolve({
              body: concatBytes(chunks, totalBytes),
              byteCount: totalBytes,
              contentType: headerValue(response.headers["content-type"]),
              location: headerValue(response.headers.location),
              statusCode: response.statusCode ?? 0,
              truncated
            });
          });
        });
      }
    );
    const overallTimer = setTimeout(() => {
      request.destroy(new Error("连接超时"));
    }, timeoutMs);

    request.on("timeout", () => {
      request.destroy(new Error("连接超时"));
    });

    request.on("error", (error) => {
      finish(() => {
        reject(normalizeNetworkError(error));
      });
    });
  });
}

async function assertSafeUrl(url: URL, options: WebFetchOptions) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许 HTTP/HTTPS URL");
  }

  const hostname = url.hostname.toLowerCase();

  if (options.allowedHosts?.length && !options.allowedHosts.some((host) => host.toLowerCase() === hostname)) {
    throw new Error(`域名不在白名单：${hostname}`);
  }

  if (options.blockedHosts?.some((host) => host.toLowerCase() === hostname)) {
    throw new Error(`域名在黑名单中：${hostname}`);
  }

  if (isBlockedHostname(hostname)) {
    throw new Error(`拒绝访问内网地址：${hostname}`);
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`拒绝访问内网地址：${hostname}`);
    }

    return;
  }

  let records: Array<{ address: string }>;

  try {
    records = await withTimeout(lookup(hostname, { all: true }), options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof Error && error.message === "连接超时") {
      throw error;
    }

    throw new Error("无法解析域名");
  }

  if (!records.length) {
    throw new Error("无法解析域名");
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error(`拒绝访问内网地址：${record.address}`);
    }
  }
}

function extractHtmlText(html: string): { title: string; text: string } {
  if (typeof DOMParser !== "undefined") {
    return extractWithDomParser(html);
  }

  return extractWithRegex(html);
}

function extractWithDomParser(html: string): { title: string; text: string } {
  const document = new DOMParser().parseFromString(html, "text/html");

  document.querySelectorAll("script,style,noscript,svg,nav,footer,header").forEach((element) => {
    element.remove();
  });

  const title = normalizeWhitespace(document.querySelector("title")?.textContent ?? "");
  const chunks: string[] = [];
  const blockTags = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "dl",
    "fieldset",
    "figcaption",
    "figure",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul"
  ]);
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.textContent ?? "");
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();

    if (tag === "br") {
      chunks.push("\n");
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      visit(child);
    }

    if (blockTags.has(tag)) {
      chunks.push("\n");
    }
  };

  for (const child of Array.from(document.body.childNodes)) {
    visit(child);
  }

  return {
    title,
    text: normalizeExtractedText(chunks.join(""))
  };
}

function extractWithRegex(html: string): { title: string; text: string } {
  const title = normalizeWhitespace(decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
  const text = decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6]|section|article|main|tr|table|ul|ol|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  return {
    title,
    text: normalizeExtractedText(text)
  };
}

function normalizeHttpUrl(url: string): URL {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL 无效");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只允许 HTTP/HTTPS URL");
  }

  parsed.hash = "";
  return parsed;
}

function isHtmlContent(contentType: string, text: string) {
  const normalized = contentType.toLowerCase();

  if (normalized.includes("text/html") || normalized.includes("application/xhtml+xml")) {
    return true;
  }

  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text.slice(0, 2048));
}

function isRedirect(statusCode: number) {
  return statusCode >= 300 && statusCode < 400;
}

function isBlockedHostname(hostname: string) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0";
}

function isPrivateIp(address: string) {
  if (address.startsWith("::ffff:")) {
    return isPrivateIp(address.slice(7));
  }

  if (address === "::1" || address === "::" || address.toLowerCase().startsWith("fc") || address.toLowerCase().startsWith("fd")) {
    return true;
  }

  if (/^fe[89ab]:/i.test(address)) {
    return true;
  }

  if (isIP(address) !== 4) {
    return false;
  }

  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function cachePolicyScope(options: WebFetchOptions) {
  const allowed = options.allowedHosts?.map((host) => host.toLowerCase()).sort().join(",") ?? "";
  const blocked = options.blockedHosts?.map((host) => host.toLowerCase()).sort().join(",") ?? "";

  return `allow=${allowed};block=${blocked}`;
}

function normalizeNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const code = (error as NodeJS.ErrnoException).code;

  if (error.message === "连接超时" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new Error("连接超时");
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Error("无法解析域名");
  }

  return error;
}

function decodeBytes(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function concatBytes(chunks: Uint8Array[], totalBytes: number) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function normalizeExtractedText(value: string) {
  return decodeHtml(value)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeWhitespace(value: string) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function headerValue(value: string | string[] | number | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return typeof value === "string" ? value : "";
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("连接超时")), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function cloneResult(result: WebFetchResult): WebFetchResult {
  return {
    ...result,
    sources: result.sources.map((source) => ({ ...source }))
  };
}
