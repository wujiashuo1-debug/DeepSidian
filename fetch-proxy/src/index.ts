import express from "express";
import { getCached, setCached } from "./cache";
import { fetchUrl } from "./fetcher";
import type { FetchResult } from "./types";

const PORT = 3001;
// 显式 IPv4，避免某些环境把 "localhost" 绑到 ::1，与客户端 127.0.0.1 不一致。
const HOST = "127.0.0.1";

const app = express();
app.use(express.json({ limit: "1mb" }));

// 允许任意来源（含浏览器 fetch）调用本地代理，并处理预检。
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function errorResult(message: string): FetchResult {
  return {
    ok: false,
    text: "",
    title: "",
    finalUrl: "",
    byteCount: 0,
    truncated: false,
    error: message
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/fetch", async (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown; maxBytes?: unknown };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const maxBytes = typeof body.maxBytes === "number" ? body.maxBytes : undefined;

  if (!url) {
    res.status(400).json(errorResult("url 必填，且必须为字符串。"));
    return;
  }

  const cached = getCached(url);

  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const result = await fetchUrl(url, maxBytes);
    setCached(url, result);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.json(errorResult(message));
  }
});

app.listen(PORT, HOST, () => {
  console.log(`fetch-proxy listening on http://${HOST}:${PORT}`);
});
