import type { TFile, Vault } from 'obsidian';
import type { EmbedProvider, EmbedOptions } from '../providers/base';
import type { VectorStore, ItemMetadata } from '../store/base';
import { chunkNote } from './chunker';
import type { ChunkerOptions } from './chunker.types';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Persisted delta-index state.
 * Stored alongside the vectra index in `.obsidian/vaultrag-index/`.
 */
export interface IndexerState {
  /** filePath → mtime at the time the file was last successfully indexed. */
  mtimes: Record<string, number>;
  /** filePath → ordered list of vector-store item ids for that file's chunks. */
  chunkIds: Record<string, string[]>;
}

/**
 * Thin persistence layer for {@link IndexerState}.
 * In production this wraps `plugin.loadData / saveData`; in tests it is a
 * hand-rolled jest mock so no filesystem is touched.
 */
export interface StateAdapter {
  load(): Promise<IndexerState>;
  save(state: IndexerState): Promise<void>;
}

/** Configuration knobs for {@link VaultIndexer}. */
export interface IndexerOptions {
  /**
   * Maximum number of chunks sent to the embedding API in one request.
   * @default 64
   */
  batchSize: number;
  /**
   * Only index files whose path starts with one of these prefixes.
   * Empty array → index all markdown files in the vault.
   * @default []
   */
  allowedFolders: string[];
  /**
   * Forwarded verbatim to {@link chunkNote}.
   * @default {}
   */
  chunkerOptions: Partial<ChunkerOptions>;
  /**
   * Embedding model identifier forwarded to {@link EmbedProvider.embed}.
   * @default 'text-embedding-3-small'
   */
  embedModel: string;
}

/** Snapshot emitted by {@link VaultIndexer.indexAll} after each file. */
export interface ProgressEvent {
  /** Number of files processed so far (including errors and skips). */
  done: number;
  /** Total files to process in this run. */
  total: number;
  /** Path of the file just processed. */
  currentFile: string;
  /** Accumulated list of failures so far. */
  errors: Array<{ file: string; error: Error }>;
}

/** Summary returned by {@link VaultIndexer.indexAll}. */
export interface IndexAllResult {
  /** Files that were re-embedded (mtime changed or new). */
  indexed: number;
  /** Files skipped because their mtime was unchanged. */
  skipped: number;
  /** Per-file errors that did not abort the run. */
  errors: Array<{ file: string; error: Error }>;
}

export const DEFAULT_INDEXER_OPTIONS: IndexerOptions = {
  batchSize: 64,
  allowedFolders: [],
  chunkerOptions: {},
  embedModel: 'text-embedding-3-small',
};

// ── Internal metadata type ────────────────────────────────────────────────────

/** Shape of metadata stored per chunk in the vector index. */
type ChunkMeta = {
  text: string;
  filePath: string;
  /** JSON-serialised `string[]` breadcrumb — satisfies ItemMetadata constraint. */
  headings: string;
  chunkIndex: number;
};

// ── VaultIndexer ──────────────────────────────────────────────────────────────

/**
 * Orchestrates the full scan → chunk → embed → store pipeline.
 *
 * Delta indexing: each file is compared by `TFile.stat.mtime` against the
 * stored value.  Unchanged files are skipped without any embed API call.
 *
 * Embed safety: all batches for a file are fetched *before* the old chunks
 * are deleted, so a failed embed call leaves the existing store entries intact.
 */
export class VaultIndexer {
  private readonly opts: IndexerOptions;

