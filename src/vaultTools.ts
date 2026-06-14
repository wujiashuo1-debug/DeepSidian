import { App, FileSystemAdapter, MarkdownView, normalizePath, requestUrl, TFile } from "obsidian";
import { DeepSeekToolDefinition, DeepSidianSettings } from "./types";
import { findBlockedReason, runBashCommand } from "./bashTool";

const MAX_TOOL_OUTPUT = 16000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 用 127.0.0.1 而非 localhost：macOS 上 localhost 可能解析到 ::1(IPv6)，
// 而后端只监听 127.0.0.1(IPv4)，requestUrl 走 ::1 会连接被拒。
const FETCH_PROXY_URL = "http://127.0.0.1:3001/api/fetch";

export interface ToolResult {
  ok: boolean;
  content: string;
  /** todo_write 专用：渲染好的 checklist，供 AgentLoop 每轮回注上下文与 UI 进度面板。 */
  todoMarkdown?: string;
}

export type AgentType = "explore" | "general" | "summarize";

export interface WriteConfirmationRequest {
  action: string;
  target: string;
  preview: string;
  before?: string | null;
  after?: string;
}

export interface UndoSnapshotInput {
  action: string;
  target: string;
  path: string;
  beforeContent: string | null;
  afterContent: string;
}

export interface ToolContext {
  app: App;
  settings: DeepSidianSettings;
  saveTaskList?: (markdown: string) => Promise<string>;
  describeImage?: (dataUrl: string, prompt?: string) => Promise<string>;
  /** 派发子任务 Agent；仅主 Agent 提供，子 Agent 不提供以保证深度 ≤ 1。 */
  dispatchAgent?: (task: string, agentType: AgentType) => Promise<string>;
  /** 针对长文本（如网页正文）按 prompt 出摘要，省 token。 */
  summarizeText?: (text: string, prompt: string) => Promise<string>;
  /** 写入库或编辑器前的用户确认；返回 false 表示拒绝。 */
  confirmWrite?: (request: WriteConfirmationRequest) => Promise<boolean>;
  /** 写入成功后记录撤销快照。 */
  recordUndo?: (snapshot: UndoSnapshotInput) => void;
  /** 桌面端执行 shell 命令前的用户确认；返回 false 表示拒绝。 */
  confirmCommand?: (command: string, description?: string) => Promise<boolean>;
}

