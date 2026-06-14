import type { FetchResult } from "./types";

interface CacheEntry {
  value: FetchResult;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 分钟
const store = new Map<string, CacheEntry>();

export function getCached(key: string): FetchResult | null {
  const entry = store.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }

  return entry.value;
}

export function setCached(key: string, value: FetchResult): void {
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}
