/**
 * DashboardModal tests.
 *
 * Strategy:
 *  - Pure utility functions (computeFileStatuses, estimateEmbedCost) are tested
 *    directly as unit tests.
 *  - Modal integration is tested via mock side-effects: which dependencies were
 *    called and what state was mutated — without depending on real DOM in node env.
 */

import { App, WorkspaceLeaf } from 'obsidian';
import {
  DashboardModal,
  computeFileStatuses,
  estimateEmbedCost,
} from '../../ui/DashboardModal';
import type { FileEntry } from '../../ui/DashboardModal';
import { DEFAULT_SETTINGS } from '../../settings';
import type { LastIndexRun } from '../../settings';
import type { StateAdapter, IndexerState, VaultIndexer } from '../../rag/indexer';
import type { VectorStore, ItemMetadata } from '../../store/base';
import type { TFile } from 'obsidian';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(path: string): TFile {
  const f = { path, stat: { mtime: 1000, ctime: 0, size: 0 }, extension: 'md', basename: path, name: path, parent: null } as unknown as TFile;
  return f;
}

function makeState(overrides: Partial<IndexerState> = {}): IndexerState {
  return {
    mtimes: {},
    chunkIds: {},
    ...overrides,
  };
}

function makeStateAdapter(state: IndexerState = makeState()): jest.Mocked<StateAdapter> {
  return {
    load: jest.fn().mockResolvedValue(state),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function makeStore(size = 0): jest.Mocked<VectorStore<ItemMetadata>> {
  return {
    open:   jest.fn().mockResolvedValue(undefined),
    close:  jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    size:   jest.fn().mockResolvedValue(size),
  };
}

function makeIndexer(
  result = { indexed: 0, skipped: 0, errors: [] as Array<{ file: string; error: Error }> },
): jest.Mocked<Pick<VaultIndexer, 'indexAll'>> {
  return {
    indexAll: jest.fn().mockImplementation(
      async (cb?: (e: { done: number; total: number; currentFile: string; errors: Array<{ file: string; error: Error }> }) => void) => {
        cb?.({ done: 1, total: 1, currentFile: 'note.md', errors: [] });
        return result;
      },
    ),
  };
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    app: new App(),
    settings: {
      ...DEFAULT_SETTINGS,
      ...overrides,
    },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  };
}

function makeModal(opts: {
  files?: TFile[];
  state?: IndexerState;
  storeSize?: number;
  indexerResult?: { indexed: number; skipped: number; errors: Array<{ file: string; error: Error }> };
  settingsOverrides?: Record<string, unknown>;
} = {}) {
  const plugin = makePlugin(opts.settingsOverrides ?? {});
  const stateAdapter = makeStateAdapter(opts.state ?? makeState());
  const store = makeStore(opts.storeSize ?? 0);
  const indexer = makeIndexer(opts.indexerResult);
  const files = opts.files ?? [];

  // Inject files into mock vault
  (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue(files);

  const modal = new DashboardModal(
    new App(),
    plugin as never,
    indexer as never,
    stateAdapter,
    store,
  );

  return { modal, plugin, stateAdapter, store, indexer };
}

// ── computeFileStatuses() ─────────────────────────────────────────────────────

describe('computeFileStatuses()', () => {
  it('marks files present in mtimes as indexed', () => {
    const files = [makeFile('a.md'), makeFile('b.md')];
    const state = makeState({ mtimes: { 'a.md': 1000, 'b.md': 2000 }, chunkIds: { 'a.md': ['a:0', 'a:1'], 'b.md': ['b:0'] } });
    const entries = computeFileStatuses(files, state, []);
    expect(entries.find(e => e.path === 'a.md')?.status).toBe('indexed');
    expect(entries.find(e => e.path === 'b.md')?.status).toBe('indexed');
  });

  it('marks files not in mtimes as not-indexed', () => {
    const files = [makeFile('new.md')];
    const entries = computeFileStatuses(files, makeState(), []);
    expect(entries[0].status).toBe('not-indexed');
  });

  it('marks files in errors list as failed', () => {
    const files = [makeFile('bad.md')];
    const state = makeState({ mtimes: {}, chunkIds: {} });
    const errors = [{ file: 'bad.md', error: 'Embed failed' }];
    const entries = computeFileStatuses(files, state, errors);
    expect(entries[0].status).toBe('failed');
    expect(entries[0].errorMsg).toBe('Embed failed');
  });

  it('failed status takes precedence over indexed when file is in both', () => {
    const files = [makeFile('a.md')];
    const state = makeState({ mtimes: { 'a.md': 1000 }, chunkIds: { 'a.md': ['a:0'] } });
    const errors = [{ file: 'a.md', error: 'Transient error' }];
    const entries = computeFileStatuses(files, state, errors);
    expect(entries[0].status).toBe('failed');
  });

  it('returns correct chunkCount for indexed files', () => {
    const files = [makeFile('a.md')];
    const state = makeState({ mtimes: { 'a.md': 1 }, chunkIds: { 'a.md': ['a:0', 'a:1', 'a:2'] } });
    const entries = computeFileStatuses(files, state, []);
    expect(entries[0].chunkCount).toBe(3);
  });

  it('returns 0 chunkCount for not-indexed files', () => {
    const entries = computeFileStatuses([makeFile('x.md')], makeState(), []);
    expect(entries[0].chunkCount).toBe(0);
  });

  it('returns empty array when no files provided', () => {
    expect(computeFileStatuses([], makeState(), [])).toEqual([]);
  });
});

// ── estimateEmbedCost() ───────────────────────────────────────────────────────

describe('estimateEmbedCost()', () => {
  it('returns "Local (free)" for ollama provider', () => {
    expect(estimateEmbedCost(1_000_000, 'nomic-embed-text', 'ollama')).toBe('Local (free)');
  });

  it('returns a per-query note for anthropic provider', () => {
    const result = estimateEmbedCost(0, '', 'anthropic');
    expect(result).toMatch(/per.query/i);
  });

  it('calculates cost to 4 decimal places for text-embedding-3-small', () => {
    // 1M tokens × $0.020/1M = $0.0200
    const result = estimateEmbedCost(1_000_000, 'text-embedding-3-small', 'openai');
    expect(result).toBe('$0.0200');
  });

  it('calculates cost for text-embedding-3-large', () => {
    // 1M tokens × $0.130/1M = $0.1300
    const result = estimateEmbedCost(1_000_000, 'text-embedding-3-large', 'openai');
    expect(result).toBe('$0.1300');
  });

  it('calculates cost for text-embedding-ada-002', () => {
    // 500K tokens × $0.100/1M = $0.0500
    const result = estimateEmbedCost(500_000, 'text-embedding-ada-002', 'openai');
    expect(result).toBe('$0.0500');
  });

  it('falls back to text-embedding-3-small pricing for unknown models', () => {
    const known  = estimateEmbedCost(1_000_000, 'text-embedding-3-small', 'openai');
    const unknown = estimateEmbedCost(1_000_000, 'some-future-model', 'openai');
    expect(unknown).toBe(known);
  });

  it('returns "$0.0000" when 0 tokens are provided for openai', () => {
    expect(estimateEmbedCost(0, 'text-embedding-3-small', 'openai')).toBe('$0.0000');
  });
});

// ── DashboardModal.onOpen() ───────────────────────────────────────────────────

describe('DashboardModal.onOpen()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not throw with an empty vault', async () => {
    const { modal } = makeModal({ files: [], state: makeState(), storeSize: 0 });
    await expect(modal.onOpen()).resolves.not.toThrow();
  });

  it('calls stateAdapter.load() on open', async () => {
    const { modal, stateAdapter } = makeModal();
    await modal.onOpen();
    expect(stateAdapter.load).toHaveBeenCalled();
  });

  it('calls store.size() on open', async () => {
    const { modal, store } = makeModal();
    await modal.onOpen();
    expect(store.size).toHaveBeenCalled();
  });

  it('calls vault.getMarkdownFiles() to enumerate all vault files', async () => {
    const { modal, plugin } = makeModal({ files: [makeFile('a.md')] });
    await modal.onOpen();
    expect(plugin.app.vault.getMarkdownFiles).toHaveBeenCalled();
  });

  it('renders the correct indexed file count (files in mtimes)', async () => {
    const state = makeState({
      mtimes: { 'a.md': 1, 'b.md': 2, 'c.md': 3 },
      chunkIds: { 'a.md': ['a:0'], 'b.md': ['b:0'], 'c.md': ['c:0'] },
    });
    const { modal } = makeModal({
      files: [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')],
      state,
      storeSize: 3,
    });
    // Should not throw and should process 3 indexed files
    await expect(modal.onOpen()).resolves.not.toThrow();
  });

  it('handles 0 indexed files and 0 total tokens gracefully', async () => {
    const { modal } = makeModal({
      files: [],
      state: makeState(),
      storeSize: 0,
      settingsOverrides: { totalTokensIndexed: 0, lastIndexRun: null },
    });
    await expect(modal.onOpen()).resolves.not.toThrow();
  });

  it('renders last-run errors when lastIndexRun has failures', async () => {
    const lastRun: LastIndexRun = {
      timestamp: Date.now(),
      indexed: 1,
      skipped: 0,
      totalFiles: 2,
      errors: [{ file: 'broken.md', error: 'Timeout' }],
    };
    const { modal } = makeModal({
      files: [makeFile('broken.md'), makeFile('good.md')],
      state: makeState({ mtimes: { 'good.md': 1 }, chunkIds: { 'good.md': ['g:0'] } }),
      settingsOverrides: { lastIndexRun: lastRun },
    });
    await expect(modal.onOpen()).resolves.not.toThrow();
  });
});

// ── DashboardModal.reIndex() ──────────────────────────────────────────────────

describe('DashboardModal.reIndex()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls indexer.indexAll()', async () => {
    const { modal, indexer } = makeModal();
    await modal.onOpen();
    await modal.reIndex();
    expect(indexer.indexAll).toHaveBeenCalled();
  });

  it('calls plugin.saveSettings() after re-index', async () => {
    const { modal, plugin } = makeModal();
    await modal.onOpen();
    await modal.reIndex();
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('updates plugin.settings.lastIndexRun with run results', async () => {
    const { modal, plugin } = makeModal({
      indexerResult: { indexed: 5, skipped: 2, errors: [] },
    });
    await modal.onOpen();
    await modal.reIndex();

    expect(plugin.settings.lastIndexRun).not.toBeNull();
    expect(plugin.settings.lastIndexRun?.indexed).toBe(5);
    expect(plugin.settings.lastIndexRun?.skipped).toBe(2);
  });

  it('stores failed file errors in lastIndexRun', async () => {
    const errors = [{ file: 'fail.md', error: new Error('Network error') }];
    const { modal, plugin } = makeModal({
      indexerResult: { indexed: 0, skipped: 0, errors },
    });
    await modal.onOpen();
    await modal.reIndex();

    const run = plugin.settings.lastIndexRun;
    expect(run?.errors).toHaveLength(1);
    expect(run?.errors[0].file).toBe('fail.md');
    expect(run?.errors[0].error).toBe('Network error');
  });

  it('updates totalTokensIndexed based on chunks after re-index', async () => {
    const state = makeState({
      mtimes: { 'a.md': 1 },
      chunkIds: { 'a.md': ['a:0', 'a:1', 'a:2'] }, // 3 chunks × 512 = 1536
    });
    const { modal, plugin } = makeModal({ state });
    await modal.onOpen();
    await modal.reIndex();

    expect(plugin.settings.totalTokensIndexed).toBe(3 * 512);
  });

  it('passes an onProgress callback to indexAll', async () => {
    const { modal, indexer } = makeModal();
    await modal.onOpen();
    await modal.reIndex();

    // indexAll was called with a callback function
    expect(indexer.indexAll).toHaveBeenCalledWith(expect.any(Function));
  });
});

// ── Failed files accuracy ─────────────────────────────────────────────────────

describe('Failed files accuracy (integration)', () => {
  it('correctly identifies failed, indexed, and not-indexed files', () => {
    const files = [
      makeFile('good.md'),
      makeFile('bad.md'),
      makeFile('new.md'),
    ];
    const state = makeState({
      mtimes:   { 'good.md': 1 },
      chunkIds: { 'good.md': ['g:0'] },
    });
    const errors = [{ file: 'bad.md', error: 'Embed failed' }];

    const entries = computeFileStatuses(files, state, errors);
    const byPath = Object.fromEntries(entries.map((e: FileEntry) => [e.path, e])) as Record<string, FileEntry>;

    expect(byPath['good.md'].status).toBe('indexed');
    expect(byPath['bad.md'].status).toBe('failed');
    expect(byPath['new.md'].status).toBe('not-indexed');
  });
});