export const VAULT_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_active_note",
      description: "读取当前正在 Obsidian 中打开的笔记路径和内容。适合用户问当前笔记、当前文件、这篇文章相关问题时使用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出 Obsidian 库中的文件路径。可以按文件夹前缀过滤，用来了解库结构或寻找候选笔记。",
      parameters: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "可选的文件夹路径前缀，例如 Projects 或 Notes/AI。留空则列出全库文件。"
          },
          limit: {
            type: "number",
            description: "最多返回多少个文件，默认 80，最大 200。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取库内指定文件内容，并带行号返回。路径必须是 Obsidian 库内相对路径。",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "库内相对路径，例如 Notes/example.md。"
          },
          maxCharacters: {
            type: "number",
            description: "最多返回多少字符，默认 16000。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "在 Markdown 笔记中搜索关键词，返回匹配文件、行号和片段。适合跨库查找信息。",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "要搜索的关键词或短语。"
          },
          limit: {
            type: "number",
            description: "最多返回多少条匹配，默认 20，最大 80。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_selection",
      description: "读取当前编辑器选中的文字。如果用户说“选中内容”“这段文字”，优先调用此工具。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_note",
      description: "在 Obsidian 中打开库内指定笔记。适合用户要求跳转、打开、查看某个文件时使用。",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "库内相对路径，例如 Notes/example.md。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆盖库内 Markdown 文件。只有用户在 DeepSidian 前端设置里启用写入后才会执行。",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
            description: "库内相对路径，例如 Drafts/new-note.md。"
          },
          content: {
            type: "string",
            description: "完整文件内容。"
          },
          overwrite: {
            type: "boolean",
            description: "文件存在时是否覆盖。默认 false。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "append_to_active_note",
      description: "把文字追加到当前打开的笔记末尾。只有用户启用写入后才会执行。",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "string",
            description: "要追加的 Markdown 内容。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "insert_at_cursor",
      description: "把文字插入当前编辑器光标位置，或替换当前选区。只有用户启用写入后才会执行。",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "string",
            description: "要插入或替换的 Markdown 内容。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "对库内文件做精确字符串替换。old_string 必须在文件中唯一出现。只有用户启用写入后才会执行。",
      parameters: {
        type: "object",
        required: ["path", "old_string", "new_string"],
        properties: {
          path: {
            type: "string",
            description: "库内相对路径，例如 Notes/example.md。"
          },
          old_string: {
            type: "string",
            description: "要替换的原文，必须唯一匹配。"
          },
          new_string: {
            type: "string",
            description: "替换后的新文本。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "抓取一个 URL 并返回提取后的正文文本（通过本地抓取代理 localhost:3001）。适合用户给 URL 让你阅读、总结、摘录时使用。",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "要抓取的 http 或 https URL。"
          },
          max_bytes: {
            type: "number",
            description: "响应正文最大字节数，默认 50000。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索网页候选结果。需要用户在设置中配置 Tavily API Key。适合用户没有给具体 URL、只给主题或媒体来源让你找资料时使用；通常先 web_search，再对最相关 URL 调 web_fetch。",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "搜索关键词，例如 BBC climate change latest。"
          },
          limit: {
            type: "number",
            description: "最多返回多少条结果，默认 5，最大 10。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_image",
      description: "读取库内图片或图片 URL，调用视觉模型识别图片。可用 mode 选择：ocr 只逐字提取文字、describe 只做视觉描述、auto 两者都做（默认）。适合看截图、图表、照片、外链图片或提取图中文字时使用。",
      parameters: {
        type: "object",
        required: ["source"],
        properties: {
          source: {
            type: "string",
            description: "库内图片路径或 http/https 图片 URL。"
          },
          mode: {
            type: "string",
            enum: ["ocr", "describe", "auto"],
            description: "ocr=只逐字提取文字；describe=只做视觉描述；auto=描述+提取文字（默认）。"
          },
          prompt: {
            type: "string",
            description: "可选。自定义针对图片的问题，给出后会覆盖 mode 的预设提示。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "download_image",
      description: "把外链图片下载到 Obsidian 库内 Attachments 文件夹，返回保存后的库内路径。",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "http 或 https 图片 URL。"
          },
          filename: {
            type: "string",
            description: "可选。保存文件名，例如 screenshot.png。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "为复杂任务写入或更新一个简短 TODO 清单，帮助保持进度。返回清单文本给用户查看。",
      parameters: {
        type: "object",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            description: "TODO 项数组。",
            items: {
              type: "object",
              required: ["content", "status"],
              properties: {
                content: {
                  type: "string",
                  description: "任务内容。"
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "done"],
                  description: "任务状态。"
                }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "dispatch_agent",
      description: "派发一个隔离的子任务 Agent 去独立完成一段调研/检索/整理工作，只把精炼结论返回给你，避免大量原文污染主线。适合需要跨很多笔记搜罗、或要并行处理多个相对独立子问题时使用。子任务不能再派发子任务。",
      parameters: {
        type: "object",
        required: ["task"],
        properties: {
          task: {
            type: "string",
            description: "交给子任务的完整、自包含的指令。子任务看不到当前对话历史，必须把背景和目标写清楚。"
          },
          agent_type: {
            type: "string",
            enum: ["explore", "general", "summarize"],
            description: "explore=只读检索调研(默认)；summarize=只读长文摘要；general=可读写执行的完整子任务。"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "在用户电脑上执行一条 shell 命令（仅 Obsidian 桌面端、且需用户在设置里开启“命令执行”）。工作目录为当前库根目录。适合运行脚本、调用系统命令、批量处理文件等。高危命令会被拦截，默认每条命令都要用户确认。",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "要执行的完整 shell 命令。"
          },
          description: {
            type: "string",
            description: "可选。一句话说明这条命令做什么，会显示在确认弹窗里。"
          },
          timeout_ms: {
            type: "number",
            description: "超时毫秒，默认 30000，最大 300000。"
          }
        },
        additionalProperties: false
      }
    }
  }
];

// dispatch_agent / bash 不下放给子 Agent：防无限嵌套 + 命令执行只在主线受控触发。
const SUBAGENT_FORBIDDEN_TOOLS = new Set(["dispatch_agent", "bash"]);

const READ_ONLY_TOOL_NAMES = [
  "get_active_note",
  "get_selection",
  "list_files",
  "read_file",
  "search_notes",
  "open_note",
  "web_fetch",
  "web_search",
  "read_image"
];

export const AGENT_TOOLSETS: Record<AgentType, string[]> = {
  explore: READ_ONLY_TOOL_NAMES,
  summarize: ["get_active_note", "read_file", "search_notes", "list_files"],
  general: VAULT_TOOL_DEFINITIONS.map((tool) => tool.function.name).filter(
    (name) => !SUBAGENT_FORBIDDEN_TOOLS.has(name)
  )
};

export function getToolsForAgentType(agentType: AgentType): DeepSeekToolDefinition[] {
  const names = AGENT_TOOLSETS[agentType] ?? AGENT_TOOLSETS.explore;
  const allowed = new Set(names);
  return VAULT_TOOL_DEFINITIONS.filter((tool) => allowed.has(tool.function.name));
}

export async function executeVaultTool(
  context: ToolContext,
  name: string,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = isRecord(rawArgs) ? rawArgs : {};

  try {
    switch (name) {
      case "get_active_note":
        return await getActiveNote(context);
      case "list_files":
        return listFiles(context, args);
      case "read_file":
        return await readFile(context, args);
      case "search_notes":
        return await searchNotes(context, args);
      case "get_selection":
        return getSelection(context);
      case "open_note":
        return await openNote(context, args);
      case "write_file":
        return await writeFile(context, args);
      case "append_to_active_note":
        return await appendToActiveNote(context, args);
      case "insert_at_cursor":
        return await insertAtCursor(context, args);
      case "edit_file":
        return await editFile(context, args);
      case "web_fetch":
        return await webFetch(args);
      case "web_search":
        return await webSearch(context, args);
      case "read_image":
        return await readImage(context, args);
      case "download_image":
        return await downloadImage(context, args);
      case "todo_write":
        return await todoWrite(context, args);
      case "dispatch_agent":
        return await dispatchAgentTool(context, args);
      case "bash":
        return await bashTool(context, args);
      default:
        return {
          ok: false,
          content: `未知工具：${name}`
        };
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : String(error)
    };
  }
}

function getSelection({ app }: ToolContext): ToolResult {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const selection = view?.editor.getSelection() ?? "";

  if (!selection.trim()) {
    return {
      ok: false,
      content: "当前没有选中文本。"
    };
  }

  return {
    ok: true,
    content: selection
  };
}

async function openNote({ app }: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const path = getRequiredPath(args.path);
  const file = app.vault.getAbstractFileByPath(path);

  if (!(file instanceof TFile)) {
    return {
      ok: false,
      content: `文件不存在：${path}`
    };
  }

  await app.workspace.getLeaf(false).openFile(file);

  return {
    ok: true,
    content: `已打开：${path}`
  };
}

function listFiles({ app }: ToolContext, args: Record<string, unknown>): ToolResult {
  const folder = typeof args.folder === "string" && args.folder.trim()
    ? normalizeSafePath(args.folder)
    : "";
  const limit = clampNumber(args.limit, 80, 1, 200);
  const files = app.vault
    .getFiles()
    .map((file) => file.path)
    .filter((path) => !folder || path.startsWith(`${folder}/`) || path === folder)
    .sort();

  const visible = files.slice(0, limit);
  const suffix = files.length > visible.length ? `\n...还有 ${files.length - visible.length} 个文件未显示。` : "";

  return {
    ok: true,
    content: visible.length ? `${visible.join("\n")}${suffix}` : "没有找到匹配文件。"
  };
}

async function getActiveNote({ app, settings }: ToolContext): Promise<ToolResult> {
  const file = app.workspace.getActiveFile();

  if (!file) {
    return {
      ok: false,
      content: "当前没有打开的笔记。"
    };
  }

  const content = await app.vault.cachedRead(file);

  return {
    ok: true,
    content: formatFileContent(file.path, content, settings.maxContextCharacters)
  };
}

async function readFile({ app }: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const path = getRequiredPath(args.path);
  const maxCharacters = clampNumber(args.maxCharacters, MAX_TOOL_OUTPUT, 1000, 60000);
  const file = app.vault.getAbstractFileByPath(path);

  if (!(file instanceof TFile)) {
    return {
      ok: false,
      content: `文件不存在：${path}`
    };
  }

  const content = await app.vault.cachedRead(file);

  return {
    ok: true,
    content: formatFileContent(path, content, maxCharacters)
  };
}

async function searchNotes({ app }: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";

  if (!query) {
    return {
      ok: false,
      content: "query 不能为空。"
    };
  }

  const limit = clampNumber(args.limit, 20, 1, 80);
  const needle = query.toLowerCase();
  const matches: string[] = [];
  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    if (matches.length >= limit) {
      break;
    }

    const content = await app.vault.cachedRead(file);
    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= limit) {
        break;
      }

      const line = lines[index];

      if (line.toLowerCase().includes(needle)) {
        matches.push(`${file.path}:${index + 1}: ${line.trim().slice(0, 240)}`);
      }
    }
  }

  return {
    ok: true,
    content: matches.length ? matches.join("\n") : `没有搜索到：${query}`
  };
}

async function writeFile(
  { app, settings, confirmWrite, recordUndo }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = getRequiredPath(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  const overwrite = args.overwrite === true;
  const existing = app.vault.getAbstractFileByPath(path);
  const permission = requireWritePermission(settings, existing ? "editNotes" : "createNotes");

  if (permission) {
    return permission;
  }

  if (existing && !overwrite) {
    return {
      ok: false,
      content: `文件已存在：${path}。如需覆盖，请设置 overwrite=true。`
    };
  }

  if (existing && !(existing instanceof TFile)) {
    return {
      ok: false,
      content: `路径不是文件：${path}`
    };
  }

  const beforeContent = existing instanceof TFile ? await app.vault.cachedRead(existing) : null;

  if (confirmWrite) {
    const approved = await confirmWrite({
      action: existing ? "覆盖文件" : "创建文件",
      target: path,
      preview: previewText(content),
      before: beforeContent,
      after: content
    });

    if (!approved) {
      return {
        ok: false,
        content: "用户取消写入。"
      };
    }
  }

  await ensureParentFolder(app, path);

  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
  } else {
    await app.vault.create(path, content);
  }

  recordUndo?.({
    action: existing ? "覆盖文件" : "创建文件",
    target: path,
    path,
    beforeContent,
    afterContent: content
  });

  return {
    ok: true,
    content: `${existing ? "已覆盖" : "已创建"}：${path}`
  };
}

async function appendToActiveNote(
  { app, settings, confirmWrite, recordUndo }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const permission = requireWritePermission(settings, "appendActiveNote");

  if (permission) {
    return permission;
  }

  const file = app.workspace.getActiveFile();

  if (!file) {
    return {
      ok: false,
      content: "当前没有打开的笔记。"
    };
  }

  const content = typeof args.content === "string" ? args.content : "";

  if (!content.trim()) {
    return {
      ok: false,
      content: "content 不能为空。"
    };
  }

  const current = await app.vault.cachedRead(file);
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  const afterContent = `${current}${separator}${content}`;

  if (confirmWrite) {
    const approved = await confirmWrite({
      action: "追加到当前笔记",
      target: file.path,
      preview: previewText(content),
      before: current,
      after: afterContent
    });

    if (!approved) {
      return {
        ok: false,
        content: "用户取消追加。"
      };
    }
  }

  await app.vault.modify(file, afterContent);
  recordUndo?.({
    action: "追加到当前笔记",
    target: file.path,
    path: file.path,
    beforeContent: current,
    afterContent
  });

  return {
    ok: true,
    content: `已追加到：${file.path}`
  };
}

async function insertAtCursor(
  { app, settings, confirmWrite, recordUndo }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const permission = requireWritePermission(settings, "insertAtCursor");

  if (permission) {
    return permission;
  }

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const content = typeof args.content === "string" ? args.content : "";

  if (!view) {
    return {
      ok: false,
      content: "当前没有可编辑的 Markdown 视图。"
    };
  }

  if (!content.trim()) {
    return {
      ok: false,
      content: "content 不能为空。"
    };
  }

  const beforeContent = typeof view.editor.getValue === "function" ? view.editor.getValue() : view.editor.getSelection();

  if (confirmWrite) {
    const approved = await confirmWrite({
      action: view.editor.getSelection() ? "替换当前选区" : "插入到当前光标",
      target: view.file?.path ?? "当前编辑器",
      preview: previewText(content),
      before: view.editor.getSelection() || null,
      after: content
    });

    if (!approved) {
      return {
        ok: false,
        content: "用户取消插入。"
      };
    }
  }

  view.editor.replaceSelection(content);
  const afterContent = typeof view.editor.getValue === "function" ? view.editor.getValue() : content;

  if (view.file) {
    recordUndo?.({
      action: "编辑当前编辑器",
      target: view.file.path,
      path: view.file.path,
      beforeContent,
      afterContent
    });
  }

  return {
    ok: true,
    content: "已插入到当前光标位置或替换选区。"
  };
}

async function editFile(
  { app, settings, confirmWrite, recordUndo }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const permission = requireWritePermission(settings, "editNotes");

  if (permission) {
    return permission;
  }

  const path = getRequiredPath(args.path);
  const oldString = typeof args.old_string === "string" ? args.old_string : "";
  const newString = typeof args.new_string === "string" ? args.new_string : "";

  if (!oldString) {
    return {
      ok: false,
      content: "old_string 不能为空。"
    };
  }

  const file = app.vault.getAbstractFileByPath(path);

  if (!(file instanceof TFile)) {
    return {
      ok: false,
      content: `文件不存在：${path}`
    };
  }

  const content = await app.vault.cachedRead(file);
  const first = content.indexOf(oldString);
  const last = content.lastIndexOf(oldString);

  if (first === -1) {
    return {
      ok: false,
      content: "没有找到 old_string。"
    };
  }

  if (first !== last) {
    return {
      ok: false,
      content: "old_string 出现了多次，请提供更精确的上下文。"
    };
  }

  const afterContent = content.replace(oldString, newString);

  if (confirmWrite) {
    const approved = await confirmWrite({
      action: "编辑文件",
      target: path,
      preview: `替换前：\n${previewText(oldString)}\n\n替换后：\n${previewText(newString)}`,
      before: content,
      after: afterContent
    });

    if (!approved) {
      return {
        ok: false,
        content: "用户取消编辑。"
      };
    }
  }

  await app.vault.modify(file, afterContent);
  recordUndo?.({
    action: "编辑文件",
    target: path,
    path,
    beforeContent: content,
    afterContent
  });

  return {
    ok: true,
    content: `已编辑：${path}`
  };
}

async function webFetch(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = typeof args.url === "string" ? args.url.trim() : "";

  if (!raw) {
    return {
      ok: false,
      content: "url 不能为空。"
    };
  }

  // 裸域名（如 www.hsapple.space）自动补 https://，避免后端因缺协议报错。
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const maxBytes = clampNumber(args.max_bytes, 50000, 1, 5_000_000);

  let response;

  try {
    response = await requestUrl({
      url: FETCH_PROXY_URL,
      method: "POST",
      throw: false,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url, maxBytes })
    });
  } catch (error) {
    return {
      ok: false,
      content: `无法连接抓取代理 ${FETCH_PROXY_URL}，请先启动 fetch-proxy 后端（cd fetch-proxy && npm run dev）。${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }

  const data = parseJson(response.text);

  if (data.ok !== true) {
    const message = typeof data.error === "string" && data.error ? data.error : `HTTP ${response.status}`;
    return {
      ok: false,
      content: `抓取失败：${message}`
    };
  }

  const text = typeof data.text === "string" ? data.text : "";
  const source = typeof data.finalUrl === "string" && data.finalUrl ? data.finalUrl : url;
  const byteCount = typeof data.byteCount === "number" ? data.byteCount : text.length;
  const truncatedNote = data.truncated === true ? `\n\n[正文已截断，原始约 ${byteCount} 字节]` : "";

  // 交给 LLM 的上下文格式：[source: {url}] {text}
  return {
    ok: true,
    content: `[source: ${source}]\n${text}${truncatedNote}`
  };
}

async function webSearch(
  { settings }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const apiKey = settings.tavilyApiKey.trim();
  const query = typeof args.query === "string" ? args.query.trim() : "";

  if (!apiKey) {
    return {
      ok: false,
      content: "web_search 未配置。请在 DeepSidian 设置里填写 Tavily API Key。"
    };
  }

  if (!query) {
    return {
      ok: false,
      content: "query 不能为空。"
    };
  }

  const limit = clampNumber(args.limit, 5, 1, 10);
  const response = await requestUrl({
    url: "https://api.tavily.com/search",
    method: "POST",
    throw: false,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: "basic"
    })
  });

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      content: `搜索失败：HTTP ${response.status} ${response.text ?? ""}`.trim()
    };
  }

  const payload = parseJson(response.json ?? response.text);
  const results = Array.isArray(payload.results) ? payload.results : [];
  const lines = results.slice(0, limit).map((item: unknown, index: number) => {
    if (!isRecord(item)) {
      return `${index + 1}. ${String(item)}`;
    }

    const title = typeof item.title === "string" ? item.title : "Untitled";
    const url = typeof item.url === "string" ? item.url : "";
    const content = typeof item.content === "string" ? item.content : "";

    return `${index + 1}. ${title}\n${url}\n${content.slice(0, 300)}`;
  });

  return {
    ok: true,
    content: lines.length ? lines.join("\n\n") : "没有搜索结果。"
  };
}

const READ_IMAGE_PROMPTS: Record<"ocr" | "describe" | "auto", string> = {
  ocr: "请逐字提取图片中的所有文字，尽量保留原始排版，只输出纯文本，不要添加描述、解释或翻译。如果图中没有文字，请回复“（无文字）”。",
  describe: "请详细描述这张图片的视觉内容（图表、照片、示意图、UI 截图等），说明关键元素及其关系。",
  auto: "请详细描述这张图片，并完整提取其中所有可见文字。"
};

async function readImage(
  { app, describeImage }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!describeImage) {
    return {
      ok: false,
      content: "图片识别后端未接入。"
    };
  }

  const source = typeof args.source === "string" ? args.source.trim() : "";

  if (!source) {
    return {
      ok: false,
      content: "source 不能为空。"
    };
  }

  const requestedMode = typeof args.mode === "string" ? args.mode.trim() : "";
  const mode: "ocr" | "describe" | "auto" =
    requestedMode === "ocr" || requestedMode === "describe" ? requestedMode : "auto";
  const userPrompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const prompt = userPrompt || READ_IMAGE_PROMPTS[mode];

  const image = /^https?:\/\//i.test(source)
    ? await fetchImageFromUrl(source)
    : await readVaultImage(app, source);

  const description = await describeImage(toDataUrl(image.bytes, image.mime), prompt);

  return {
    ok: true,
    content: `图片：${source}\n模式：${mode}\n类型：${image.mime}\n\n${description}`
  };
}

async function downloadImage(
  { app, settings, confirmWrite, recordUndo }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const permission = requireWritePermission(settings, "downloadAttachments");

  if (permission) {
    return permission;
  }

  const url = typeof args.url === "string" ? args.url.trim() : "";

  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      content: "url 必须是 http 或 https 图片地址。"
    };
  }

  const image = await fetchImageFromUrl(url);
  const requestedName = typeof args.filename === "string" ? args.filename.trim() : "";
  const ext = extensionForMime(image.mime) || extensionFromUrl(url) || "png";
  const fallbackName = `deepsidian-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const baseName = requestedName
    ? sanitizeFilename(requestedName) || fallbackName
    : fallbackName;
  const filename = baseName.includes(".") ? baseName : `${baseName}.${ext}`;
  const path = `Attachments/${filename}`;

  await ensureParentFolder(app, path);

  if (app.vault.getAbstractFileByPath(path)) {
    return {
      ok: false,
      content: `文件已存在：${path}`
    };
  }

  if (confirmWrite) {
    const approved = await confirmWrite({
      action: "下载图片到附件",
      target: path,
      preview: `来源：${url}\n类型：${image.mime}\n大小：${image.bytes.byteLength} bytes`
    });

    if (!approved) {
      return {
        ok: false,
        content: "用户取消下载。"
      };
    }
  }

  await app.vault.createBinary(path, image.bytes);
  recordUndo?.({
    action: "下载图片到附件",
    target: path,
    path,
    beforeContent: null,
    afterContent: `[binary ${image.mime}, ${image.bytes.byteLength} bytes]`
  });

  return {
    ok: true,
    content: `已下载：${path}`
  };
}

async function todoWrite(
  { saveTaskList }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const items = Array.isArray(args.items) ? args.items : [];

  if (!items.length) {
    return {
      ok: false,
      content: "items 不能为空。"
    };
  }

  const lines = items.map((item, index) => {
    if (!isRecord(item)) {
      return `${index + 1}. [ ] ${String(item)}`;
    }

    const status = typeof item.status === "string" ? item.status : "pending";
    const content = typeof item.content === "string" ? item.content : "";
    const mark = status === "done" ? "x" : status === "in_progress" ? "-" : " ";

    return `${index + 1}. [${mark}] ${content}`;
  });

  const markdown = lines.join("\n");

  if (!saveTaskList) {
    return {
      ok: true,
      content: markdown,
      todoMarkdown: markdown
    };
  }

  const path = await saveTaskList(`# DeepSidian Task\n\n${markdown}\n`);

  return {
    ok: true,
    content: `${markdown}\n\n已保存：${path}`,
    todoMarkdown: markdown
  };
}

async function dispatchAgentTool(
  { dispatchAgent }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!dispatchAgent) {
    return {
      ok: false,
      content: "子任务派发不可用：子 Agent 不能再派发子任务。"
    };
  }

  const task = typeof args.task === "string" ? args.task.trim() : "";

  if (!task) {
    return {
      ok: false,
      content: "task 不能为空。"
    };
  }

  const requested = typeof args.agent_type === "string" ? args.agent_type.trim() : "";
  const agentType: AgentType =
    requested === "general" || requested === "summarize" ? requested : "explore";

  const result = await dispatchAgent(task, agentType);

  return {
    ok: true,
    content: result || "子任务没有返回内容。"
  };
}

async function bashTool(
  { app, settings, confirmCommand }: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!settings.enableBash) {
    return {
      ok: false,
      content: "命令执行未启用。请在 DeepSidian 设置或底栏打开“命令”。"
    };
  }

  const adapter = app.vault.adapter;

  if (!(adapter instanceof FileSystemAdapter)) {
    return {
      ok: false,
      content: "命令执行仅支持 Obsidian 桌面端。"
    };
  }

  const command = typeof args.command === "string" ? args.command.trim() : "";

  if (!command) {
    return {
      ok: false,
      content: "command 不能为空。"
    };
  }

  const blocked = findBlockedReason(command);

  if (blocked) {
    return {
      ok: false,
      content: `命令被安全策略拦截（${blocked}）：\n${command}`
    };
  }

  const description = typeof args.description === "string" && args.description.trim()
    ? args.description.trim()
    : undefined;

  // 未开启自动批准时，每条命令都要用户在弹窗里确认。
  if (!settings.bashAutoApprove && confirmCommand) {
    const approved = await confirmCommand(command, description);

    if (!approved) {
      return {
        ok: false,
        content: "用户拒绝执行该命令。"
      };
    }
  }

  const timeoutMs = clampNumber(args.timeout_ms, 30000, 1000, 300000);
  const result = await runBashCommand(command, adapter.getBasePath(), timeoutMs);

  const parts: string[] = [`$ ${command}`];

  if (result.timedOut) {
    parts.push(`[超时 ${timeoutMs}ms，进程已被终止]`);
  }

  parts.push(`exit code: ${result.code}`);

  if (result.stdout.trim()) {
    parts.push(`stdout:\n${truncateOutput(result.stdout)}`);
  }

  if (result.stderr.trim()) {
    parts.push(`stderr:\n${truncateOutput(result.stderr)}`);
  }

  if (!result.stdout.trim() && !result.stderr.trim()) {
    parts.push("(无输出)");
  }

  return {
    ok: result.code === 0 && !result.timedOut,
    content: parts.join("\n\n")
  };
}

function truncateOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT
    ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n[输出过长，已截断。]`
    : text;
}

function previewText(text: string): string {
  const maxLength = 6000;
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}\n\n[预览过长，已截断。]`
    : text;
}

