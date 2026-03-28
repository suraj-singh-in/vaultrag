import { LocalIndex } from 'vectra';
import type { MetadataTypes } from 'vectra';
import { rm } from 'fs/promises';
import type { VectorStore, VectorItem, SearchResult } from './base';

// ── Options ───────────────────────────────────────────────────────────────────

export interface VectraStoreOptions<M extends Record<string, MetadataTypes> = Record<string, MetadataTypes>> {
  /**
   * Absolute filesystem path to the folder where `index.json` will be stored.
   * The folder is created automatically if it does not yet exist.
   * Recommended location: `<vault>/.obsidian/vaultrag-index/`
   */
  indexPath: string;

  /**
   * Called when the index file exists but cannot be parsed (corrupt data).
   * Resolve `true` to wipe the index and start fresh; resolve `false` (or
   * omit this handler entirely) to abort — `open()` will rethrow the error.
   */
  onCorrupt?: (error: Error) => Promise<boolean>;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Vectra-backed persistent vector store.
 *
 * All writes are immediately durable (vectra rewrites `index.json` atomically
 * inside each `beginUpdate / endUpdate` pair).  No explicit flush is needed.
 *
 * Call {@link open} before any other method.  {@link close} is a no-op for
 * vectra but exists so the class satisfies {@link VectorStore} and callers
 * can be written against the interface without knowing the implementation.
 */
export class VectraStore<
  M extends Record<string, MetadataTypes> = Record<string, MetadataTypes>,
> implements VectorStore<M>
{
  private index: LocalIndex<M> | null = null;

  constructor(private readonly opts: VectraStoreOptions<M>) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Opens the index, creating it on disk if it does not yet exist.
   * If the index file is corrupt, delegates to {@link VectraStoreOptions.onCorrupt}.
   */
  async open(): Promise<void> {
    const idx = new LocalIndex<M>(this.opts.indexPath);

    if (!await idx.isIndexCreated()) {
      await idx.createIndex({ version: 1 });
      this.index = idx;
      return;
    }

    // Eagerly load the index to surface any corruption before callers proceed.
    try {
      await idx.listItems();
    } catch (err) {
      await this.handleCorruption(err as Error);
      return;
    }

    this.index = idx;
  }

  /** No-op for vectra — included for interface compliance. */
  async close(): Promise<void> {
    this.index = null;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Inserts or replaces the item with the given `id`.
   * Safe to call repeatedly with the same id (last write wins).
   */
  async upsert(item: VectorItem<M>): Promise<void> {
    const idx = this.assertOpen();
    await idx.beginUpdate();
    await idx.upsertItem({ id: item.id, vector: item.vector, metadata: item.metadata });
    await idx.endUpdate();
  }

  /**
   * Removes the item with the given `id`.
   * Resolves without error if the id does not exist.
   */
  async delete(id: string): Promise<void> {
    const idx = this.assertOpen();
    await idx.beginUpdate();
    await idx.deleteItem(id);
    await idx.endUpdate();
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Returns at most `topK` items sorted by descending cosine similarity.
   *
   * Results with a non-finite score (e.g. caused by a zero-norm query vector)
   * are filtered out so callers always receive well-formed `number` scores.
   */
  async search(vector: number[], topK: number): Promise<SearchResult<M>[]> {
    if (topK <= 0) return [];
    const idx = this.assertOpen();
    // Second argument is the BM25 query string; '' disables hybrid search.
    const raw = await idx.queryItems<M>(vector, '', topK);
    return raw
      .filter(r => Number.isFinite(r.score))
      .map(r => ({
        item: {
          id: r.item.id,
          vector: r.item.vector ?? [],
          metadata: r.item.metadata,
        },
        score: r.score as number,
      }));
  }

  // ── Metadata ───────────────────────────────────────────────────────────────

  /** Returns the total number of items currently in the index. */
  async size(): Promise<number> {
    const idx = this.assertOpen();
    const items = await idx.listItems();
    return items.length;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertOpen(): LocalIndex<M> {
    if (!this.index) {
      throw new Error('VectraStore: call open() before using the store.');
    }
    return this.index;
  }

  /**
   * Invoked when `index.json` exists but cannot be parsed.
   * Delegates the rebuild/abort decision to `opts.onCorrupt`.
   */
  private async handleCorruption(err: Error): Promise<void> {
    const rebuild = this.opts.onCorrupt ? await this.opts.onCorrupt(err) : false;

    if (!rebuild) {
      throw err;
    }

    // Wipe the index directory and recreate a clean index.
    await rm(this.opts.indexPath, { recursive: true, force: true });
    const fresh = new LocalIndex<M>(this.opts.indexPath);
    await fresh.createIndex({ version: 1 });
    this.index = fresh;
  }
}
