/**
 * VaultIndexer tests.
 *
 * All Obsidian API calls (Vault, TFile) use the manual __mocks__/obsidian mock.
 * EmbedProvider, VectorStore, and StateAdapter are hand-rolled jest mocks so
 * each test can precisely control inputs and assert on outputs without any
 * filesystem or network activity.
 */

import { Vault, TFile } from 'obsidian';
import { VaultIndexer, DEFAULT_INDEXER_OPTIONS } from '../../rag/indexer';
import type { StateAdapter, IndexerState, IndexerOptions, ProgressEvent } from '../../rag/indexer';
import type { EmbedProvider } from '../../providers/base';
import type { VectorStore } from '../../store/base';

// ── Mock factories ─────────────────────────────────────────────────────────────

/** Build a TFile-like object with controllable path / mtime. */
function makeTFile(path: string, mtime = 1000): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace('.md', '');
  f.stat = { ctime: mtime, mtime, size: 100 };
  return f;
}

/** EmbedProvider that returns one [0.1, 0.2, 0.3] vector per input text. */
function makeEmbedProvider(): jest.Mocked<Pick<EmbedProvider, 'providerId' | 'embed'>> {
  return {
    providerId: 'openai' as const,
    embed: jest.fn().mockImplementation((texts: string[], _opts: unknown) =>
      Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
    ),
  };
}

/** VectorStore with all methods as no-op jest.fn()s. */
function makeStore(): jest.Mocked<VectorStore> {
  return {
    open: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    size: jest.fn().mockResolvedValue(0),
  };
}

/**
 * Stateful StateAdapter mock.
 * `save()` mutates internal state so subsequent `load()` calls see the latest
 * persisted version — mirroring real load/save behaviour across file loops.
 */
function makeStateAdapter(
  initial: IndexerState = { mtimes: {}, chunkIds: {} },
): jest.Mocked<StateAdapter> {
  let stored: IndexerState = {
    mtimes: { ...initial.mtimes },
    chunkIds: Object.fromEntries(
      Object.entries(initial.chunkIds).map(([k, v]) => [k, [...v]]),
    ),
  };

  return {
    load: jest.fn().mockImplementation(() =>
      Promise.resolve({
        mtimes: { ...stored.mtimes },
        chunkIds: Object.fromEntries(
          Object.entries(stored.chunkIds).map(([k, v]) => [k, [...v]]),
        ),
      }),
    ),
    save: jest.fn().mockImplementation((s: IndexerState) => {
      stored = {
        mtimes: { ...s.mtimes },
        chunkIds: Object.fromEntries(
          Object.entries(s.chunkIds).map(([k, v]) => [k, [...v]]),
        ),
      };
      return Promise.resolve();
    }),
  };
}

/** Vault that returns `files` from getMarkdownFiles and `content` from cachedRead. */
function makeVault(files: TFile[] = [], content = '# Hello\n\nShort content.'): Vault {
  const v = new Vault();
  (v.getMarkdownFiles as jest.Mock).mockReturnValue(files);
  (v.cachedRead as jest.Mock).mockResolvedValue(content);
  return v;
}

/** Build an indexer and return the collaborators for easy assertion. */
function makeIndexer(overrides: {
  vault?: Vault;
  embed?: ReturnType<typeof makeEmbedProvider>;
  store?: ReturnType<typeof makeStore>;
  state?: ReturnType<typeof makeStateAdapter>;
  opts?: Partial<IndexerOptions>;
} = {}) {
  const vault = overrides.vault ?? makeVault();
  const embed = overrides.embed ?? makeEmbedProvider();
  const store = overrides.store ?? makeStore();
  const state = overrides.state ?? makeStateAdapter();
  const opts = overrides.opts ?? {};

  const indexer = new VaultIndexer(
    vault,
    embed as unknown as EmbedProvider,
    store,
    state,
    opts,
  );

  return { indexer, vault, embed, store, state };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DEFAULT_INDEXER_OPTIONS', () => {
  it('has batchSize 64', () => expect(DEFAULT_INDEXER_OPTIONS.batchSize).toBe(64));
  it('has empty allowedFolders', () => expect(DEFAULT_INDEXER_OPTIONS.allowedFolders).toEqual([]));
});