type WritePermissionKey = keyof DeepSidianSettings["writePermissions"];

const WRITE_PERMISSION_LABELS: Record<WritePermissionKey, string> = {
  createNotes: "创建新笔记",
  editNotes: "编辑已有笔记",
  appendActiveNote: "追加到当前笔记",
  insertAtCursor: "修改当前选区/光标",
  downloadAttachments: "下载附件"
};

function requireWritePermission(
  settings: DeepSidianSettings,
  permission: WritePermissionKey
): ToolResult | null {
  if (!settings.enableVaultWrites) {
    return {
      ok: false,
      content: "写入工具未启用。请在 DeepSidian 侧边栏设置中打开“写入”总开关。"
    };
  }

  if (!settings.writePermissions?.[permission]) {
    return {
      ok: false,
      content: `写入权限不足：未允许“${WRITE_PERMISSION_LABELS[permission]}”。请在 DeepSidian 设置中开启对应权限。`
    };
  }

  return null;
}

async function ensureParentFolder(app: App, path: string) {
  const segments = path.split("/");

  if (segments.length <= 1) {
    return;
  }

  let current = "";

  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment;

    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function formatFileContent(path: string, content: string, maxCharacters: number) {
  const truncated = content.length > maxCharacters
    ? `${content.slice(0, maxCharacters)}\n\n[内容过长，已截断。]`
    : content;
  const numbered = truncated
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");

  return `文件：${path}\n\n${numbered}`;
}

async function readVaultImage(app: App, rawPath: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const path = getRequiredPath(rawPath);
  const file = app.vault.getAbstractFileByPath(path);

  if (!(file instanceof TFile)) {
    throw new Error(`图片不存在：${path}`);
  }

  const mime = mimeFromPath(path);

  if (!mime.startsWith("image/")) {
    throw new Error(`不是支持的图片类型：${path}`);
  }

  return {
    bytes: await app.vault.adapter.readBinary(path),
    mime
  };
}

async function fetchImageFromUrl(url: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  assertSafeRemoteHttpUrl(url);

  const response = await requestUrl({
    url,
    method: "GET",
    throw: false,
    headers: {
      "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8"
    }
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`图片下载失败：HTTP ${response.status}`);
  }

  const declaredLength = Number.parseInt(getHeader(response.headers, "content-length") ?? "", 10);

  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大：${declaredLength} bytes，最大允许 ${MAX_IMAGE_BYTES} bytes。`);
  }

  if (response.arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大：${response.arrayBuffer.byteLength} bytes，最大允许 ${MAX_IMAGE_BYTES} bytes。`);
  }

  const mime = contentTypeMime(getHeader(response.headers, "content-type")) || mimeFromPath(url);

  if (!mime.startsWith("image/")) {
    throw new Error(`URL 返回的不是图片：${mime}`);
  }

  return {
    bytes: response.arrayBuffer,
    mime
  };
}

