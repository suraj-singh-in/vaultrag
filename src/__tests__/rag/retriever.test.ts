import {
  Retriever,
  DEFAULT_RETRIEVER_OPTIONS,
  DEFAULT_SYSTEM_PROMPT,
} from '../../rag/retriever';
import type { RetrieverOptions, ActiveNote } from '../../rag/retriever';
import type { EmbedProvider } from '../../providers/base';
import type { VectorStore, ItemMetadata } from '../../store/base';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEmbedProvider(
  vectors: number[][] = [[0.1, 0.2, 0.3]],
): jest.Mocked<EmbedProvider> {
  return {
    providerId: 'openai',
    embed: jest.fn().mockResolvedValue(vectors),
  } as jest.Mocked<EmbedProvider>;
}

function makeSearchResult(
  filePath: string,
  text: string,
  score: number,
  chunkIndex = 0,
  headings: string[] = [],
) {
  return {
    item: {
      id: `${filePath}:${chunkIndex}`,
      vector: [0.1, 0.2, 0.3],
      metadata: {
        text,
        filePath,
        headings: JSON.stringify(headings),
        chunkIndex,
      } as ItemMetadata,
    },
    score,
  };
}

function makeStore(
  results: ReturnType<typeof makeSearchResult>[] = [],
): jest.Mocked<VectorStore<ItemMetadata>> {
  return {
    open: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue(results),
    size: jest.fn().mockResolvedValue(results.length),
  } as jest.Mocked<VectorStore<ItemMetadata>>;
}

function makeRetriever(
  store: jest.Mocked<VectorStore<ItemMetadata>>,
  embed: jest.Mocked<EmbedProvider>,
  opts?: Partial<RetrieverOptions>,
): Retriever {
  return new Retriever(store, embed, opts);
}

// ── DEFAULT_SYSTEM_PROMPT ─────────────────────────────────────────────────────

describe('DEFAULT_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe('string');
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});

// ── DEFAULT_RETRIEVER_OPTIONS ─────────────────────────────────────────────────

describe('DEFAULT_RETRIEVER_OPTIONS', () => {
  it('has expected field values', () => {
    expect(DEFAULT_RETRIEVER_OPTIONS.topK).toBe(5);
    expect(DEFAULT_RETRIEVER_OPTIONS.maxContextTokens).toBe(3000);
    expect(DEFAULT_RETRIEVER_OPTIONS.systemPrompt).toBe('');
    expect(typeof DEFAULT_RETRIEVER_OPTIONS.embedModel).toBe('string');
  });
});

// ── retrieve() ────────────────────────────────────────────────────────────────

describe('Retriever.retrieve()', () => {
  it('embeds the query and searches the store', async () => {
    const embed = makeEmbedProvider();
    const store = makeStore([makeSearchResult('a.md', 'hello', 0.9)]);
    const r = makeRetriever(store, embed);

    const chunks = await r.retrieve('what is hello?');

    expect(embed.embed).toHaveBeenCalledWith(['what is hello?'], expect.any(Object));
    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].filePath).toBe('a.md');
    expect(chunks[0].text).toBe('hello');
    expect(chunks[0].score).toBeCloseTo(0.9);
  });

  it('respects a custom topK', async () => {
    const embed = makeEmbedProvider();
    const store = makeStore();
    const r = makeRetriever(store, embed, { topK: 10 });

    await r.retrieve('query');

    expect(store.search).toHaveBeenCalledWith(expect.any(Array), 10);
  });

  it('returns [] when store is empty', async () => {
    const embed = makeEmbedProvider();
    const store = makeStore([]);
    const r = makeRetriever(store, embed);

    const chunks = await r.retrieve('query');

    expect(chunks).toEqual([]);
  });

  it('parses headings from JSON-serialised metadata', async () => {
    const embed = makeEmbedProvider();
    const store = makeStore([
      makeSearchResult('note.md', 'content', 0.8, 0, ['Intro', 'Details']),
    ]);
    const r = makeRetriever(store, embed);

    const [chunk] = await r.retrieve('query');

    expect(chunk.headings).toEqual(['Intro', 'Details']);
  });

  it('returns chunks sorted by descending score', async () => {
    const embed = makeEmbedProvider();
    const store = makeStore([
      makeSearchResult('a.md', 'low',  0.4),
      makeSearchResult('b.md', 'high', 0.95),
      makeSearchResult('c.md', 'mid',  0.7),
    ]);
    const r = makeRetriever(store, embed);

    const chunks = await r.retrieve('query');

    expect(chunks[0].score).toBeGreaterThan(chunks[1].score);
    expect(chunks[1].score).toBeGreaterThan(chunks[2].score);
  });
});

// ── buildPrompt() ─────────────────────────────────────────────────────────────