// ── indexFile() ───────────────────────────────────────────────────────────────

describe('VaultIndexer.indexFile()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads content via vault.cachedRead', async () => {
    const file = makeTFile('notes/foo.md');
    const { indexer, vault } = makeIndexer({ vault: makeVault([file]) });
    await indexer.indexFile(file);
    expect(vault.cachedRead).toHaveBeenCalledWith(file);
  });

  it('calls embed with the chunk texts', async () => {
    const file = makeTFile('notes/foo.md');
    const { indexer, embed } = makeIndexer({ vault: makeVault([file]) });
    await indexer.indexFile(file);
    expect(embed.embed).toHaveBeenCalled();
    const [texts] = (embed.embed as jest.Mock).mock.calls[0] as [string[]];
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every(t => typeof t === 'string')).toBe(true);
  });

  it('upserts exactly one item per chunk', async () => {
    // '# Hello\n\nShort content.' produces 1 chunk at default chunkSize
    const file = makeTFile('notes/foo.md');
    const { indexer, store } = makeIndexer();
    await indexer.indexFile(file);
    expect(store.upsert).toHaveBeenCalledTimes(1);
  });

  it('chunk id is <filePath>:<chunkIndex>', async () => {
    const file = makeTFile('notes/foo.md');
    const { indexer, store } = makeIndexer();
    await indexer.indexFile(file);
    expect((store.upsert as jest.Mock).mock.calls[0][0].id).toBe('notes/foo.md:0');
  });

  it('chunk metadata carries filePath, text, and headings', async () => {
    const file = makeTFile('notes/foo.md');
    const { indexer, store } = makeIndexer();
    await indexer.indexFile(file);
    const { metadata } = (store.upsert as jest.Mock).mock.calls[0][0];
    expect(metadata.filePath).toBe('notes/foo.md');
    expect(typeof metadata.text).toBe('string');
    expect(typeof metadata.headings).toBe('string'); // JSON-serialised
  });

  it('persists state with updated mtime after indexing', async () => {
    const file = makeTFile('notes/foo.md', 5000);
    const state = makeStateAdapter();
    const { indexer } = makeIndexer({ state });
    await indexer.indexFile(file);
    expect(state.save).toHaveBeenCalled();
    const saved: IndexerState = (state.save as jest.Mock).mock.calls[0][0];
    expect(saved.mtimes['notes/foo.md']).toBe(5000);
  });

  it('persists chunk ids in state', async () => {
    const file = makeTFile('notes/foo.md');
    const state = makeStateAdapter();
    const { indexer } = makeIndexer({ state });
    await indexer.indexFile(file);
    const saved: IndexerState = (state.save as jest.Mock).mock.calls[0][0];
    expect(saved.chunkIds['notes/foo.md']).toEqual(['notes/foo.md:0']);
  });

  it('skips embed and upsert when mtime is unchanged', async () => {
    const file = makeTFile('notes/foo.md', 1000);
    const state = makeStateAdapter({ mtimes: { 'notes/foo.md': 1000 }, chunkIds: {} });
    const { indexer, embed, store } = makeIndexer({ state });
    await indexer.indexFile(file);
    expect(embed.embed).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('does not save state when mtime is unchanged (no write amplification)', async () => {
    const file = makeTFile('notes/foo.md', 1000);
    const state = makeStateAdapter({ mtimes: { 'notes/foo.md': 1000 }, chunkIds: {} });
    const { indexer } = makeIndexer({ state });
    await indexer.indexFile(file);
    expect(state.save).not.toHaveBeenCalled();
  });

  it('deletes old chunk ids before storing new ones when file changed', async () => {
    const file = makeTFile('notes/foo.md', 2000); // mtime differs from stored 1000
    const state = makeStateAdapter({
      mtimes: { 'notes/foo.md': 1000 },
      chunkIds: { 'notes/foo.md': ['notes/foo.md:0', 'notes/foo.md:1'] },
    });
    const { indexer, store } = makeIndexer({ state });
    await indexer.indexFile(file);
    expect(store.delete).toHaveBeenCalledWith('notes/foo.md:0');
    expect(store.delete).toHaveBeenCalledWith('notes/foo.md:1');
  });

  it('embed is called before delete (preserves old chunks on embed failure)', async () => {
    const file = makeTFile('notes/foo.md', 2000);
    const state = makeStateAdapter({
      mtimes: { 'notes/foo.md': 1000 },
      chunkIds: { 'notes/foo.md': ['notes/foo.md:0'] },
    });
    const callOrder: string[] = [];
    const embed = makeEmbedProvider();
    (embed.embed as jest.Mock).mockImplementation((texts: string[]) => {
      callOrder.push('embed');
      return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]));
    });
    const store = makeStore();
    (store.delete as jest.Mock).mockImplementation(() => {
      callOrder.push('delete');
      return Promise.resolve();
    });
    const { indexer } = makeIndexer({ state, embed, store });
    await indexer.indexFile(file);
    expect(callOrder.indexOf('embed')).toBeLessThan(callOrder.indexOf('delete'));
  });

  it('sends embed batches no larger than batchSize', async () => {
    const bigContent = '# Big\n\n' + 'word '.repeat(300); // ~304 tokens → 7 chunks at size 50
    const vault = makeVault([], bigContent);
    const embed = makeEmbedProvider();
    const file = makeTFile('notes/big.md');
    const { indexer } = makeIndexer({
      vault,
      embed,
      opts: { batchSize: 2, chunkerOptions: { chunkSize: 50, chunkOverlap: 5 } },
    });
    await indexer.indexFile(file);
    for (const [texts] of (embed.embed as jest.Mock).mock.calls as [string[]][]) {
      expect(texts.length).toBeLessThanOrEqual(2);
    }
  });

  it('upserts all chunks across multiple batches', async () => {
    const bigContent = '# Big\n\n' + 'word '.repeat(300);
    const vault = makeVault([], bigContent);
    const embed = makeEmbedProvider();
    const file = makeTFile('notes/big.md');
    const { indexer, store } = makeIndexer({
      vault,
      embed,
      opts: { batchSize: 2, chunkerOptions: { chunkSize: 50, chunkOverlap: 5 } },
    });
    await indexer.indexFile(file);
    // 7 chunks → 7 upserts
    expect(store.upsert).toHaveBeenCalledTimes(7);
  });

  it('assigns sequential global chunk ids across batch boundaries', async () => {
    const bigContent = '# Big\n\n' + 'word '.repeat(300);
    const vault = makeVault([], bigContent);
    const embed = makeEmbedProvider();
    const file = makeTFile('notes/big.md');
    const { indexer, store } = makeIndexer({
      vault,
      embed,
      opts: { batchSize: 2, chunkerOptions: { chunkSize: 50, chunkOverlap: 5 } },
    });
    await indexer.indexFile(file);
    const ids = (store.upsert as jest.Mock).mock.calls.map(
      ([item]: [{ id: string }]) => item.id,
    );
    expect(ids).toEqual([
      'notes/big.md:0',
      'notes/big.md:1',
      'notes/big.md:2',
      'notes/big.md:3',
      'notes/big.md:4',
      'notes/big.md:5',
      'notes/big.md:6',
    ]);
  });
});

