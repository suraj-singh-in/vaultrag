import { ItemView, MarkdownRenderer, MarkdownView, Notice } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type VaultRAGPlugin from '../main';
import type { StoredMessage } from '../settings';
import type { Retriever, ActiveNote } from '../rag/retriever';
import type { ChatProvider, ChatMessage } from '../providers/base';

// ── Constants ─────────────────────────────────────────────────────────────────

export const VIEW_TYPE_CHAT = 'vaultrag-chat';

const SUGGESTION_POOL: string[] = [
  'What are the main topics across my notes?',
  'Summarize what I\'ve been working on recently.',
  'What recurring themes appear in my notes?',
  'What ideas haven\'t I fully developed yet?',
  'Find connections between different notes.',
  'What tasks or goals have I mentioned?',
  'What books or resources have I referenced?',
  'What projects am I currently tracking?',
  'What questions do I still need to answer?',
  'What decisions have I documented?',
  'What problems am I trying to solve?',
  'What habits or routines have I noted?',
  'What concepts do I reference the most?',
  'What are the gaps in my knowledge based on my notes?',
  'What people or names appear most often in my notes?',
  'Give me a random insight from my vault.',
  'What do my notes say about productivity?',
  'What ideas excite me most based on my notes?',
  'What are my most frequently revisited ideas?',
  'Summarize the key lessons from my notes.',
];

// ── ChatView ──────────────────────────────────────────────────────────────────

/**
 * Sidebar chat panel for VaultRAG.
 *
 * Lifecycle:
 *   onOpen  → build DOM skeleton → hydrate from persisted chatHistory
 *   onClose → no-op (history already persisted on every send/clear)
 *
 * Registered in main.ts via:
 *   `this.registerView(VIEW_TYPE_CHAT, leaf => new ChatView(leaf, this, retriever, provider))`
 */
const HISTORY_LIMIT = 50;
const COMPACT_KEEP  = 10; // messages to retain after compaction

export class ChatView extends ItemView {
  /** In-memory copy of the conversation; flushed to data.json on every mutation. */
  private history: StoredMessage[] = [];

  /** Summary of compacted turns — injected into every system prompt. */
  private conversationSummary = '';

  /** Scrollable message list container. */
  private messagesEl!: HTMLElement;

  /** The textarea where the user types queries. */
  private inputEl!: HTMLElement;

  /** The send button — disabled while a response is streaming. */
  private sendBtn!: HTMLButtonElement;

