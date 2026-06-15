import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DeepSidianPlugin from "../main";
import { Lang, THINKING_LEVEL_LABELS, THINKING_LEVELS, ThinkingLevel } from "./types";
import { createTranslator, Translator } from "./i18n";

export class DeepSidianSettingTab extends PluginSettingTab {
  private t!: Translator;

  constructor(app: App, private plugin: DeepSidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    this.t = createTranslator(this.plugin.settings.language);
    const t = this.t;

    containerEl.empty();
    containerEl.addClass("deepsidian-settings");

    containerEl.createEl("h2", { text: "DeepSidian" });
    containerEl.createEl("p", { text: t("settingsIntro") });

    new Setting(containerEl)
      .setName(t("language"))
      .setDesc(t("languageDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("zh", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as Lang;
            await this.plugin.saveSettings();
            this.display();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("DeepSeek API Key")
      .setDesc(t("apiKeyDesc"))
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
      .setName(t("baseUrl"))
      .setDesc(t("baseUrlDesc"))
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
      .setName(t("model"))
      .setDesc(t("modelDesc"))
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
      .setName(t("temperature"))
      .setDesc(t("temperatureDesc"))
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
      .setName(t("includeNote"))
      .setDesc(t("includeNoteDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("maxContext"))
      .setDesc(t("maxContextDesc"))
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
      .setName(t("maxSteps"))
      .setDesc(t("maxStepsDesc"))
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
      .setName(t("allowWrite"))
      .setDesc(t("allowWriteDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableVaultWrites)
          .onChange(async (value) => {
            this.plugin.settings.enableVaultWrites = value;
            await this.plugin.saveSettings();
          });
      });

    this.addWritePermissionToggle(containerEl, "createNotes", t("permCreate"));
    this.addWritePermissionToggle(containerEl, "editNotes", t("permEdit"));
    this.addWritePermissionToggle(containerEl, "appendActiveNote", t("permAppend"));
    this.addWritePermissionToggle(containerEl, "insertAtCursor", t("permInsert"));
    this.addWritePermissionToggle(containerEl, "downloadAttachments", t("permDownload"));

    new Setting(containerEl)
      .setName(t("thinkingDepth"))
      .setDesc(t("thinkingDepthDesc"))
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
      .setName(t("bash"))
      .setDesc(t("bashDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableBash)
          .onChange(async (value) => {
            this.plugin.settings.enableBash = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("bashAuto"))
      .setDesc(t("bashAutoDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.bashAutoApprove)
          .onChange(async (value) => {
            this.plugin.settings.bashAutoApprove = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("testConn"))
      .setDesc(t("testConnDesc"))
      .addButton((button) => {
        button
          .setButtonText(t("testBtn"))
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText(t("testing"));

            try {
              await this.plugin.testConnection();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            } finally {
              button.setDisabled(false);
              button.setButtonText(t("testBtn"));
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
      .setDesc(this.t("permDependsOn"))
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
