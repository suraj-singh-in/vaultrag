import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultRAGPlugin from '../main';
import {
  type PluginSettings,
  toProviderSettings,
  validateSettings,
} from '../settings';
import { getChatProvider, getEmbedProvider } from '../providers/factory';
import { ProviderError } from '../providers/base';

/**
 * VaultRAG settings tab — registered with Obsidian via Plugin.addSettingTab().
 *
 * Sections:
 *   General  → chat + embed provider selection
 *   OpenAI   → API key, chat model, embed model, test buttons
 *   Anthropic→ API key, chat model, test button
 *   Ollama   → server URL, chat model, embed model, test buttons
 *   Advanced → timeout
 *
 * Settings auto-save on every field change (Obsidian convention).
 * Validation runs on each save and surfaces the first error as a Notice.
 */
export class VaultRAGSettingsTab extends PluginSettingTab {
  private plugin: VaultRAGPlugin;

  constructor(app: App, plugin: VaultRAGPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Re-renders the full settings page. Called by Obsidian when the tab is opened. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderGeneralSection(containerEl);
    this.renderOpenAISection(containerEl);
    this.renderAnthropicSection(containerEl);
    this.renderOllamaSection(containerEl);
    this.renderAdvancedSection(containerEl);
  }

  // ── Sections ────────────────────────────────────────────────────────────────

  private renderGeneralSection(el: HTMLElement): void {
    el.createEl('h2', { text: 'VaultRAG' });

    new Setting(el)
      .setName('Chat provider')
      .setDesc('AI provider used for chat completions.')
      .addDropdown((dd) =>
        dd
          .addOption('openai', 'OpenAI')
          .addOption('anthropic', 'Anthropic')
          .addOption('ollama', 'Ollama (local)')
          .setValue(this.plugin.settings.chatProvider)
          .onChange((value) =>
            this.save({ chatProvider: value as PluginSettings['chatProvider'] }),
          ),
      );

    new Setting(el)
      .setName('Embed provider')
      .setDesc('AI provider used for vector embeddings. Anthropic is not supported.')
      .addDropdown((dd) =>
        dd
          .addOption('openai', 'OpenAI')
          .addOption('ollama', 'Ollama (local)')
          .setValue(
            this.plugin.settings.embedProvider === 'anthropic'
              ? 'ollama'
              : this.plugin.settings.embedProvider,
          )
          .onChange((value) =>
            this.save({ embedProvider: value as PluginSettings['embedProvider'] }),
          ),
      );
  }

  private renderOpenAISection(el: HTMLElement): void {
    el.createEl('h3', { text: 'OpenAI' });

    new Setting(el)
      .setName('API key')
      .setDesc('Stored in data.json — exclude this plugin folder from vault sync.')
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange((value) => this.save({ openaiApiKey: value })),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Test chat')
          .onClick(() => void this.testChatConnection('openai')),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Test embed')
          .onClick(() => void this.testEmbedConnection('openai')),
      );

    new Setting(el)
      .setName('Chat model')
      .addText((text) =>
        text
          .setPlaceholder('gpt-4o')
          .setValue(this.plugin.settings.openaiChatModel)
          .onChange((value) => this.save({ openaiChatModel: value })),
      );