  constructor(
    private readonly vault: Vault,
    private readonly embedProvider: EmbedProvider,
    private readonly store: VectorStore<ItemMetadata>,
    private readonly stateAdapter: StateAdapter,
    opts?: Partial<IndexerOptions>,
  ) {
    this.opts = { ...DEFAULT_INDEXER_OPTIONS, ...opts };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Indexes a single file.
   *
   * @returns `true` when the file was (re-)indexed, `false` when skipped.
   * @throws  Propagates any error from the embed provider or vector store.
   */
  async indexFile(file: TFile): Promise<boolean> {
    const state = await this.stateAdapter.load();

    // Fast-path: mtime unchanged → nothing to do
    if (state.mtimes[file.path] === file.stat.mtime) return false;

    const content = await this.vault.cachedRead(file);
    const chunks = chunkNote(content, file.path, this.opts.chunkerOptions);

    if (chunks.length === 0) {
      // File became empty — purge old chunks and update state
      await this.deleteOldChunks(state, file.path);
      state.mtimes[file.path] = file.stat.mtime;
      state.chunkIds[file.path] = [];
      await this.stateAdapter.save(state);
      return true;
    }

    // ── Embed first (before touching the store) ──────────────────────────────
    // If the provider throws here, the old chunks in the store are unaffected.
    const allVectors = await this.embedAllBatches(chunks.map(c => c.text));

    // ── Now it is safe to replace the old entries ────────────────────────────
    await this.deleteOldChunks(state, file.path);

    const newIds: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const id = `${file.path}:${i}`;
      const meta: ChunkMeta = {
        text: chunks[i].text,
        filePath: file.path,
        headings: JSON.stringify(chunks[i].metadata.headings),
        chunkIndex: i,
      };
      await this.store.upsert({ id, vector: allVectors[i], metadata: meta });
      newIds.push(id);
    }

    state.mtimes[file.path] = file.stat.mtime;
    state.chunkIds[file.path] = newIds;
    await this.stateAdapter.save(state);

    return true;
  }

  /**
   * Indexes all allowed markdown files in the vault sequentially.
   *
   * Errors on individual files are caught and collected — a single failure
   * never aborts the run.  The optional `onProgress` callback fires after
   * each file and receives a live snapshot of progress and accumulated errors.
   */
  async indexAll(
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<IndexAllResult> {
    const files = this.vault.getMarkdownFiles().filter(f => this.isAllowed(f));
    const total = files.length;
    let indexed = 0;
    let skipped = 0;
    const errors: Array<{ file: string; error: Error }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const wasIndexed = await this.indexFile(file);
        if (wasIndexed) indexed++;
        else skipped++;
      } catch (err) {
        errors.push({ file: file.path, error: err as Error });
      }

      onProgress?.({
        done: i + 1,
        total,
        currentFile: file.path,
        errors: [...errors],
      });
    }

    return { indexed, skipped, errors };
  }

  /**
   * Removes all vector-store entries for `filePath` and clears its entry
   * from the persisted delta-index state.
   * Safe to call for paths that were never indexed.
   */
  async removeFile(filePath: string): Promise<void> {
    const state = await this.stateAdapter.load();
    await this.deleteOldChunks(state, filePath);
    delete state.mtimes[filePath];
    delete state.chunkIds[filePath];
    await this.stateAdapter.save(state);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Returns `true` when `file` should be processed in this indexing run. */
  private isAllowed(file: TFile): boolean {
    if (this.opts.allowedFolders.length === 0) return true;
    return this.opts.allowedFolders.some(folder => file.path.startsWith(folder));
  }

  /** Deletes every chunk id currently tracked for `filePath` from the store. */
  private async deleteOldChunks(state: IndexerState, filePath: string): Promise<void> {
    const ids = state.chunkIds[filePath] ?? [];
    for (const id of ids) {
      await this.store.delete(id);
    }
  }

  /**
   * Calls the embed provider in batches of `opts.batchSize` and returns a
   * flat array of vectors in the same order as `texts`.
   */
  private async embedAllBatches(texts: string[]): Promise<number[][]> {
    const { batchSize } = this.opts;
    const embedOpts: EmbedOptions = { model: this.opts.embedModel };
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vectors = await this.embedProvider.embed(batch, embedOpts);
      allVectors.push(...vectors);
    }
    return allVectors;
  }
}
