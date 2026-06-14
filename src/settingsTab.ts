import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DeepSidianPlugin from "../main";
import { THINKING_LEVEL_LABELS, THINKING_LEVELS, ThinkingLevel } from "./types";

export class DeepSidianSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DeepSidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.addClass("deepsidian-settings");

    containerEl.createEl("h2", { text: "DeepSidian" });
    containerEl.createEl("p", {
      text: "配置 DeepSeek API 后，DeepSidian 就可以在侧边栏里对话，并自动带上当前笔记上下文。"
    });

    new Setting(containerEl)
      .setName("DeepSeek API Key")
      .setDesc("保存到当前 Obsidian 库的插件数据中。")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("默认使用 DeepSeek 官方 OpenAI 兼容接口。")
      .addText((text) => {
        text
          .setPlaceholder("https://api.deepseek.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim() || "https://api.deepseek.com";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("日常对话建议 flash；复杂规划和 Agent 后续可切到 pro。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("deepseek-v4-flash", "deepseek-v4-flash")
          .addOption("deepseek-v4-pro", "deepseek-v4-pro")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tavily API Key")
      .setDesc("可选。填写后启用 web_search 联网搜索工具。")
      .addText((text) => {
        text
          .setPlaceholder("tvly-...")
          .setValue(this.plugin.settings.tavilyApiKey)
          .onChange(async (value) => {
            this.plugin.settings.tavilyApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
      });

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("越低越稳定，越高越发散。")
      .addSlider((slider) => {
        slider
          .setLimits(0, 1.5, 0.1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.temperature)
          .onChange(async (value) => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("自动加入当前笔记")
      .setDesc("发送消息时，把当前打开笔记的路径和内容作为上下文。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("当前笔记上下文字数")
      .setDesc("避免一次发送过多内容。")
      .addText((text) => {
        text
          .setPlaceholder("12000")
          .setValue(String(this.plugin.settings.maxContextCharacters))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxContextCharacters = Number.isFinite(parsed) && parsed > 0
              ? parsed
              : 12000;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大工具轮数")
      .setDesc("Agent 最多连续调用多少轮工具，避免陷入循环。")
      .addText((text) => {
        text
          .setPlaceholder("8")
          .setValue(String(this.plugin.settings.maxToolSteps))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxToolSteps = Number.isFinite(parsed) && parsed > 0
              ? Math.min(parsed, 30)
              : 8;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("允许 AI 写入笔记")
      .setDesc("写入总开关。开启后仍需分别允许具体写入类型。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableVaultWrites)
          .onChange(async (value) => {
            this.plugin.settings.enableVaultWrites = value;
            await this.plugin.saveSettings();
          });
      });

    this.addWritePermissionToggle(containerEl, "createNotes", "允许创建新笔记");
    this.addWritePermissionToggle(containerEl, "editNotes", "允许编辑已有笔记");
    this.addWritePermissionToggle(containerEl, "appendActiveNote", "允许追加到当前笔记");
    this.addWritePermissionToggle(containerEl, "insertAtCursor", "允许修改当前选区/光标");
    this.addWritePermissionToggle(containerEl, "downloadAttachments", "允许下载附件");

    new Setting(containerEl)
      .setName("思考深度")
      .setDesc("Low=不思考(最快最省)；Med/High/Max 开启 thinking，并在给出答案后分别再做 1/2/3 轮自我反思改进，越高越深越慢越贵。")
      .addDropdown((dropdown) => {
        for (const level of THINKING_LEVELS) {
          dropdown.addOption(level, THINKING_LEVEL_LABELS[level]);
        }

        dropdown
          .setValue(this.plugin.settings.thinkingLevel)
          .onChange(async (value) => {
            this.plugin.settings.thinkingLevel = value as ThinkingLevel;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("命令执行（bash）")
      .setDesc("仅桌面端。开启后 AI 可在库根目录执行 shell 命令；高危命令始终被拦截。默认关闭。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableBash)
          .onChange(async (value) => {
            this.plugin.settings.enableBash = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("自动批准命令")
      .setDesc("开启后命令直接执行、不再逐条弹窗确认（YOLO，谨慎使用）。关闭时每条命令都要你点确认。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.bashAutoApprove)
          .onChange(async (value) => {
            this.plugin.settings.bashAutoApprove = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("连接测试")
      .setDesc("用当前配置向 DeepSeek 发送一条很短的测试消息。")
      .addButton((button) => {
        button
          .setButtonText("测试连接")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("测试中...");

            try {
              await this.plugin.testConnection();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            } finally {
              button.setDisabled(false);
              button.setButtonText("测试连接");
            }
          });
      });
  }

  private addWritePermissionToggle(
    containerEl: HTMLElement,
    key: keyof typeof this.plugin.settings.writePermissions,
    label: string
  ) {
    new Setting(containerEl)
      .setName(label)
      .setDesc("仅在“允许 AI 写入笔记”总开关开启时生效。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.writePermissions[key])
          .onChange(async (value) => {
            this.plugin.settings.writePermissions[key] = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