describe('Retriever.buildPrompt()', () => {
  it('returns a system message and a user message', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider());
    const messages = r.buildPrompt('hello', []);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('uses the hardcoded default when systemPrompt is empty', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider(), { systemPrompt: '' });
    const [system] = r.buildPrompt('hello', []);
    expect(system.content).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('uses a custom systemPrompt when provided', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider(), { systemPrompt: 'custom prompt' });
    const [system] = r.buildPrompt('hello', []);
    expect(system.content).toBe('custom prompt');
  });

  it('includes vault-context block when chunks are provided', () => {
    const embed = makeEmbedProvider();
    const store = makeStore();
    const r = makeRetriever(store, embed);
    const chunks = [
      { text: 'chunk text', filePath: 'a.md', headings: ['H1'], score: 0.9, chunkIndex: 0 },
    ];

    const messages = r.buildPrompt('my question', chunks);
    const user = messages[1].content;

    expect(user).toContain('<vault-context>');
    expect(user).toContain('chunk text');
    expect(user).toContain('path="a.md"');
    expect(user).toContain('my question');
  });

  it('includes active note block when activeNote is provided', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider());
    const activeNote: ActiveNote = { filePath: 'open.md', content: 'active content' };

    const messages = r.buildPrompt('query', [], activeNote);
    const user = messages[1].content;

    expect(user).toContain('<active-note');
    expect(user).toContain('path="open.md"');
    expect(user).toContain('active content');
  });

  it('does NOT inject active note block when activeNote filePath already in chunks', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider());
    const chunks = [
      { text: 'same file chunk', filePath: 'open.md', headings: [], score: 0.9, chunkIndex: 0 },
    ];
    const activeNote: ActiveNote = { filePath: 'open.md', content: 'active content' };

    const messages = r.buildPrompt('query', chunks, activeNote);
    const user = messages[1].content;

    expect(user).not.toContain('<active-note');
  });

  it('omits vault-context block when no chunks', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider());
    const messages = r.buildPrompt('question', []);
    const user = messages[1].content;
    expect(user).not.toContain('<vault-context>');
  });

  it('always ends the user message with the query', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider());
    const messages = r.buildPrompt('final question here', []);
    expect(messages[1].content.trimEnd().endsWith('final question here')).toBe(true);
  });
});

// ── token budget enforcement ──────────────────────────────────────────────────

describe('Retriever.buildPrompt() token budget', () => {
  it('truncates lowest-score chunks when context exceeds maxContextTokens', () => {
    // Budget of 5 tokens: fits "hi" (1 token) but not the long low-score text
    const r = makeRetriever(makeStore(), makeEmbedProvider(), { maxContextTokens: 5 });

    const chunks = [
      { text: 'hi', filePath: 'a.md', headings: [], score: 0.95, chunkIndex: 0 },
      {
        text: 'this is a much longer piece of text that will definitely exceed our tiny token budget and must be dropped',
        filePath: 'b.md',
        headings: [],
        score: 0.3,
        chunkIndex: 0,
      },
    ];

    const messages = r.buildPrompt('query', chunks);
    const user = messages[1].content;

    expect(user).toContain('path="a.md"');
    expect(user).not.toContain('path="b.md"');
  });

  it('includes all chunks when within budget', () => {
    const r = makeRetriever(makeStore(), makeEmbedProvider(), { maxContextTokens: 3000 });

    const chunks = [
      { text: 'chunk one', filePath: 'a.md', headings: [], score: 0.9, chunkIndex: 0 },
      { text: 'chunk two', filePath: 'b.md', headings: [], score: 0.8, chunkIndex: 0 },
    ];

    const messages = r.buildPrompt('query', chunks);
    const user = messages[1].content;

    expect(user).toContain('chunk one');
    expect(user).toContain('chunk two');
  });
});

// ── retrieve() + buildPrompt() integration ───────────────────────────────────

describe('Retriever end-to-end (retrieve → buildPrompt)', () => {
  it('deduplicates active note from search results in the prompt', async () => {
    const embed = makeEmbedProvider();
    const store = makeStore([
      makeSearchResult('notes/open.md', 'open note chunk', 0.99),
      makeSearchResult('other.md',      'other chunk',     0.7),
    ]);
    const r = makeRetriever(store, embed);

    const chunks = await r.retrieve('my query');
    const activeNote: ActiveNote = { filePath: 'notes/open.md', content: 'full note' };
    const messages = r.buildPrompt('my query', chunks, activeNote);
    const user = messages[1].content;

    // active note filePath is already in chunks → no <active-note> block
    expect(user).not.toContain('<active-note');
    // but the chunk text still appears inside vault-context
    expect(user).toContain('open note chunk');
  });
});
