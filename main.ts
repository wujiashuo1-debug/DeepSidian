import { addIcon, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DeepSeekClient } from "./src/deepseekClient";
import { DEFAULT_SETTINGS, DeepSidianSession, DeepSidianSettings, VIEW_TYPE_DEEPSIDIAN } from "./src/types";
import { DeepSidianSettingTab } from "./src/settingsTab";
import { DeepSidianView } from "./src/view";

const DEEPSIDIAN_ICON = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path fill="currentColor" d="M12 2.2c3.48 0 6.64 2 8.12 5.14.27.57.02 1.25-.55 1.52-.57.27-1.25.02-1.52-.55A6.72 6.72 0 0 0 12 4.48a6.71 6.71 0 0 0-6.72 6.72c0 1.87.76 3.57 1.98 4.79.45.45.45 1.17 0 1.61-.45.45-1.17.45-1.61 0A8.94 8.94 0 0 1 3 11.2c0-4.97 4.03-9 9-9Z"/>
  <path fill="currentColor" d="M21.57 12.16c.63.03 1.12.57 1.09 1.2A8.98 8.98 0 0 1 8.48 20.2c-.55-.31-.75-1.01-.44-1.56.31-.55 1.01-.75 1.56-.44a6.71 6.71 0 0 0 10.78-4.95c.03-.63.57-1.12 1.2-1.09Z"/>
  <path fill="currentColor" d="M12.1 7.2c2.2 0 4 1.8 4 4 0 2.37-2.16 4.47-5.83 5.77-.7.25-1.37-.42-1.12-1.12.42-1.18.58-2.12.45-2.82A4 4 0 0 1 12.1 7.2Zm0 2.28a1.72 1.72 0 0 0-1.33 2.81c.31.37.44.9.42 1.53 1.72-.8 2.63-1.7 2.63-2.62 0-.95-.77-1.72-1.72-1.72Z"/>
</svg>`;

export default class DeepSidianPlugin extends Plugin {
  settings: DeepSidianSettings = DEFAULT_SETTINGS;

  async onload() {
    addIcon("deepsidian", DEEPSIDIAN_ICON);

    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_DEEPSIDIAN,
      (leaf: WorkspaceLeaf) => new DeepSidianView(leaf, this)
    );

    this.addRibbonIcon("deepsidian", "Open DeepSidian", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-deepsidian-chat",
      name: "Open DeepSidian chat",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "test-deepseek-connection",
      name: "Test DeepSeek connection",
      callback: () => {
        void this.testConnection();
      }
    });

    this.addSettingTab(new DeepSidianSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_DEEPSIDIAN);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DEEPSIDIAN)[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({
        type: VIEW_TYPE_DEEPSIDIAN,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  createClient() {
    return new DeepSeekClient(this.settings);
  }

  createSession(firstUserMessage = ""): DeepSidianSession {
    const now = Date.now();
    const title = firstUserMessage.trim()
      ? firstUserMessage.trim().replace(/\s+/g, " ").slice(0, 32)
      : "New Chat";

    return {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  }

  async listSessions(): Promise<DeepSidianSession[]> {
    const folder = ".deepsidian/sessions";

    if (!await this.app.vault.adapter.exists(folder)) {
      return [];
    }

    const listed = await this.app.vault.adapter.list(folder);
    const sessions = await Promise.all(
      listed.files
        .filter((path) => path.endsWith(".json"))
        .map((path) => this.readSessionFile(path))
    );

    return sessions
      .filter((session): session is DeepSidianSession => Boolean(session))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveSession(session: DeepSidianSession) {
    session.updatedAt = Date.now();
    await this.ensureAdapterFolder(".deepsidian/sessions");
    await this.app.vault.adapter.write(
      `.deepsidian/sessions/${session.id}.json`,
      JSON.stringify(session, null, 2)
    );
  }

  async loadSession(id: string): Promise<DeepSidianSession | null> {
    return this.readSessionFile(`.deepsidian/sessions/${id}.json`);
  }

  private async readSessionFile(path: string): Promise<DeepSidianSession | null> {
    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as DeepSidianSession;

      if (!parsed.id || !Array.isArray(parsed.messages)) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  async saveTaskList(markdown: string): Promise<string> {
    await this.ensureAdapterFolder(".deepsidian/tasks");
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `.deepsidian/tasks/${id}.md`;
    await this.app.vault.adapter.write(path, markdown);
    return path;
  }

  getAssetUrl(path: string) {
    const pluginDir = this.manifest.dir;

    if (!pluginDir) {
      return path;
    }

    return this.app.vault.adapter.getResourcePath(`${pluginDir}/${path}`);
  }

  private async ensureAdapterFolder(path: string) {
    const parts = path.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      if (!await this.app.vault.adapter.exists(current)) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async testConnection() {
    if (!this.settings.apiKey.trim()) {
      new Notice("请先在 DeepSidian 设置里填写 DeepSeek API Key。");
      return;
    }

    const notice = new Notice("正在测试 DeepSeek 连接...", 0);

    try {
      const result = await this.createClient().chat([
        {
          role: "user",
          content: "用中文简短回复：DeepSidian 已连接。"
        }
      ]);

      notice.hide();
      new Notice(result.content.trim() || "DeepSeek 连接成功。");
    } catch (error) {
      notice.hide();
      new Notice(`DeepSeek 连接失败：${error instanceof Error ? error.message : String(error)}`, 8000);
    }
  }

  async getActiveNoteContext(): Promise<string | null> {
    if (!this.settings.includeActiveNote) {
      return null;
    }

    const file = this.app.workspace.getActiveFile();

    if (!file) {
      return null;
    }

    const content = await this.app.vault.cachedRead(file);
    const truncated = content.length > this.settings.maxContextCharacters
      ? `${content.slice(0, this.settings.maxContextCharacters)}\n\n[当前笔记过长，已截断。]`
      : content;

    return `当前 Obsidian 笔记路径：${file.path}\n\n当前笔记内容：\n${truncated}`;
  }
}
