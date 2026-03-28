import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import type VaultRAGPlugin from '../main';
import type { LastIndexRun } from '../settings';
import type { VaultIndexer, StateAdapter, IndexerState, ProgressEvent } from '../rag/indexer';
import type { VectorStore, ItemMetadata } from '../store/base';
import type { TFile } from 'obsidian';
import type { ProviderName } from '../providers/base';

// ── Cost pricing table ────────────────────────────────────────────────────────

/** USD cost per 1 million embed tokens, keyed by OpenAI model name. */
const EMBED_COST_PER_1M: Record<string, number> = {
  'text-embedding-3-small': 0.020,
  'text-embedding-3-large': 0.130,
  'text-embedding-ada-002': 0.100,
};

/** Default fallback price (text-embedding-3-small) when model is unknown. */
const DEFAULT_EMBED_PRICE = 0.020;

// ── Public types ──────────────────────────────────────────────────────────────

export type FileStatusKind = 'indexed' | 'failed' | 'not-indexed';

/** One row in the per-file status table. */
export interface FileEntry {
  path: string;
  status: FileStatusKind;
  chunkCount: number;
  errorMsg?: string;
}

// ── Pure utility functions (exported for unit testing) ────────────────────────

/**
 * Derives a per-file status entry for every vault markdown file.
 *
 * Priority: `failed` > `indexed` > `not-indexed`
 */
export function computeFileStatuses(
  files: TFile[],
  state: IndexerState,
  errors: Array<{ file: string; error: string }>,
): FileEntry[] {
  const errorMap = new Map(errors.map(e => [e.file, e.error]));

  return files.map(f => {
    const errMsg = errorMap.get(f.path);
    if (errMsg !== undefined) {
      return { path: f.path, status: 'failed', chunkCount: 0, errorMsg: errMsg };
    }
    if (f.path in state.mtimes) {
      const chunkCount = state.chunkIds[f.path]?.length ?? 0;
      return { path: f.path, status: 'indexed', chunkCount };
    }
    return { path: f.path, status: 'not-indexed', chunkCount: 0 };
  });
}

/**
 * Estimates the cumulative embed cost as a human-readable string.
 *
 * @param totalTokens - Estimated total tokens embedded (chunks × chunk size).
 * @param model       - The embed model identifier.
 * @param provider    - The embed provider name.
 * @returns A formatted cost string, e.g. `"$0.0200"` or `"Local (free)"`.
 */
export function estimateEmbedCost(
  totalTokens: number,
  model: string,
  provider: ProviderName,
): string {
  if (provider === 'ollama') return 'Local (free)';
  if (provider === 'anthropic') return 'Per-query (see Anthropic dashboard)';

  const pricePerMillion = EMBED_COST_PER_1M[model] ?? DEFAULT_EMBED_PRICE;
  const cost = (totalTokens / 1_000_000) * pricePerMillion;
  return `$${cost.toFixed(4)}`;
}

// ── DashboardModal ────────────────────────────────────────────────────────────

/**
 * Index health modal — shows summary stats, per-file status table, cost
 * estimate, and a "Re-index all" button with a live progress bar.
 *
 * Open via: `new DashboardModal(app, plugin, indexer, stateAdapter, store).open()`
 */
