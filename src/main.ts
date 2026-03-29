import { Plugin, normalizePath, Notice } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import {
  type PluginSettings,
  DEFAULT_SETTINGS,
  applyDefaults,
  toProviderSettings,
} from './settings';
import { VaultRAGSettingsTab } from './ui/SettingsTab';
import { ChatView, VIEW_TYPE_CHAT } from './ui/ChatView';
import { DashboardModal } from './ui/DashboardModal';
import { VectraStore } from './store/vectraStore';
import { VaultIndexer } from './rag/indexer';
import type { StateAdapter, IndexerState } from './rag/indexer';
import { Retriever } from './rag/retriever';
import { getChatProvider, getEmbedProvider } from './providers/factory';

/**
 * VaultRAG — Retrieval-Augmented Generation for Obsidian.
 *
 * Lifecycle:
 *   onload  → load settings → register view/commands → warm-up index (non-blocking)
 *   onunload→ close vector store
 *
 * Infrastructure (store, indexer) is initialised lazily on first use so that
 * `onload` itself never throws — even in environments where the vault adapter
 * has no real filesystem (e.g. the Jest test suite).
 */
export default class VaultRAGPlugin extends Plugin {
  /** Current settings — populated in onload(), always present. */
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  private store:        VectraStore  | null = null;
  private stateAdapter: StateAdapter | null = null;
  private indexer:      VaultIndexer | null = null;
  /**
   * Singleton Promise for the infrastructure init sequence.
   * Ensures concurrent callers share a single open() attempt rather than
   * racing to create duplicate stores.
   */
  private _infraPromise: Promise<boolean> | null = null;

  /** True while a re-index run is in progress. */
  isReindexing = false;

  /** Subscribers notified on each file during a re-index run. */
  private _reindexListeners = new Set<(done: number, total: number) => void>();

  onReindexProgress(cb: (done: number, total: number) => void): () => void {
    this._reindexListeners.add(cb);
    return () => this._reindexListeners.delete(cb);
  }

  private _emitReindexProgress(done: number, total: number): void {
    for (const cb of this._reindexListeners) cb(done, total);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register the chat view type so Obsidian can restore it after restart
    this.registerView(VIEW_TYPE_CHAT, (leaf) => this.createChatView(leaf));

    // Ribbon icon — toggles the right-sidebar chat panel
    this.addRibbonIcon('message-square', 'Toggle VaultRAG Chat', () =>
      this.toggleChat(),
    );

    // Command palette entries
    this.addCommand({
      id:       'open-chat',
      name:     'Toggle chat panel',
      callback: () => this.toggleChat(),
    });

    this.addCommand({
      id:       'open-dashboard',
      name:     'Open index dashboard',
      callback: () => this.openDashboard(),
    });

    this.addCommand({
      id:       'reindex-vault',
      name:     'Re-index vault',
      callback: () => { void this.runReIndex(); },
    });

    // Settings tab
    this.addSettingTab(new VaultRAGSettingsTab(this.app, this));

    // Warm-up: open the store in the background so the first chat is instant.
    void this.ensureInfrastructure();
  }