    new Setting(el)
      .setName('Embed model')
      .addText((text) =>
        text
          .setPlaceholder('text-embedding-3-small')
          .setValue(this.plugin.settings.openaiEmbedModel)
          .onChange((value) => this.save({ openaiEmbedModel: value })),
      );
  }

  private renderAnthropicSection(el: HTMLElement): void {
    el.createEl('h3', { text: 'Anthropic' });

    new Setting(el)
      .setName('API key')
      .setDesc('Stored in data.json — exclude this plugin folder from vault sync.')
      .addText((text) =>
        text
          .setPlaceholder('sk-ant-...')
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange((value) => this.save({ anthropicApiKey: value })),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Test chat')
          .onClick(() => void this.testChatConnection('anthropic')),
      );

    new Setting(el)
      .setName('Chat model')
      .addText((text) =>
        text
          .setPlaceholder('claude-sonnet-4-6')
          .setValue(this.plugin.settings.anthropicChatModel)
          .onChange((value) => this.save({ anthropicChatModel: value })),
      );
  }

  private renderOllamaSection(el: HTMLElement): void {
    el.createEl('h3', { text: 'Ollama (local)' });

    new Setting(el)
      .setName('Server URL')
      .setDesc('Base URL of your local Ollama instance.')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:11434')
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange((value) => this.save({ ollamaBaseUrl: value })),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Test chat')
          .onClick(() => void this.testChatConnection('ollama')),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Test embed')
          .onClick(() => void this.testEmbedConnection('ollama')),
      );

    new Setting(el)
      .setName('Chat model')
      .addText((text) =>
        text
          .setPlaceholder('llama3')
          .setValue(this.plugin.settings.ollamaChatModel)
          .onChange((value) => this.save({ ollamaChatModel: value })),
      );

    new Setting(el)
      .setName('Embed model')
      .addText((text) =>
        text
          .setPlaceholder('nomic-embed-text')
          .setValue(this.plugin.settings.ollamaEmbedModel)
          .onChange((value) => this.save({ ollamaEmbedModel: value })),
      );
  }

  private renderAdvancedSection(el: HTMLElement): void {
    el.createEl('h3', { text: 'Advanced' });

    new Setting(el)
      .setName('Request timeout (ms)')
      .setDesc('Maximum wait time per provider request. Default: 60000.')
      .addText((text) =>
        text
          .setPlaceholder('60000')
          .setValue(String(this.plugin.settings.timeoutMs))
          .onChange((value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.save({ timeoutMs: parsed });
            }
          }),
      );
  }

  // ── Save + validate ──────────────────────────────────────────────────────────

  /**
   * Merges a partial settings patch, persists, and surfaces the first
   * validation error as a Notice if the resulting settings are invalid.
   */
  private save(patch: Partial<PluginSettings>): void {
    Object.assign(this.plugin.settings, patch);
    void this.plugin.saveSettings();

    const result = validateSettings(this.plugin.settings);
    if (!result.valid) {
      new Notice(`VaultRAG: ${result.errors[0]}`);
    }
  }

  // ── Test connection ──────────────────────────────────────────────────────────

  /**
   * Probes the selected chat provider by streaming one token.
   * Shows a success or error Notice with the provider name and a message.
   */
  private async testChatConnection(
    provider: PluginSettings['chatProvider'],
  ): Promise<void> {
    const providerSettings = toProviderSettings({
      ...this.plugin.settings,
      chatProvider: provider,
    });

    let chatProvider;
    try {
      chatProvider = getChatProvider(providerSettings);
    } catch (err) {
      new Notice(
        `VaultRAG [${provider}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      const gen = chatProvider.chat(
        [{ role: 'user', content: 'Hi' }],
        { model: providerSettings.chatModel, maxTokens: 1 },
      ) as AsyncGenerator<string>;
      await gen.next();
      await gen.return(undefined);
      new Notice(`VaultRAG [${provider}]: chat connection successful ✓`);
    } catch (err) {
      const msg = err instanceof ProviderError ? err.message : String(err);
      new Notice(`VaultRAG [${provider}]: ${msg}`);
    }
  }

  /**
   * Probes the selected embed provider by embedding a single word.
   * Shows a success or error Notice with the provider name and a message.
   */
  private async testEmbedConnection(
    provider: PluginSettings['embedProvider'],
  ): Promise<void> {
    const providerSettings = toProviderSettings({
      ...this.plugin.settings,
      embedProvider: provider,
    });

    let embedProvider;
    try {
      embedProvider = getEmbedProvider(providerSettings);
    } catch (err) {
      new Notice(
        `VaultRAG [${provider}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      await embedProvider.embed(['test'], { model: providerSettings.embedModel });
      new Notice(`VaultRAG [${provider}]: embed connection successful ✓`);
    } catch (err) {
      const msg = err instanceof ProviderError ? err.message : String(err);
      new Notice(`VaultRAG [${provider}]: ${msg}`);
    }
  }
}
