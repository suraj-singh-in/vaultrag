import { encode, decode } from 'gpt-tokenizer';
import type { Chunk, ChunkMetadata, ChunkerOptions } from './chunker.types';

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_CHUNK_OPTIONS: ChunkerOptions = {
  chunkSize: 512,
  chunkOverlap: 51,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Splits a single Obsidian markdown note into embeddable chunks.
 *
 * Strategy:
 *   1. Strip YAML frontmatter.
 *   2. Split content into sections at ATX heading boundaries (hard splits).
 *   3. Within each section, apply a token sliding-window with fixed overlap.
 *   4. Overlap never crosses a heading boundary.
 *
 * @param text     Raw file content (may include frontmatter).
 * @param filePath Vault-relative path stored in chunk metadata.
 * @param options  Override `chunkSize` or `chunkOverlap`; both optional.
 * @returns        Ordered array of chunks; empty when the note has no content.
 * @throws         When `chunkOverlap >= chunkSize`.
 */
export function chunkNote(
  text: string,
  filePath: string,
  options?: Partial<ChunkerOptions>,
): Chunk[] {
  const opts: ChunkerOptions = { ...DEFAULT_CHUNK_OPTIONS, ...options };

  if (opts.chunkOverlap >= opts.chunkSize) {
    throw new Error(
      `chunkOverlap (${opts.chunkOverlap}) must be strictly less than chunkSize (${opts.chunkSize}).`,
    );
  }

  const content = stripFrontmatter(text);
  if (!content.trim()) return [];

  const sections = parseSections(content);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const sectionChunks = splitSection(section, filePath, opts);
    for (const chunk of sectionChunks) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface Section {
  /** The heading breadcrumb that contains this section (outermost → innermost). */
  headings: string[];
  /** Text content of this section, including the opening heading line if present. */
  text: string;
  /** Character offset of `text` within the frontmatter-stripped content. */
  charOffset: number;
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

/**
 * Removes a YAML frontmatter block if the file starts with `---\n`.
 * Returns the text unchanged when no valid frontmatter is found.
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return text;

  // Find the closing delimiter after the opening one
  const afterOpen = text.indexOf('\n', 2); // end of the first --- line
  if (afterOpen === -1) return text;

  const closeMatch = /\n---(?:\r?\n|$)/.exec(text.slice(afterOpen));
  if (!closeMatch) return text;

  const closeEnd = afterOpen + closeMatch.index + closeMatch[0].length;
  return text.slice(closeEnd);
}

// ── Section parsing ───────────────────────────────────────────────────────────

/**
 * Splits `content` into heading-scoped sections.
 *
 * Each section's `text` includes the opening ATX heading line so that chunks
 * are self-contained and retrieval results carry their own structural context.
 * Text that appears before the first heading is returned as a preamble section
 * with an empty `headings` array.
 */
function parseSections(content: string): Section[] {
  const sections: Section[] = [];

  // Collect all ATX heading positions
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const headingMatches: Array<{ index: number; depth: number; title: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(content)) !== null) {
    headingMatches.push({
      index: m.index,
      depth: m[1].length,
      title: m[2].trim(),
    });
  }

  // Preamble: text before the first heading
  const firstHeadingIndex =
    headingMatches.length > 0 ? headingMatches[0].index : content.length;

  const preamble = content.slice(0, firstHeadingIndex).trim();
  if (preamble) {
    sections.push({ headings: [], text: preamble, charOffset: 0 });
  }

  // Heading sections — maintain a breadcrumb stack
  const stack: Array<{ depth: number; title: string }> = [];

  for (let i = 0; i < headingMatches.length; i++) {
    const { index, depth, title } = headingMatches[i];
    const nextIndex =
      i + 1 < headingMatches.length ? headingMatches[i + 1].index : content.length;

    // Pop any entries at the same or deeper nesting level
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    stack.push({ depth, title });

    const headings = stack.map(s => s.title);
    // Include the heading line itself so the chunk is self-contained
    const sectionText = content.slice(index, nextIndex).trim();

    if (sectionText) {
      sections.push({ headings, text: sectionText, charOffset: index });
    }
  }

  return sections;
}

// ── Token sliding window ──────────────────────────────────────────────────────

/**
 * Splits one section into one or more {@link Chunk}s using a token
 * sliding-window.  If the section fits within `chunkSize` it is returned as
 * a single chunk (no overlap needed).
 */
function splitSection(section: Section, filePath: string, opts: ChunkerOptions): Chunk[] {
  const tokens = encode(section.text);
  if (tokens.length === 0) return [];

  const { chunkSize, chunkOverlap } = opts;
  const baseMetadata: Omit<ChunkMetadata, 'charOffset'> & Pick<ChunkMetadata, 'charOffset'> = {
    filePath,
    headings: section.headings,
    charOffset: section.charOffset,
  };

  // Fast path: entire section fits in one chunk
  if (tokens.length <= chunkSize) {
    return [{ text: section.text, tokenCount: tokens.length, metadata: { ...baseMetadata } }];
  }

  // Sliding window with stride = chunkSize - chunkOverlap
  const stride = chunkSize - chunkOverlap;
  const chunks: Chunk[] = [];
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + chunkSize, tokens.length);
    const sliceTokens = tokens.slice(start, end);
    const chunkText = decode(sliceTokens);

    chunks.push({
      text: chunkText,
      tokenCount: sliceTokens.length,
      metadata: { ...baseMetadata },
    });

    if (end >= tokens.length) break;
    start += stride;
  }

  return chunks;
}
