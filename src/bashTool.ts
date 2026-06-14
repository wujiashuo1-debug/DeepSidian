// 桌面端 shell 执行。child_process 通过 window.require 惰性获取，
// 这样移动端（无 Node）加载插件时不会出错，也不会被 esbuild 打包。

type ExecError = Error & { code?: number; killed?: boolean; signal?: string };
type ExecCallback = (error: ExecError | null, stdout: string, stderr: string) => void;
type ExecOptions = {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
  encoding?: string;
};
type ExecFn = (command: string, options: ExecOptions, callback: ExecCallback) => unknown;

function loadExec(): ExecFn | null {
  try {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;

    if (typeof req !== "function") {
      return null;
    }

    const childProcess = req("child_process") as { exec?: ExecFn };
    return typeof childProcess.exec === "function" ? childProcess.exec : null;
  } catch {
    return null;
  }
}

export function isCommandSupported(): boolean {
  return loadExec() !== null;
}

export interface BashRunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export async function runBashCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<BashRunResult> {
  const exec = loadExec();

  if (!exec) {
    throw new Error("当前环境不支持执行命令（需要 Obsidian 桌面端）。");
  }

  return new Promise<BashRunResult>((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          timedOut: Boolean(error?.killed) || error?.signal === "SIGTERM"
        });
      }
    );
  });
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // rm 同时带"递归"和"强制"标志即拦截，无论合写(-rf)还是分开(-r -f / --recursive --force)。
  { pattern: /\brm\b(?=[^\n]*(?:\s-[a-zA-Z]*r|--recursive))(?=[^\n]*(?:\s-[a-zA-Z]*f|--force))/i, reason: "递归强制删除（rm -r -f）" },
  { pattern: /\bsudo\b/i, reason: "提权执行（sudo）" },
  { pattern: /\bmkfs\b/i, reason: "格式化文件系统（mkfs）" },
  { pattern: /\bdd\b[^\n]*\bof=\s*\/dev\//i, reason: "向块设备写入（dd of=/dev/...）" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "关机 / 重启" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, reason: "fork 炸弹" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "下载脚本直接执行（curl | sh）" },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/i, reason: "覆写磁盘设备" }
];

/** 命中高危黑名单则返回原因，否则返回 null。即使用户开启 bash 也始终拦截。 */
export function findBlockedReason(command: string): string | null {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }

  return null;
}
