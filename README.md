# DeepSidian

DeepSidian is an Obsidian plugin prototype that connects a sidebar assistant to the DeepSeek API.

## Current MVP

- DeepSeek-style sidebar UI with generated DeepSidian brand artwork.
- Settings tab and in-sidebar settings panel for DeepSeek API Key, base URL, model, active-note context, write permissions, and thinking depth.
- Claudian-style chat UI: borderless assistant replies, compact right-aligned user bubbles.
- Composer controls: one-tap **model switch** (flash / pro), **thinking depth** (Low / Med / High / Max), and a live **token + estimated-cost** meter for the session.
- Sidebar chat view powered by `deepseek-v4-flash` or `deepseek-v4-pro`.
- Persistent chat sessions stored under `.deepsidian/sessions/`.
- Reusable `AgentLoop` shared by the main agent and dispatched sub-agents.
- All sidebar requests run through the Agent tool loop, so tools are always available instead of being hidden behind keyword routing.
- Tool-grounding guard for action-like requests: DeepSidian tracks required tool categories (`web` / `vault` / `write` / `image` / `bash`) and refuses to report completion when the required tool did not succeed.
- Agent tool loop with collapsible tool cards and **parallel** tool execution per turn.
- Tool execution traces are persisted with chat sessions and rendered as a per-turn execution timeline.
- Failed tool cards expose recovery actions such as retrying the tool, copying the fetch-proxy start command, or opening settings.
- Write actions show a before/after diff preview before modifying notes, the editor selection, or downloaded attachments.
- Write permissions are split into create notes, edit notes, append active note, edit current selection/cursor, and download attachments.
- Each write stores an undo snapshot, allowing the user to undo all writes from a turn.
- Session memory keeps a compact summary of current goal, completed actions, blockers, related files, and key conclusions.
- Optional V4 **thinking mode** (planning) and request **retry** on 429/5xx.
- **Interruptible** runs: the send button becomes a stop button while a request is in flight.
- Active-note **and editor-selection** context auto-injected; recent history trimmed for cost control.
- Live **TODO progress panel** that re-injects the checklist into context every turn.
- Persistent task plans stored under `.deepsidian/tasks/`.
- Vault tools:
  - `get_active_note`
  - `get_selection`
  - `list_files`
  - `read_file`
  - `search_notes`
  - `open_note`
  - `web_fetch` for safe HTTP/HTTPS page retrieval, redirects, truncation, HTML-to-text extraction, and 5-minute URL cache
  - `dispatch_agent` to run an isolated sub-task agent (`explore` / `summarize` / `general`); sub-agents cannot dispatch further (depth ≤ 1)
  - `bash` to run a shell command in the vault root — **desktop only**, off by default, blocks high-risk commands (rm -rf, sudo, mkfs, dd, fork bombs, `curl | sh`, …), and asks for per-command confirmation unless "auto-approve" is on. Not available to sub-agents.
  - `read_image` with DeepSeek vision-compatible image input and `mode = ocr | describe | auto`
  - `download_image`
  - `todo_write`
  - `write_file` gated by write permission
  - `edit_file` gated by write permission
  - `append_to_active_note` gated by write permission
  - `insert_at_cursor` gated by write permission
- Command palette entries:
  - `Open DeepSidian chat`
  - `Test DeepSeek connection`

## Web Fetch Tool

`web_fetch` now calls the standalone **fetch-proxy** backend (see [`fetch-proxy/`](fetch-proxy/)) instead of fetching inside Electron. Start the backend first (`cd fetch-proxy && npm install && npm run dev`); it listens on `http://localhost:3001`.

The tool takes:

```json
{ "url": "https://example.com", "max_bytes": 50000 }
```

It POSTs to `http://localhost:3001/api/fetch` (via Obsidian's `requestUrl`, which bypasses CORS), and returns the extracted text to the agent as:

```
[source: https://example.com/]
extracted page text
```

If the backend is not running, the tool returns a clear "start the backend" error. The backend handles the heavy lifting (cheerio extraction, redirect following, SSRF/private-network blocking, no cookies/referer, 5-minute URL cache, and streaming byte-limit enforcement). The old in-Electron implementation in `src/webFetch.ts` is no longer used.

## Development

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

For the full local check (tool registry consistency, Agent contract eval, plugin build, and fetch-proxy typecheck):

```bash
npm run check
```

GitHub Actions can also package the Obsidian plugin (`main.js`, `manifest.json`, `styles.css`) through the `Build and Release` workflow. Trigger it manually or push a `v*` tag to publish a release zip.

> The plugin loads the bundled `main.js`, not the TypeScript sources. After any change under `src/`, run `npm run build` (or keep `npm run dev` watching) to regenerate `main.js`, then reload the plugin in Obsidian.

## Roadmap / not yet implemented

- `read_image` supports `mode = ocr | describe | auto` via the DeepSeek vision (VLM) track. The **offline** OCR track from the design doc (`tesseract.js`, no API cost, works without network) is still pending — it adds a heavy WASM dependency and needs in-Obsidian bundle testing.
- There is no web search: the agent can fetch a URL you provide (`web_fetch`) but cannot discover URLs on its own. Ask with a concrete link, or rely on vault search (`search_notes`).
- Nested sub-task cards and context compression are still open.