// ── indexAll() ────────────────────────────────────────────────────────────────

describe('VaultIndexer.indexAll()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads every markdown file returned by the vault', async () => {
    const files = [makeTFile('a.md'), makeTFile('b.md')];
    const vault = makeVault(files);
    const { indexer } = makeIndexer({ vault });
    await indexer.indexAll();
    expect(vault.cachedRead).toHaveBeenCalledTimes(2);
  });

  it('returns indexed count equal to number of files processed', async () => {
    const files = [makeTFile('a.md'), makeTFile('b.md')];
    const vault = makeVault(files);
    const { indexer } = makeIndexer({ vault });
    const result = await indexer.indexAll();
    expect(result.indexed).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('skips files whose mtime is unchanged and counts them separately', async () => {
    const file = makeTFile('a.md', 1000);
    const vault = makeVault([file]);
    const state = makeStateAdapter({ mtimes: { 'a.md': 1000 }, chunkIds: {} });
    const { indexer } = makeIndexer({ vault, state });
    const result = await indexer.indexAll();
    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
  });

  it('only processes files inside allowedFolders', async () => {
    const allowed = makeTFile('notes/keep.md');
    const blocked = makeTFile('archive/skip.md');
    const vault = makeVault([allowed, blocked]);
    const { indexer } = makeIndexer({
      vault,
      opts: { allowedFolders: ['notes/'] },
    });
    await indexer.indexAll();
    expect(vault.cachedRead).toHaveBeenCalledTimes(1);
    expect((vault.cachedRead as jest.Mock).mock.calls[0][0]).toBe(allowed);
  });

  it('indexes all files when allowedFolders is empty', async () => {
    const files = [makeTFile('a/b.md'), makeTFile('c/d.md')];
    const vault = makeVault(files);
    const { indexer } = makeIndexer({ vault, opts: { allowedFolders: [] } });
    await indexer.indexAll();
    expect(vault.cachedRead).toHaveBeenCalledTimes(2);
  });

  it('continues processing remaining files when one embed call throws', async () => {
    const file1 = makeTFile('fail.md');
    const file2 = makeTFile('ok.md');
    const vault = makeVault([file1, file2]);
    (vault.cachedRead as jest.Mock)
      .mockResolvedValueOnce('# Fail\n\nContent.')
      .mockResolvedValueOnce('# OK\n\nContent.');
    const embed = makeEmbedProvider();
    (embed.embed as jest.Mock)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockImplementation((texts: string[], _opts: unknown) =>
        Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
      );
    const { indexer } = makeIndexer({ vault, embed });
    await expect(indexer.indexAll()).resolves.not.toThrow();
    expect(vault.cachedRead).toHaveBeenCalledTimes(2);
  });

  it('collects errors for failed files without rethrowing', async () => {
    const file1 = makeTFile('fail.md');
    const vault = makeVault([file1], '# Fail\n\nContent.');
    const embed = makeEmbedProvider();
    (embed.embed as jest.Mock).mockRejectedValue(new Error('API error'));
    const { indexer } = makeIndexer({ vault, embed });
    const result = await indexer.indexAll();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('fail.md');
    expect(result.errors[0].error).toBeInstanceOf(Error);
  });

  it('counts failed files in errors, not in indexed', async () => {
    const files = [makeTFile('fail.md'), makeTFile('ok.md')];
    const vault = makeVault(files);
    (vault.cachedRead as jest.Mock)
      .mockResolvedValueOnce('# Fail\n\nContent.')
      .mockResolvedValueOnce('# OK\n\nContent.');
    const embed = makeEmbedProvider();
    (embed.embed as jest.Mock)
      .mockRejectedValueOnce(new Error('err'))
      .mockImplementation((texts: string[], _opts: unknown) =>
        Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
      );
    const { indexer } = makeIndexer({ vault, embed });
    const result = await indexer.indexAll();
    expect(result.indexed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('fires onProgress once per file with correct done/total', async () => {
    const files = [makeTFile('a.md'), makeTFile('b.md')];
    const vault = makeVault(files);
    const onProgress = jest.fn();
    const { indexer } = makeIndexer({ vault });
    await indexer.indexAll(onProgress);
    expect(onProgress).toHaveBeenCalledTimes(2);
    const first: ProgressEvent = onProgress.mock.calls[0][0];
    const last: ProgressEvent = onProgress.mock.calls[1][0];
    expect(first.done).toBe(1);
    expect(first.total).toBe(2);
    expect(last.done).toBe(2);
    expect(last.total).toBe(2);
  });

  it('onProgress carries accumulated errors for failed files', async () => {
    const files = [makeTFile('fail.md'), makeTFile('ok.md')];
    const vault = makeVault(files);
    (vault.cachedRead as jest.Mock)
      .mockResolvedValueOnce('# Fail\n\nContent.')
      .mockResolvedValueOnce('# OK\n\nContent.');
    const embed = makeEmbedProvider();
    (embed.embed as jest.Mock)
      .mockRejectedValueOnce(new Error('err'))
      .mockImplementation((texts: string[], _opts: unknown) =>
        Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
      );
    const onProgress = jest.fn();
    const { indexer } = makeIndexer({ vault, embed });
    await indexer.indexAll(onProgress);
    // After file1 (failed): errors.length = 1
    expect((onProgress.mock.calls[0][0] as ProgressEvent).errors).toHaveLength(1);
    // After file2 (ok): still 1 error total
    expect((onProgress.mock.calls[1][0] as ProgressEvent).errors).toHaveLength(1);
  });

  it('resolves with empty errors array when all files succeed', async () => {
    const files = [makeTFile('a.md'), makeTFile('b.md')];
    const vault = makeVault(files);
    const { indexer } = makeIndexer({ vault });
    const result = await indexer.indexAll();
    expect(result.errors).toEqual([]);
  });
});

// ── removeFile() ──────────────────────────────────────────────────────────────

describe('VaultIndexer.removeFile()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes every chunk id stored for the given file', async () => {
    const state = makeStateAdapter({
      mtimes: { 'notes/foo.md': 1000 },
      chunkIds: { 'notes/foo.md': ['notes/foo.md:0', 'notes/foo.md:1', 'notes/foo.md:2'] },
    });
    const store = makeStore();
    const { indexer } = makeIndexer({ state, store });
    await indexer.removeFile('notes/foo.md');
    expect(store.delete).toHaveBeenCalledWith('notes/foo.md:0');
    expect(store.delete).toHaveBeenCalledWith('notes/foo.md:1');
    expect(store.delete).toHaveBeenCalledWith('notes/foo.md:2');
    expect(store.delete).toHaveBeenCalledTimes(3);
  });

  it('removes the file entry from mtimes in persisted state', async () => {
    const state = makeStateAdapter({
      mtimes: { 'notes/foo.md': 1000 },
      chunkIds: { 'notes/foo.md': ['notes/foo.md:0'] },
    });
    const { indexer } = makeIndexer({ state });
    await indexer.removeFile('notes/foo.md');
    const saved: IndexerState = (state.save as jest.Mock).mock.calls[0][0];
    expect(saved.mtimes['notes/foo.md']).toBeUndefined();
  });

  it('removes the file entry from chunkIds in persisted state', async () => {
    const state = makeStateAdapter({
      mtimes: { 'notes/foo.md': 1000 },
      chunkIds: { 'notes/foo.md': ['notes/foo.md:0'] },
    });
    const { indexer } = makeIndexer({ state });
    await indexer.removeFile('notes/foo.md');
    const saved: IndexerState = (state.save as jest.Mock).mock.calls[0][0];
    expect(saved.chunkIds['notes/foo.md']).toBeUndefined();
  });

  it('leaves other files untouched when removing one', async () => {
    const state = makeStateAdapter({
      mtimes: { 'a.md': 1000, 'b.md': 2000 },
      chunkIds: { 'a.md': ['a.md:0'], 'b.md': ['b.md:0'] },
    });
    const { indexer } = makeIndexer({ state });
    await indexer.removeFile('a.md');
    const saved: IndexerState = (state.save as jest.Mock).mock.calls[0][0];
    expect(saved.mtimes['b.md']).toBe(2000);
    expect(saved.chunkIds['b.md']).toEqual(['b.md:0']);
  });

  it('resolves without error when filePath is not in state', async () => {
    const { indexer } = makeIndexer();
    await expect(indexer.removeFile('does/not/exist.md')).resolves.not.toThrow();
  });

  it('saves state even when the file had no chunks', async () => {
    const { indexer, state } = makeIndexer();
    await indexer.removeFile('ghost.md');
    expect(state.save).toHaveBeenCalledTimes(1);
  });
});