function toDataUrl(bytes: ArrayBuffer, mime: string) {
  return `data:${mime};base64,${arrayBufferToBase64(bytes)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function contentTypeMime(contentType: string | undefined) {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function getHeader(headers: Record<string, string> | undefined, name: string) {
  if (!headers) {
    return undefined;
  }

  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
}

function assertSafeRemoteHttpUrl(raw: string) {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无效的 URL：${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议：${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lower = host.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost") || isPrivateAddressLiteral(lower)) {
    throw new Error(`拒绝访问本地或内网地址：${host}`);
  }
}

function isPrivateAddressLiteral(host: string) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isPrivateIPv4Literal(host);
  }

  if (!host.includes(":")) {
    return false;
  }

  if (host === "::" || host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }

  const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  return mapped ? isPrivateIPv4Literal(mapped[1]) : false;
}

function isPrivateIPv4Literal(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function mimeFromPath(path: string) {
  const ext = extensionFromUrl(path);

  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

function extensionForMime(mime: string) {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return "";
  }
}

function extensionFromUrl(value: string) {
  const clean = value.split("?")[0].split("#")[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? "";
}

function sanitizeFilename(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function parseJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function getRequiredPath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("path 不能为空。");
  }

  return normalizeSafePath(value);
}

function normalizeSafePath(value: string) {
  const path = normalizePath(value.trim());

  if (!path || path === "." || path.startsWith("/") || path.includes("..") || path.startsWith(".obsidian/")) {
    throw new Error(`不允许访问该路径：${value}`);
  }

  return path;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