  onunload(): void {
    if (this.store) void this.store.close();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = applyDefaults(
      ((await this.loadData()) as Partial<PluginSettings>) ?? {},
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Infrastructure ─────────────────────────────────────────────────────────

  private ensureInfrastructure(): Promise<boolean> {
    if (this._infraPromise === null) {
      this._infraPromise = this._buildInfrastructure();
    }
    return this._infraPromise;
  }

  private async _buildInfrastructure(): Promise<boolean> {
    try {
      const stateAdapter = this.buildStateAdapter();
      const store        = this.buildVectraStore();
      await store.open();
      this.stateAdapter  = stateAdapter;
      this.store         = store;
      this.indexer       = this.buildIndexer();
      return true;
    } catch (err) {
      this._infraPromise = null;
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`VaultRAG: failed to open index — ${msg}`);
      return false;
    }
  }

  private buildStateAdapter(): StateAdapter {
    const configDir = this.app.vault.configDir;
    const adapter   = this.app.vault.adapter;
    return {
      load: async (): Promise<IndexerState> => {
        const filePath = normalizePath(`${configDir}/vaultrag-state.json`);
        try {
          if (!await adapter.exists(filePath)) return { mtimes: {}, chunkIds: {} };
          const raw = await adapter.read(filePath);
          return JSON.parse(raw) as IndexerState;
        } catch {
          return { mtimes: {}, chunkIds: {} };
        }
      },
      save: async (state: IndexerState): Promise<void> => {
        const filePath = normalizePath(`${configDir}/vaultrag-state.json`);
        await adapter.write(filePath, JSON.stringify(state));
      },
    };
  }

  private buildVectraStore(): VectraStore {
    const basePath  = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const indexPath = path.join(basePath, this.app.vault.configDir, 'vaultrag-index');
    return new VectraStore({
      indexPath,
      onCorrupt: async (err) => {
        new Notice(`VaultRAG: vector index corrupted (${err.message}) — rebuilding…`);
        return true;
      },
    });
  }

  private buildIndexer(): VaultIndexer {
    const ps = toProviderSettings(this.settings);
    const embedProvider = getEmbedProvider(ps);
    return new VaultIndexer(
      this.app.vault,
      embedProvider,
      this.store!,        // non-null: called only after open() succeeds
      this.stateAdapter!,
      { embedModel: ps.embedModel },
    );
  }

  // ── View factory ───────────────────────────────────────────────────────────

  private createChatView(leaf: WorkspaceLeaf): ChatView {
    const ps = toProviderSettings(this.settings);

    let chatProvider;
    try {
      chatProvider = getChatProvider(ps);
    } catch (err) {
      new Notice(`VaultRAG: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const embedProvider = getEmbedProvider(ps);

    // The view factory may be called before ensureInfrastructure() completes
    // (e.g. Obsidian restores a saved workspace on startup).  Use a lazy proxy
    // so the real store is only accessed at query time, by which point the
    // background open() will have finished.
    const plugin = this;
    const lazyStore: import('./store/base').VectorStore = {
      open:   async () => { await plugin.ensureInfrastructure(); },
      close:  async () => { if (plugin.store) await plugin.store.close(); },
      upsert: async (item) => {
        await plugin.ensureInfrastructure();
        await plugin.store!.upsert(item);
      },
      delete: async (id) => {
        await plugin.ensureInfrastructure();
        await plugin.store!.delete(id);
      },
      search: async (vector, topK) => {
        await plugin.ensureInfrastructure();
        return plugin.store!.search(vector, topK);
      },
      size: async () => {
        await plugin.ensureInfrastructure();
        return plugin.store!.size();
      },
    };

    const retriever = new Retriever(lazyStore, embedProvider, {
      topK:             this.settings.topK,
      maxContextTokens: this.settings.maxContextTokens,
      systemPrompt:     this.settings.systemPrompt,
      embedModel:       ps.embedModel,
    });

    return new ChatView(leaf, this, retriever, chatProvider);
  }

  // ── Command actions ────────────────────────────────────────────────────────

  /**
   * Opens the chat in the right sidebar on first call.
   * On subsequent calls: expands the sidebar if collapsed, collapses it if open.
   * This mirrors how VS Code's GitHub Copilot Chat sidebar works.
   */
  private async toggleChat(): Promise<void> {
    if (!await this.ensureInfrastructure()) return;

    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (existing.length > 0) {
      // View already mounted — toggle the right sidebar collapsed state
      const rightSplit = workspace.rightSplit as unknown as {
        collapsed: boolean;
        collapse(): void;
        expand(): void;
      };

      if (rightSplit.collapsed) {
        rightSplit.expand();
        await workspace.revealLeaf(existing[0]);
      } else {
        rightSplit.collapse();
      }
      return;
    }

    // First open: mount in the right sidebar
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    await workspace.revealLeaf(leaf);
  }

  private async openDashboard(): Promise<void> {
    if (!await this.ensureInfrastructure()) return;
    new DashboardModal(
      this.app,
      this,
      this.indexer!,
      this.stateAdapter!,
      this.store!,
    ).open();
  }

  async runReIndex(): Promise<void> {
    if (!await this.ensureInfrastructure()) return;
    if (this.isReindexing) return;

    this.isReindexing = true;
    this._emitReindexProgress(0, 0);
    new Notice('VaultRAG: starting re-index…');

    try {
      const result = await this.indexer!.indexAll((event) => {
        this._emitReindexProgress(event.done, event.total);
      });

      const failNote = result.errors.length > 0 ? `, ${result.errors.length} failed` : '';
      this.settings.lastIndexRun = {
        timestamp:  Date.now(),
        indexed:    result.indexed,
        skipped:    result.skipped,
        totalFiles: result.indexed + result.skipped + result.errors.length,
        errors:     result.errors.map(e => ({ file: e.file, error: e.error.message })),
      };
      await this.saveSettings();
      new Notice(`VaultRAG: re-index complete — ${result.indexed} indexed, ${result.skipped} skipped${failNote}`);
    } finally {
      this.isReindexing = false;
      this._emitReindexProgress(-1, -1); // sentinel: signals completion
    }
  }
}
