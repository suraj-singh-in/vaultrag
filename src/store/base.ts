// ── Vector store public types and interface ───────────────────────────────────

/**
 * Allowed value types for item metadata.
 * Constrained to vectra's `MetadataTypes` so implementations can store
 * metadata without an extra serialisation step.
 */
export type ItemMetadata = Record<string, string | number | boolean>;

/** A single item stored in the vector index. */
export interface VectorItem<M extends ItemMetadata = ItemMetadata> {
  /** Stable identifier (e.g. `<filePath>:<chunkIndex>`). */
  id: string;
  /** Embedding vector produced by an {@link EmbedProvider}. */
  vector: number[];
  /** Arbitrary structured payload returned with every search hit. */
  metadata: M;
}

/** One hit returned by {@link VectorStore.search}. */
export interface SearchResult<M extends ItemMetadata = ItemMetadata> {
  item: VectorItem<M>;
  /** Cosine similarity in the range [−1, 1]. Higher is more similar. */
  score: number;
}

/**
 * Minimal vector store contract.
 *
 * Implementations must be opened before use and may be closed to release
 * resources.  All mutation operations (`upsert`, `delete`) are immediately
 * durable — no separate flush/commit step is required by callers.
 */
export interface VectorStore<M extends ItemMetadata = ItemMetadata> {
  /**
   * Initialises the store, creating persistent storage if it does not yet
   * exist.  Must be called before any other method.
   * @throws When the store is corrupt and the caller declines to rebuild.
   */
  open(): Promise<void>;

  /** Releases any held resources.  Safe to call when already closed. */
  close(): Promise<void>;

  /**
   * Inserts or replaces the item with the given `id`.
   * Idempotent: calling `upsert` twice with the same `id` keeps only the
   * most-recent version.
   */
  upsert(item: VectorItem<M>): Promise<void>;

  /**
   * Removes the item with the given `id`.
   * Resolves without error when `id` does not exist.
   */
  delete(id: string): Promise<void>;

  /**
   * Returns at most `topK` items whose vectors are most similar to `vector`,
   * sorted by descending cosine similarity.
   * Returns `[]` when the index is empty or `topK` is 0.
   */
  search(vector: number[], topK: number): Promise<SearchResult<M>[]>;

  /** Returns the total number of items currently in the index. */
  size(): Promise<number>;
}
