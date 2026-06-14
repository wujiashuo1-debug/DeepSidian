# fetch-proxy

一个极简的后端代理抓取服务（Node.js + Express + TypeScript）。给一个 URL，返回清洗后的正文文本。可作为 DeepSidian / 其他客户端的 `web_fetch` 后端，绕过浏览器 / Electron 的 CORS 限制。

## 运行

需要 Node.js 18+（用到全局 `fetch`）。

```bash
cd fetch-proxy
npm install
npm run dev      # tsx watch，改动自动重启
# 或
npm start        # tsx 直接跑，不需要 build
```

启动后监听 `http://localhost:3001`。

## API

### `POST /api/fetch`

请求体：

```json
{ "url": "https://example.com", "maxBytes": 100000 }
```

- `url`（必填）：要抓取的 http/https 地址。
- `maxBytes`（可选）：响应正文最大字节数，默认 `100000`，上限 `5000000`。

响应：

```json
{
  "ok": true,
  "text": "提取出的正文纯文本",
  "title": "页面标题",
  "finalUrl": "https://example.com/",
  "byteCount": 12345,
  "truncated": false
}
```

出错时 `ok: false` 且带 `error` 字段。

示例：

```bash
curl -s http://localhost:3001/api/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

健康检查：`GET /health` → `{ "ok": true }`。

## 行为

- **User-Agent**：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`。
- **重定向**：手动跟随（最多 5 跳），每一跳都做内网校验。
- **HTML 提取**（cheerio）：移除 `script/style/noscript/svg/nav/footer/header`，取 `<title>`，块级元素后换行、内联取文本，合并多余空白。
- **非 HTML**：直接返回原文前 `maxBytes`。
- **缓存**：内存 `Map`，key = url，TTL 5 分钟，命中直接返回。

## 安全

- 仅允许 `http` / `https`，拒绝 `file://` 等其它协议。
- 拒绝内网 / 本地地址：`localhost`、`127.0.0.1`、`10.x`、`172.16–31.x`、`192.168.x`、链路本地等；域名会先 DNS 解析再逐一校验解析到的 IP（含重定向每一跳），防止 SSRF。
- 连接超时 15 秒。
- 不携带 cookie，不发送 Referer。

> 注意：DNS 解析校验与实际连接之间存在极小的 TOCTOU 窗口（DNS 重绑定）。作为本机开发代理足够；若要对外暴露，建议再加固（如固定解析后的 IP 直连）。