  /** Empty-state placeholder — removed on first message. */
  private emptyStateEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultRAGPlugin,
    private readonly retriever: Retriever,
    private readonly chatProvider: ChatProvider,
  ) {
    super(leaf);
  }

  // ── ItemView identity ──────────────────────────────────────────────────────

  getViewType(): string { return VIEW_TYPE_CHAT; }
  getDisplayText(): string { return 'VaultRAG Chat'; }
  getIcon(): string { return 'message-square'; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    this.history = [...(this.plugin.settings.chatHistory ?? [])];
    this.conversationSummary = this.plugin.settings.chatSummary ?? '';
    this.buildDOM();
    this.hydrate();
  }

  async onClose(): Promise<void> {}

  // ── Public API (called from tests and DOM event handlers) ──────────────────

  /**
   * Embeds the query, retrieves context chunks, streams the LLM response,
   * and persists both turns to history.
   */
  async sendMessage(query: string): Promise<void> {
    // Guard: vault not indexed yet
    if (!this.plugin.settings.lastIndexRun) {
      this.hideEmptyState();
      this.appendUserBubble(query);
      const { contentEl: noticeEl } = this.createAssistantBubble();
      void MarkdownRenderer.renderMarkdown(
        '> [!warning] Vault not indexed\n' +
        '> Your vault has no index yet. Run **VaultRAG: Re-index vault** from the command palette first, then ask your question.',
        noticeEl, '', this,
      );
      this.scrollToBottom();
      return;
    }

    this.hideEmptyState();
    this.setStreaming(true);

    // Append user bubble immediately for responsiveness
    this.appendUserBubble(query);

    // Create assistant bubble with typing indicator
    const { bubbleEl, contentEl: responseEl } = this.createAssistantBubble();
    const typingEl = bubbleEl.createEl('div', { cls: 'vaultrag-typing' });
    typingEl.createEl('span');
    typingEl.createEl('span');
    typingEl.createEl('span');

    let fullResponse = '';

    try {
      const chunks = await this.retriever.retrieve(query);
      const activeNote = this.getActiveNote();
      const messages = this.retriever.buildPrompt(query, chunks, activeNote ?? undefined);

      // Inject compacted-history summary into the system message so the model
      // retains context from turns that have been rolled off the visible history.
      if (this.conversationSummary) {
        messages[0].content +=
          '\n\n<conversation-summary>\n' +
          'Summary of earlier conversation turns:\n' +
          this.conversationSummary +
          '\n</conversation-summary>';
      }

      const stream = this.chatProvider.chat(messages, {
        model: this.activeChatModel(),
        maxTokens: 2048,
      });

      // Throttled markdown render — re-renders every 80 ms so formatting
      // (headings, code blocks, lists) appears live during streaming.
      let renderTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRender = () => {
        if (renderTimer !== null) return;
        renderTimer = setTimeout(() => {
          renderTimer = null;
          responseEl.empty();
          void MarkdownRenderer.renderMarkdown(fullResponse, responseEl, '', this);
          this.scrollToBottom();
        }, 80);
      };

      for await (const token of stream) {
        if (typingEl.isConnected) typingEl.remove();
        fullResponse += token;
        scheduleRender();
      }

      // Final authoritative render once stream is complete
      if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
      responseEl.empty();
      await MarkdownRenderer.renderMarkdown(fullResponse, responseEl, '', this);

      // Sources block
      const sources = [...new Set(chunks.map(c => c.filePath))];
      if (sources.length > 0) {
        this.appendSourcesBlock(bubbleEl, sources);
      }

      // Copy-to-note button
      this.appendCopyButton(bubbleEl, fullResponse);

      // Persist both turns
      this.history.push(
        { role: 'user',      content: query,        sources: [],    timestamp: Date.now() },
        { role: 'assistant', content: fullResponse, sources,        timestamp: Date.now() },
      );
      await this.saveHistory();

      // Compact once the hard limit is reached
      if (this.history.length >= HISTORY_LIMIT) {
        void this.compactHistory();
      }

    } catch (err) {
      typingEl.remove();
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      (responseEl as HTMLElement & { textContent: string }).textContent = '';
      await MarkdownRenderer.renderMarkdown(
        `> [!error] Error\n> ${msg}`,
        responseEl,
        '',
        this,
      );
    } finally {
      this.setStreaming(false);
    }
  }

  /** Wipes the conversation and persists the empty state. */
  clearHistory(): void {
    this.history = [];
    this.conversationSummary = '';
    this.messagesEl.empty();
    void this.saveHistory();
    this.showEmptyState();
  }

  // ── History compaction ─────────────────────────────────────────────────────

  /**
   * When history reaches HISTORY_LIMIT, summarise the oldest
   * (HISTORY_LIMIT - COMPACT_KEEP) turns via the chat provider, store the
   * summary in settings, and replace those turns with a single summary marker.
   */
  private async compactHistory(): Promise<void> {
    const cutoff = this.history.length - COMPACT_KEEP;
    const toSummarise = this.history.slice(0, cutoff).filter(m => m.role !== 'summary');
    const recent      = this.history.slice(cutoff);

    // Build a plain-text transcript for the summarisation request
    const transcript = toSummarise
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    const summariseMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a concise summariser. Summarise the conversation below, ' +
          'preserving all key topics, decisions, and context needed to continue ' +
          'the conversation. Be brief but complete. Output only the summary.',
      },
      { role: 'user', content: transcript },
    ];

    let summary = '';
    try {
      const stream = this.chatProvider.chat(summariseMessages, {
        model: this.activeChatModel(),
        maxTokens: 512,
      });
      for await (const token of stream) {
        summary += token;
      }
    } catch {
      // Summarisation failed — just truncate without a summary to avoid blocking
      this.history = recent;
      await this.saveHistory();
      return;
    }

    this.conversationSummary = summary;

    // Replace compacted turns with a single summary marker visible in the UI
    const marker: StoredMessage = {
      role: 'summary',
      content: summary,
      sources: [],
      timestamp: Date.now(),
    };

    this.history = [marker, ...recent];
    await this.saveHistory();

    // Render the marker into the message list
    this.renderSummaryMarker(summary);
  }

  private renderSummaryMarker(summary: string): void {
    // Insert before the first message that is NOT the old summary marker
    const firstRecent = this.messagesEl.querySelector(
      '.vaultrag-message:not(.vaultrag-message--summary)',
    );
    const el = createEl('div', { cls: 'vaultrag-message vaultrag-message--summary' });
    el.createEl('span', { cls: 'vaultrag-summary-label', text: '⬆ Earlier conversation summarised' });
    const toggle = el.createEl('details', { cls: 'vaultrag-summary-detail' });
    toggle.createEl('summary', { text: 'View summary' });
    toggle.createEl('p', { cls: 'vaultrag-summary-text', text: summary });
    if (firstRecent) {
      this.messagesEl.insertBefore(el, firstRecent);
    } else {
      this.messagesEl.appendChild(el);
    }
  }

  /**
   * Appends the assistant response to the end of the currently active note.
   * Shows a Notice if no markdown note is open.
   */
  async copyToNote(content: string): Promise<void> {
    // getActiveViewOfType returns null when the chat panel itself is focused.
    // Fall back to any open markdown leaf.
    let view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null;
    if (!view) {
      const leaf = this.app.workspace.getLeavesOfType('markdown').find(
        l => (l.view as MarkdownView).file != null,
      );
      if (leaf) view = leaf.view as MarkdownView;
    }
    if (!view) {
      new Notice('VaultRAG: No active note to copy into.');
      return;
    }
    const editor = view.editor;
    const lastLine = editor.lastLine();
    const lastLineContent = editor.getLine(lastLine);
    editor.replaceRange('\n\n' + content, { line: lastLine, ch: lastLineContent.length });
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  private setStreaming(active: boolean): void {
    this.sendBtn.disabled = active;
  }

  private buildDOM(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Header: title + clear button
    const headerEl = contentEl.createEl('div', { cls: 'vaultrag-header' });
    headerEl.createEl('span', { text: 'VaultRAG Chat', cls: 'vaultrag-title' });
    const clearBtn = headerEl.createEl('button', { text: 'Clear', cls: 'vaultrag-clear-btn' });
    clearBtn.addEventListener('click', () => this.clearHistory());

    // Scrollable message area
    this.messagesEl = contentEl.createEl('div', { cls: 'vaultrag-messages' });

    // Input row
    const inputRow = contentEl.createEl('div', { cls: 'vaultrag-input-row' });
    this.inputEl = inputRow.createEl('textarea', { cls: 'vaultrag-input' });
    (this.inputEl as HTMLElement & { placeholder: string }).placeholder = 'Ask your vault…';

    this.sendBtn = inputRow.createEl('button', { text: 'Send ➤', cls: 'vaultrag-send-btn' });
    this.sendBtn.addEventListener('click', () => {
      const query = ((this.inputEl as HTMLElement & { value: string }).value ?? '').trim();
      if (query) {
        (this.inputEl as HTMLElement & { value: string }).value = '';
        void this.sendMessage(query);
      }
    });

    // Allow Shift+Enter to insert newline; Enter alone to submit
    this.inputEl.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' && !ke.shiftKey) {
        ke.preventDefault();
        if (this.sendBtn.disabled) return;
        const query = ((this.inputEl as HTMLElement & { value: string }).value ?? '').trim();
        if (query) {
          (this.inputEl as HTMLElement & { value: string }).value = '';
          void this.sendMessage(query);
        }
      }
    });
  }

  /** Re-renders persisted history messages after opening the view. */
  private hydrate(): void {
    if (this.history.length === 0) {
      this.showEmptyState();
      return;
    }
    for (const msg of this.history) {
      if (msg.role === 'user') {
        this.appendUserBubble(msg.content);
      } else if (msg.role === 'summary') {
        this.renderSummaryMarker(msg.content);
      } else {
        const { bubbleEl, contentEl: responseEl } = this.createAssistantBubble();
        void MarkdownRenderer.renderMarkdown(msg.content, responseEl, '', this);
        if (msg.sources.length > 0) {
          this.appendSourcesBlock(bubbleEl, msg.sources);
        }
        this.appendCopyButton(bubbleEl, msg.content);
      }
    }
    this.scrollToBottom();
  }

  // ── Empty state ────────────────────────────────────────────────────────────

  private showEmptyState(): void {
    if (this.emptyStateEl) return;

    const el = this.messagesEl.createEl('div', { cls: 'vaultrag-empty-state' });

    // ── Not indexed yet ──────────────────────────────────────────────────────
    if (!this.plugin.settings.lastIndexRun) {
      el.createEl('div', { cls: 'vaultrag-empty-emoji', text: '📂' });
      el.createEl('p', { cls: 'vaultrag-empty-hint', text: 'Vault not indexed yet' });
      el.createEl('p', { cls: 'vaultrag-empty-sub', text: 'Index your vault once to start chatting with your notes.' });

      const btn = el.createEl('button', { cls: 'vaultrag-index-cta', text: 'Re-index vault' });

      // Progress bar (hidden until indexing starts)
      const progressWrap  = el.createEl('div', { cls: 'vaultrag-cta-progress' });
      const track         = progressWrap.createEl('div', { cls: 'vaultrag-cta-progress-fill-track' });
      const progressBar   = track.createEl('div', { cls: 'vaultrag-cta-progress-fill' });
      const progressText  = progressWrap.createEl('span', { cls: 'vaultrag-cta-progress-text', text: 'Starting…' });
      progressWrap.style.display = 'none';

      // If already running when the panel opens, subscribe immediately
      const startListening = () => {
        btn.disabled = true;
        btn.textContent = 'Indexing…';
        progressWrap.style.display = 'flex';

        const unsub = this.plugin.onReindexProgress((done, total) => {
          if (done === -1) {
            // Completion sentinel
            unsub();
            btn.disabled = false;
            btn.textContent = 'Re-index vault';
            progressWrap.style.display = 'none';
            // Refresh the empty state — vault is now indexed
            this.hideEmptyState();
            this.showEmptyState();
            return;
          }
          if (total > 0) {
            const pct = Math.round((done / total) * 100);
            progressBar.style.width = `${pct}%`;
            progressText.textContent = `${done} / ${total} files`;
          } else {
            progressText.textContent = 'Preparing…';
          }
          this.scrollToBottom();
        });
      };

      if (this.plugin.isReindexing) startListening();

      btn.addEventListener('click', () => {
        startListening();
        void this.plugin.runReIndex();
      });

      this.emptyStateEl = el;
      return;
    }

    // ── Ready — show suggestion chips ────────────────────────────────────────
    const shuffled = [...SUGGESTION_POOL].sort(() => Math.random() - 0.5);
    const picks = shuffled.slice(0, 5);

    el.createEl('div', { cls: 'vaultrag-empty-emoji', text: '🔮' });
    el.createEl('p', { cls: 'vaultrag-empty-hint', text: 'Ask your vault anything' });

    const chips = el.createEl('div', { cls: 'vaultrag-suggestions' });
    for (const q of picks) {
      const chip = chips.createEl('button', { cls: 'vaultrag-suggestion-chip', text: q });
      chip.addEventListener('click', () => {
        (this.inputEl as HTMLTextAreaElement).value = q;
        (this.inputEl as HTMLTextAreaElement).focus();
        this.inputEl.dispatchEvent(new Event('input'));
      });
    }

    this.emptyStateEl = el;
  }

  private hideEmptyState(): void {
    if (!this.emptyStateEl) return;
    this.emptyStateEl.remove();
    this.emptyStateEl = null;
  }

  // ── Bubble helpers ─────────────────────────────────────────────────────────

  private appendUserBubble(text: string): void {
    const bubble = this.messagesEl.createEl('div', { cls: 'vaultrag-message vaultrag-message--user' });
    bubble.createEl('div', { cls: 'vaultrag-message-content', text });
    this.scrollToBottom();
  }

  private createAssistantBubble(): { bubbleEl: HTMLElement; contentEl: HTMLElement } {
    const bubbleEl = this.messagesEl.createEl('div', {
      cls: 'vaultrag-message vaultrag-message--assistant',
    });
    const contentEl = bubbleEl.createEl('div', { cls: 'vaultrag-message-content' });
    this.scrollToBottom();
    return { bubbleEl, contentEl };
  }

  private appendSourcesBlock(parent: HTMLElement, sources: string[]): void {
    const details = parent.createEl('details', { cls: 'vaultrag-sources' });
    details.createEl('summary', { text: `Sources (${sources.length})` });
    const list = details.createEl('ul', { cls: 'vaultrag-source-list' });
    for (const src of sources) {
      const li = list.createEl('li');
      const a = li.createEl('a', { text: src, cls: 'vaultrag-source-link', href: '#' });
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const file = this.app.vault.getFileByPath(src);
        if (file) {
          void this.app.workspace.getLeaf(false).openFile(file);
        } else {
          // Fallback for older Obsidian versions
          void this.app.workspace.openLinkText(src, '', false);
        }
      });
    }
  }

  private appendCopyButton(parent: HTMLElement, content: string): void {
    const row = parent.createEl('div', { cls: 'vaultrag-action-row' });

    // ── Copy to clipboard ──────────────────────────────────────────────────
    const clipBtn = row.createEl('button', { cls: 'vaultrag-action-btn' });
    clipBtn.setAttribute('aria-label', 'Copy');
    clipBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg><span class="vaultrag-action-label">Copy</span>`;
    clipBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        clipBtn.addClass('vaultrag-action-btn--done');
        setTimeout(() => clipBtn.removeClass('vaultrag-action-btn--done'), 1500);
      });
    });

    // ── Copy to note ───────────────────────────────────────────────────────
    const noteBtn = row.createEl('button', { cls: 'vaultrag-action-btn' });
    noteBtn.setAttribute('aria-label', 'Copy to note');
    noteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z"/>
    </svg><span class="vaultrag-action-label">Copy to note</span>`;
    noteBtn.addEventListener('click', () => void this.copyToNote(content));
  }

  private scrollToBottom(): void {
    const el = this.messagesEl as HTMLElement & { scrollTop: number; scrollHeight: number };
    el.scrollTop = el.scrollHeight;
  }

  // ── Data helpers ───────────────────────────────────────────────────────────

  /** Returns the currently open note's path and content, or `null`. */
  private getActiveNote(): ActiveNote | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null;
    if (!view || !view.file) return null;
    return {
      filePath: view.file.path,
      content: view.getViewData(),
    };
  }

  private activeChatModel(): string {
    const s = this.plugin.settings;
    switch (s.chatProvider) {
      case 'openai':    return s.openaiChatModel;
      case 'anthropic': return s.anthropicChatModel;
      case 'ollama':    return s.ollamaChatModel;
    }
  }

  private async saveHistory(): Promise<void> {
    this.plugin.settings.chatHistory = this.history.slice();
    this.plugin.settings.chatSummary = this.conversationSummary;
    await this.plugin.saveSettings();
  }
}
