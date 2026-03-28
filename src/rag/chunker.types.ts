// ── Chunker public types ──────────────────────────────────────────────────────

/**
 * Positional and structural metadata attached to every chunk.
 *
 * `headings` is the breadcrumb of ATX headings that contain this chunk,
 * ordered from outermost to innermost (e.g. ['Chapter 1', 'Section A']).
 * Empty for content that precedes the first heading in the note.
 *
 * `charOffset` is the byte offset of the *section start* in the
 * frontmatter-stripped source text.  Useful for linking back to the source
 * note; not guaranteed to point at the exact start of the chunk text when
 * a section is split into multiple chunks.
 */
export interface ChunkMetadata {
  filePath: string;
  headings: string[];
  charOffset: number;
}

/** A single embeddable unit produced by the chunking engine. */
export interface Chunk {
  /** The raw markdown text of this chunk. */
  text: string;
  /** Exact token count as reported by the cl100k_base tokeniser. */
  tokenCount: number;
  metadata: ChunkMetadata;
}

/** Configuration for {@link chunkNote}. All fields are optional at the call site. */
export interface ChunkerOptions {
  /**
   * Maximum number of tokens in a single chunk.
   * @default 512
   */
  chunkSize: number;
  /**
   * Number of tokens shared between consecutive chunks within the same section.
   * Must be strictly less than `chunkSize`.
   * @default 51
   */
  chunkOverlap: number;
}
