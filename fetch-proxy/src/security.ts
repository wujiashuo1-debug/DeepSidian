import { lookup } from "node:dns/promises";
import net from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 解析 URL 并校验协议（仅允许 http/https，拒绝 file:// 等）。 */
export function parseAndValidateUrl(raw: string): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无效的 URL：${raw}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`不支持的协议：${url.protocol}（仅允许 http/https）。`);
  }

  return url;
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }

  const [a, b] = parts;

  if (a === 0 || a === 127) return true; // 本机 / 0.0.0.0
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 链路本地

  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower === "::1" || lower === "::") return true; // 回环 / 未指定
  if (lower.startsWith("fe80")) return true; // 链路本地
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // 唯一本地地址

  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/); // IPv4 映射地址

  if (mapped) {
    return isPrivateIPv4(mapped[1]);
  }

  return false;
}

/** 判断一个字面量主机（IP）是否为内网地址。非 IP 字面量返回 false。 */
export function isPrivateAddress(host: string): boolean {
  const cleaned = host.replace(/^\[|\]$/g, "");

  if (net.isIPv4(cleaned)) return isPrivateIPv4(cleaned);
  if (net.isIPv6(cleaned)) return isPrivateIPv6(cleaned);

  return false;
}

/**
 * 拒绝内网 / 本地地址：既检查字面量 IP，也对域名做 DNS 解析后逐一校验，
 * 避免域名指向内网（含重定向时的每一跳）。
 */
export async function assertSafeHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lower = host.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error("拒绝访问本地地址（localhost）。");
  }

  if (isPrivateAddress(host)) {
    throw new Error(`拒绝访问内网地址：${host}`);
  }

  // 非字面量 IP（域名）才需要解析。
  if (net.isIP(host) === 0) {
    let records;

    try {
      records = await lookup(host, { all: true });
    } catch {
      throw new Error(`无法解析主机：${host}`);
    }

    for (const record of records) {
      const isPrivate = record.family === 4 ? isPrivateIPv4(record.address) : isPrivateIPv6(record.address);

      if (isPrivate) {
        throw new Error(`拒绝访问解析到内网的地址：${host} -> ${record.address}`);
      }
    }
  }
}
