import { Component, MarkdownRenderer, MarkdownView, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type VaultRAGPlugin from '../main';
import type { StoredMessage } from '../settings';
import type { Retriever, ActiveNote } from '../rag/retriever';
import type { ChatProvider } from '../providers/base';

/**
 * A floating overlay panel that sits on the right edge of the Obsidian window.
 * It is not an ItemView — it injects directly into document.body so it overlays
 * content without pushing the editor layout.
 *
 * Toggle with .toggle().  Resize by dragging the left edge handle.
 * Width and open state are persisted to plugin settings.
 */
export class FloatingChatPanel extends Component {
  private panelEl!:  HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!:  HTMLTextAreaElement;
  private sendBtn!:  HTMLButtonElement;

  private history:    StoredMessage[] = [];
  private _open:      boolean;
  private _width:     number;

  // Resize state
  private _resizing   = false;
  private _startX     = 0;
  private _startWidth = 0;

  constructor(
    private readonly app:          App,
    private readonly plugin:       VaultRAGPlugin,
    private readonly retriever:    Retriever,
    private readonly chatProvider: ChatProvider,
  ) {
    super();
    this._width = plugin.settings.chatPanelWidth;
    this._open  = plugin.settings.chatPanelOpen;
  }

  // ── Component lifecycle ─────────────────────────────────────────────────

  onload(): void {
    this.history = [...(this.plugin.settings.chatHistory ?? [])];
    this._buildPanel();
    this._hydrate();
    if (this._open) this.panelEl.addClass('is-open');
  }

  onunload(): void {
    this.panelEl.remove();
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup',   this._onResizeEnd);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  toggle(): void {
    this._open = !this._open;
    this.panelEl.toggleClass('is-open', this._open);
    this.plugin.settings.chatPanelOpen = this._open;
    void this.plugin.saveSettings();
    if (this._open) {
      // Wait for the CSS transition to start before focusing
      setTimeout(() => this.inputEl.focus(), 60);
    }
  }

  get isOpen(): boolean { return this._open; }

  // ── DOM construction ────────────────────────────────────────────────────

  private _buildPanel(): void {
    this.panelEl = document.body.createEl('div', { cls: 'vaultrag-panel' });
    this.panelEl.style.setProperty('--vr-panel-width', `${this._width}px`);

    // ── Resize handle (left edge) ─────────────────────────────────────────
    const resizeHandle = this.panelEl.createEl('div', { cls: 'vaultrag-panel-resize' });
    resizeHandle.addEventListener('mousedown', this._onResizeStart);

    // ── Inner layout wrapper ───────────────────────────────────────────────
    const inner = this.panelEl.createEl('div', { cls: 'vaultrag-panel-inner' });

    // Header
    const header = inner.createEl('div', { cls: 'vaultrag-header' });

    const titleWrap = header.createEl('div', { cls: 'vaultrag-title' });
    titleWrap.createEl('span', { text: 'VaultRAG' });

    const actions = header.createEl('div', { cls: 'vaultrag-panel-actions' });

    const clearBtn = actions.createEl('button', { text: 'Clear', cls: 'vaultrag-clear-btn' });
    clearBtn.addEventListener('click', () => this.clearHistory());

    const closeBtn = actions.createEl('button', { cls: 'vaultrag-panel-close-btn' });
    closeBtn.setAttribute('aria-label', 'Close chat panel');
    closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;
    closeBtn.addEventListener('click', () => this.toggle());

    // Messages
    this.messagesEl = inner.createEl('div', { cls: 'vaultrag-messages' });

    // Composer
    const inputRow = inner.createEl('div', { cls: 'vaultrag-input-row' });
    this.inputEl = inputRow.createEl('textarea', { cls: 'vaultrag-input' }) as HTMLTextAreaElement;
    this.inputEl.placeholder = 'Ask your vault…';
    this.inputEl.rows = 1;

    this.sendBtn = inputRow.createEl('button', { cls: 'vaultrag-send-btn', text: 'Send' }) as HTMLButtonElement;

    // Events
    this.sendBtn.addEventListener('click', () => this._submit());

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._submit();
      }
    });

    // Auto-grow textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 130)}px`;
    });
  }

  private _hydrate(): void {
    for (const msg of this.history) {
      if (msg.role === 'user') {
        this._appendUserBubble(msg.content);
      } else {
        const { bubbleEl, contentEl } = this._createAssistantBubble();
        void MarkdownRenderer.renderMarkdown(msg.content, contentEl, '', this.plugin);
        if (msg.sources.length > 0) this._appendSources(bubbleEl, msg.sources);
        this._appendCopyBtn(bubbleEl, msg.content);
      }
    }
    this._scrollToBottom();
  }

  // ── Send / stream ───────────────────────────────────────────────────────

  private _submit(): void {
    const query = this.inputEl.value.trim();
    if (!query || this.sendBtn.disabled) return;
    this.inputEl.value = '';
    this.inputEl.style.height = '';
    void this.sendMessage(query);
  }

  async sendMessage(query: string): Promise<void> {
    this.sendBtn.disabled = true;
    this._appendUserBubble(query);
    const { bubbleEl, contentEl } = this._createAssistantBubble();
    let fullResponse = '';

    try {
      const chunks      = await this.retriever.retrieve(query);
      const activeNote  = this._getActiveNote();
      const messages    = this.retriever.buildPrompt(query, chunks, activeNote ?? undefined);

      const stream = this.chatProvider.chat(messages, {
        model:     this._activeChatModel(),
        maxTokens: 2048,
      });

      contentEl.addClass('is-streaming');
      for await (const token of stream) {
        fullResponse += token;
        contentEl.textContent = fullResponse;
        this._scrollToBottom();
      }
      contentEl.removeClass('is-streaming');

      contentEl.empty();
      await MarkdownRenderer.renderMarkdown(fullResponse, contentEl, '', this.plugin);

      const sources = [...new Set(chunks.map(c => c.filePath))];
      if (sources.length > 0) this._appendSources(bubbleEl, sources);
      this._appendCopyBtn(bubbleEl, fullResponse);

      this.history.push(
        { role: 'user',      content: query,        sources: [],    timestamp: Date.now() },
        { role: 'assistant', content: fullResponse,  sources,        timestamp: Date.now() },
      );
      await this._saveHistory();

    } catch (err) {
      contentEl.removeClass('is-streaming');
      contentEl.empty();
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      await MarkdownRenderer.renderMarkdown(
        `> [!error] Error\n> ${msg}`,
        contentEl,
        '',
        this.plugin,
      );
    } finally {
      this.sendBtn.disabled = false;
      this._scrollToBottom();
    }
  }

  clearHistory(): void {
    this.history = [];
    this.messagesEl.empty();
    void this._saveHistory();
  }

  // ── Bubble helpers ──────────────────────────────────────────────────────

  private _appendUserBubble(text: string): void {
    const msg = this.messagesEl.createEl('div', {
      cls: 'vaultrag-message vaultrag-message--user',
    });
    msg.createEl('div', { cls: 'vaultrag-message-content', text });
    this._scrollToBottom();
  }

  private _createAssistantBubble(): { bubbleEl: HTMLElement; contentEl: HTMLElement } {
    const bubbleEl  = this.messagesEl.createEl('div', {
      cls: 'vaultrag-message vaultrag-message--assistant',
    });
    const contentEl = bubbleEl.createEl('div', { cls: 'vaultrag-message-content' });
    this._scrollToBottom();
    return { bubbleEl, contentEl };
  }

  private _appendSources(parent: HTMLElement, sources: string[]): void {
    const details = parent.createEl('details', { cls: 'vaultrag-sources' });
    details.createEl('summary', {
      text: `${sources.length} source${sources.length !== 1 ? 's' : ''}`,
    });
    const list = details.createEl('ul', { cls: 'vaultrag-source-list' });
    for (const src of sources) {
      list.createEl('li').createEl('a', {
        text: src,
        cls:  'vaultrag-source-link',
        href: '#',
      });
    }
  }

  private _appendCopyBtn(parent: HTMLElement, content: string): void {
    const btn = parent.createEl('button', {
      cls:  'vaultrag-copy-btn',
      text: 'Copy to note',
    });
    btn.addEventListener('click', () => void this._copyToNote(content));
  }

  private _scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // ── Resize ──────────────────────────────────────────────────────────────

  private _onResizeStart = (e: MouseEvent): void => {
    e.preventDefault();
    this._resizing    = true;
    this._startX      = e.clientX;
    this._startWidth  = this._width;
    document.addEventListener('mousemove', this._onResizeMove);
    document.addEventListener('mouseup',   this._onResizeEnd);
    document.body.addClass('vaultrag-is-resizing');
  };

  private _onResizeMove = (e: MouseEvent): void => {
    if (!this._resizing) return;
    // Dragging the left edge leftward = panel gets wider
    const delta   = this._startX - e.clientX;
    this._width   = Math.max(280, Math.min(720, this._startWidth + delta));
    this.panelEl.style.setProperty('--vr-panel-width', `${this._width}px`);
  };

  private _onResizeEnd = (): void => {
    if (!this._resizing) return;
    this._resizing = false;
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup',   this._onResizeEnd);
    document.body.removeClass('vaultrag-is-resizing');
    this.plugin.settings.chatPanelWidth = this._width;
    void this.plugin.saveSettings();
  };

  // ── Data helpers ────────────────────────────────────────────────────────

  private _getActiveNote(): ActiveNote | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null;
    if (!view?.file) return null;
    return { filePath: view.file.path, content: view.getViewData() };
  }

  private _activeChatModel(): string {
    const s = this.plugin.settings;
    switch (s.chatProvider) {
      case 'openai':    return s.openaiChatModel;
      case 'anthropic': return s.anthropicChatModel;
      case 'ollama':    return s.ollamaChatModel;
    }
  }

  private async _saveHistory(): Promise<void> {
    this.plugin.settings.chatHistory = this.history.slice();
    await this.plugin.saveSettings();
  }

  // ── Copy to note ────────────────────────────────────────────────────────

  private async _copyToNote(content: string): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null;
    if (!view) {
      new Notice('VaultRAG: No active note to copy into.');
      return;
    }
    const editor  = view.editor;
    const last    = editor.lastLine();
    editor.replaceRange('\n\n' + content, { line: last, ch: editor.getLine(last).length });
  }
}
