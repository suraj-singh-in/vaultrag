import { encode } from 'gpt-tokenizer';
import type { EmbedProvider, EmbedOptions, ChatMessage } from '../providers/base';
import type { VectorStore, ItemMetadata } from '../store/base';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are a highly reliable, context-aware AI assistant integrated inside a local note-taking system.

CONTEXT USAGE RULES:
- The user's vault notes are provided inside <vault-context> tags. Each <item> contains a chunk of text from a specific note.
- If a note is currently open by the user, it will appear inside an <active-note> tag — treat this as the highest-priority context.
- Always ground your answers in the provided context when relevant. Do not fabricate information that contradicts the vault content.
- If the vault context contains the answer, cite the source note path when helpful.

GROUNDING & ACCURACY:
- Prefer factual, direct answers grounded in vault content.
- If you are uncertain whether information is in the vault or not, say so explicitly.
- Do not hallucinate note contents, headings, dates, or metadata.

ANSWER STYLE:
- Be concise and direct. Match the complexity of your answer to the complexity of the question.
- Use markdown formatting (lists, headers, code blocks) when it aids readability.
- Avoid unnecessary preamble like "Certainly!" or "Great question!".

NOTE-AWARE BEHAVIOR:
- When answering questions about a specific note or concept, reference the relevant headings and structure from the vault context.
- If the user refers to "this note" or "here", assume they mean the active note if one is provided.

CONTEXT LIMITATION HANDLING:
- If the vault context does not contain sufficient information to answer, say so clearly.
- You may supplement with general knowledge when appropriate, but always distinguish it from vault-sourced content.

TONE:
- Professional but conversational. You are a knowledgeable assistant embedded in the user's personal knowledge system.

OUTPUT PRIORITY:
1. Accuracy grounded in vault context
2. Clarity and brevity
3. Proper citation of source notes when relevant`;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single retrieved chunk ready for prompt assembly. */
export interface ContextChunk {
  text: string;
  filePath: string;
  headings: string[];
  score: number;
  chunkIndex: number;
}

/** The note currently open in the editor (highest-priority context). */
export interface ActiveNote {
  filePath: string;
  content: string;
}

/** Configuration for {@link Retriever}. */
export interface RetrieverOptions {
  /**
   * Number of chunks to fetch from the vector store.
   * @default 5
   */
  topK: number;
  /**
   * Maximum tokens allocated to the assembled context block.
   * Lowest-score chunks are dropped first when the budget is exceeded.
   * @default 3000
   */
  maxContextTokens: number;
  /**
   * System prompt override.
   * Empty string → use {@link DEFAULT_SYSTEM_PROMPT}.
   * @default ''
   */
  systemPrompt: string;
  /**
   * Embedding model passed to {@link EmbedProvider.embed}.
   * @default 'text-embedding-3-small'
   */
  embedModel: string;
}

export const DEFAULT_RETRIEVER_OPTIONS: RetrieverOptions = {
  topK: 5,
  maxContextTokens: 3000,
  systemPrompt: '',
  embedModel: 'text-embedding-3-small',
};

// ── Retriever ─────────────────────────────────────────────────────────────────

/**
 * Handles the full retrieval pipeline: embed query → search → rank chunks.
 * Provides {@link buildPrompt} to assemble the final message list for the
 * chat provider, including XML-tagged context blocks and optional active-note
 * injection.
 */
export class Retriever {
  private readonly opts: RetrieverOptions;

  constructor(
    private readonly store: VectorStore<ItemMetadata>,
    private readonly embedProvider: EmbedProvider,
    opts?: Partial<RetrieverOptions>,
  ) {
    this.opts = { ...DEFAULT_RETRIEVER_OPTIONS, ...opts };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Embeds `query`, searches the vector store for the top-K nearest chunks,
   * and returns them sorted by descending cosine similarity.
   *
   * @returns Empty array when the index is empty or no results pass the
   *          minimum-score threshold.
   */
  async retrieve(query: string): Promise<ContextChunk[]> {
    const embedOpts: EmbedOptions = { model: this.opts.embedModel };
    const [queryVector] = await this.embedProvider.embed([query], embedOpts);

    const results = await this.store.search(queryVector, this.opts.topK);

    // Sort descending by score (store may already do this, but be explicit)
    results.sort((a, b) => b.score - a.score);

    return results.map(r => ({
      text: r.item.metadata['text'] as string,
      filePath: r.item.metadata['filePath'] as string,
      headings: this.parseHeadings(r.item.metadata['headings'] as string),
      score: r.score,
      chunkIndex: r.item.metadata['chunkIndex'] as number,
    }));
  }

  /**
   * Assembles the `ChatMessage[]` list for the chat provider.
   *
   * - System message: uses `opts.systemPrompt` or {@link DEFAULT_SYSTEM_PROMPT}.
   * - User message: XML-tagged vault-context block (token-budget capped) +
   *   optional active-note block (omitted when its path already appears in chunks) +
   *   the raw query.
   *
   * Lowest-score chunks are dropped first when total context tokens exceed
   * `opts.maxContextTokens`.
   */
  buildPrompt(
    query: string,
    chunks: ContextChunk[],
    activeNote?: ActiveNote,
  ): ChatMessage[] {
    const systemContent = this.opts.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;

    const activeNotePaths = new Set(chunks.map(c => c.filePath));
    const injectActive = activeNote !== undefined && !activeNotePaths.has(activeNote.filePath);

    const trimmedChunks = this.applyTokenBudget(chunks);

    const parts: string[] = [];

    if (injectActive && activeNote) {
      parts.push(
        `<active-note path="${activeNote.filePath}">\n${activeNote.content}\n</active-note>`,
      );
    }

    if (trimmedChunks.length > 0) {
      const items = trimmedChunks
        .map((c, idx) => {
          const headingsAttr = c.headings.length > 0
            ? ` headings="${c.headings.join(' > ')}"`
            : '';
          return (
            `<item index="${idx + 1}" path="${c.filePath}"${headingsAttr} score="${c.score.toFixed(4)}">\n` +
            `${c.text}\n` +
            `</item>`
          );
        })
        .join('\n');
      parts.push(`<vault-context>\n${items}\n</vault-context>`);
    }

    parts.push(query);

    return [
      { role: 'system', content: systemContent },
      { role: 'user',   content: parts.join('\n\n') },
    ];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Drops lowest-score chunks until the total token count of all chunk texts
   * fits within `opts.maxContextTokens`.
   *
   * Preserves the original descending-score order in the returned slice.
   */
  private applyTokenBudget(chunks: ContextChunk[]): ContextChunk[] {
    if (chunks.length === 0) return [];

    // Work from lowest-score upward when pruning
    const sorted = [...chunks].sort((a, b) => b.score - a.score);
    let budget = this.opts.maxContextTokens;
    const kept: ContextChunk[] = [];

    for (const chunk of sorted) {
      const tokenCount = encode(chunk.text).length;
      if (tokenCount <= budget) {
        kept.push(chunk);
        budget -= tokenCount;
      }
      // Drop this chunk — doesn't fit; continue trying smaller chunks if any
    }

    // Re-sort kept chunks by descending score to preserve original order
    kept.sort((a, b) => b.score - a.score);
    return kept;
  }

  /** Parses the JSON-serialised headings string stored in chunk metadata. */
  private parseHeadings(raw: string): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // Malformed — return empty
    }
    return [];
  }
}