export class DashboardModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: VaultRAGPlugin,
    private readonly indexer: Pick<VaultIndexer, 'indexAll'>,
    private readonly stateAdapter: StateAdapter,
    private readonly store: VectorStore<ItemMetadata>,
  ) {
    super(app);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const [state, vectorCount] = await Promise.all([
      this.stateAdapter.load(),
      this.store.size(),
    ]);

    const allFiles = this.plugin.app.vault.getMarkdownFiles();
    const lastRun  = this.plugin.settings.lastIndexRun;
    const errors   = lastRun?.errors ?? [];

    const entries = computeFileStatuses(allFiles, state, errors);

    this.renderHeader(contentEl);
    this.renderSummaryStats(contentEl, entries, vectorCount, lastRun);
    this.renderCostSection(contentEl);
    this.renderFileTable(contentEl, entries);
    this.renderReIndexButton(contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── Public action (exposed so tests can call it directly) ──────────────────

  /**
   * Triggers a full vault re-index with a live progress bar.
   * Updates `plugin.settings.lastIndexRun` and `totalTokensIndexed` on completion,
   * then re-renders the modal content.
   */
  async reIndex(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const progressWrap = contentEl.createEl('div', { cls: 'vaultrag-progress-wrap' });
    progressWrap.createEl('p', { text: 'Re-indexing vault…', cls: 'vaultrag-progress-label' });
    const progressBar = progressWrap.createEl('progress', { cls: 'vaultrag-progress-bar' });
    progressBar.setAttr('value', '0');
    progressBar.setAttr('max', '1');
    const progressText = progressWrap.createEl('span', { cls: 'vaultrag-progress-text', text: '0 / …' });

    const onProgress = (event: ProgressEvent): void => {
      progressBar.setAttr('value', String(event.done));
      progressBar.setAttr('max',   String(event.total));
      (progressText as HTMLElement & { textContent: string }).textContent =
        `${event.done} / ${event.total}`;
    };

    const result = await this.indexer.indexAll(onProgress);

    // Persist last-run snapshot
    const totalFiles = (result.indexed + result.skipped + result.errors.length);
    const run: LastIndexRun = {
      timestamp:  Date.now(),
      indexed:    result.indexed,
      skipped:    result.skipped,
      totalFiles,
      errors:     result.errors.map(e => ({ file: e.file, error: e.error.message })),
    };
    this.plugin.settings.lastIndexRun = run;

    // Re-count total tokens (chunks × default chunk size)
    const state = await this.stateAdapter.load();
    const totalChunks = Object.values(state.chunkIds).reduce(
      (sum, ids) => sum + ids.length,
      0,
    );
    this.plugin.settings.totalTokensIndexed = totalChunks * 512;

    await this.plugin.saveSettings();

    // Refresh modal with updated data
    await this.onOpen();
  }

  // ── Rendering helpers ──────────────────────────────────────────────────────

  private renderHeader(el: HTMLElement): void {
    el.createEl('h2', { text: 'VaultRAG — Index Status', cls: 'vaultrag-dashboard-title' });
  }

  private renderSummaryStats(
    el: HTMLElement,
    entries: FileEntry[],
    vectorCount: number,
    lastRun: LastIndexRun | null,
  ): void {
    const section = el.createEl('div', { cls: 'vaultrag-stats-section' });
    section.createEl('h3', { text: 'Summary' });

    const indexed    = entries.filter(e => e.status === 'indexed').length;
    const failed     = entries.filter(e => e.status === 'failed').length;
    const notIndexed = entries.filter(e => e.status === 'not-indexed').length;
    const total      = entries.length;

    const grid = section.createEl('div', { cls: 'vaultrag-stats-grid' });
    this.statItem(grid, 'Total files',    String(total));
    this.statItem(grid, 'Indexed',        String(indexed));
    this.statItem(grid, 'Not indexed',    String(notIndexed));
    this.statItem(grid, 'Failed',         String(failed));
    this.statItem(grid, 'Vector chunks',  String(vectorCount));
    this.statItem(
      grid,
      'Last run',
      lastRun
        ? new Date(lastRun.timestamp).toLocaleString()
        : 'Never',
    );
  }

  private renderCostSection(el: HTMLElement): void {
    const s = this.plugin.settings;
    const cost = estimateEmbedCost(
      s.totalTokensIndexed,
      s.openaiEmbedModel,
      s.embedProvider,
    );

    const section = el.createEl('div', { cls: 'vaultrag-cost-section' });
    section.createEl('h3', { text: 'Estimated embed cost' });
    const row = section.createEl('div', { cls: 'vaultrag-cost-row' });
    row.createEl('span', { text: 'Total tokens estimated: ' });
    row.createEl('strong', { text: String(s.totalTokensIndexed) });
    row.createEl('br');
    row.createEl('span', { text: 'Estimated cost: ' });
    row.createEl('strong', { text: cost });
  }

  private renderFileTable(el: HTMLElement, entries: FileEntry[]): void {
    const section = el.createEl('div', { cls: 'vaultrag-table-section' });
    section.createEl('h3', { text: `Files (${entries.length})` });

    if (entries.length === 0) {
      section.createEl('p', { text: 'No markdown files in vault.', cls: 'vaultrag-empty-note' });
      return;
    }

    const table = section.createEl('table', { cls: 'vaultrag-file-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    for (const col of ['File', 'Status', 'Chunks', 'Error']) {
      headerRow.createEl('th', { text: col });
    }

    const tbody = table.createEl('tbody');
    for (const entry of entries) {
      const tr = tbody.createEl('tr', { cls: `vaultrag-row-${entry.status}` });
      tr.createEl('td', { text: entry.path, cls: 'vaultrag-cell-path' });
      tr.createEl('td', { text: entry.status, cls: `vaultrag-status-${entry.status}` });
      tr.createEl('td', { text: entry.status === 'indexed' ? String(entry.chunkCount) : '—' });
      tr.createEl('td', { text: entry.errorMsg ?? '' });
    }
  }

  private renderReIndexButton(el: HTMLElement): void {
    const wrap = el.createEl('div', { cls: 'vaultrag-reindex-wrap' });
    const btn  = wrap.createEl('button', { text: 'Re-index all', cls: 'vaultrag-reindex-btn mod-cta' });
    btn.addEventListener('click', () => void this.reIndex());
  }

  private statItem(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createEl('div', { cls: 'vaultrag-stat-item' });
    item.createEl('span', { text: label, cls: 'vaultrag-stat-label' });
    item.createEl('strong', { text: value, cls: 'vaultrag-stat-value' });
  }
}
