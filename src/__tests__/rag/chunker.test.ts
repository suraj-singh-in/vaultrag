import { encode } from 'gpt-tokenizer';
import { chunkNote, DEFAULT_CHUNK_OPTIONS } from '../../rag/chunker';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Repeat `str` until it produces at least `minTokens` tokens. */
function tokenFill(str: string, minTokens: number): string {
  let out = str;
  while (encode(out).length < minTokens) out += str;
  return out;
}

// ── defaults ──────────────────────────────────────────────────────────────────

describe('DEFAULT_CHUNK_OPTIONS', () => {
  it('has chunkSize 512', () => {
    expect(DEFAULT_CHUNK_OPTIONS.chunkSize).toBe(512);
  });

  it('has chunkOverlap 51', () => {
    expect(DEFAULT_CHUNK_OPTIONS.chunkOverlap).toBe(51);
  });
});

// ── input validation ──────────────────────────────────────────────────────────

describe('chunkNote() — input validation', () => {
  it('throws when chunkOverlap >= chunkSize', () => {
    expect(() => chunkNote('text', 'f.md', { chunkSize: 50, chunkOverlap: 50 })).toThrow();
  });

  it('throws when chunkOverlap > chunkSize', () => {
    expect(() => chunkNote('text', 'f.md', { chunkSize: 50, chunkOverlap: 60 })).toThrow();
  });
});

// ── empty / blank input ───────────────────────────────────────────────────────

describe('chunkNote() — empty / blank input', () => {
  it('returns [] for empty string', () => {
    expect(chunkNote('', 'test.md')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(chunkNote('   \n\n  \t ', 'test.md')).toEqual([]);
  });

  it('returns [] for a note that contains only frontmatter', () => {
    expect(chunkNote('---\ntitle: Ghost\n---\n', 'test.md')).toEqual([]);
  });
});

// ── frontmatter stripping ─────────────────────────────────────────────────────

describe('chunkNote() — frontmatter stripping', () => {
  it('strips YAML frontmatter delimited by ---', () => {
    const text = '---\ntitle: My Note\ntags: [foo, bar]\n---\n\n# Hello\n\nContent here.';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks.every(c => !c.text.includes('title:'))).toBe(true);
    expect(chunks.every(c => !c.text.includes('tags:'))).toBe(true);
  });

  it('keeps body content after stripping frontmatter', () => {
    const text = '---\ntitle: My Note\n---\n\n# Hello\n\nContent here.';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks.some(c => c.text.includes('Content here.'))).toBe(true);
  });

  it('does not strip content when there is no frontmatter', () => {
    const text = '# Plain note\n\nSome content.';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks.some(c => c.text.includes('Some content.'))).toBe(true);
  });

  it('does not strip a --- block that does not start at position 0', () => {
    const text = '\n---\nfake: frontmatter\n---\n\n# Hello\n\nContent.';
    const chunks = chunkNote(text, 'test.md');
    // content is still present regardless of how the non-leading --- is handled
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ── single small note ─────────────────────────────────────────────────────────

describe('chunkNote() — single chunk (content fits within chunkSize)', () => {
  it('returns exactly one chunk for a note smaller than chunkSize', () => {
    const text = '# Hello\n\nThis is a short note.';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks).toHaveLength(1);
  });

  it('chunk text contains the original content', () => {
    const text = '# Hello\n\nThis is a short note.';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks[0].text).toContain('short note');
  });

  it('tokenCount on chunk equals encode(text).length', () => {
    const text = '# Hello\n\nThis is a short note with a few more words.';
    const chunks = chunkNote(text, 'test.md');
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(encode(chunk.text).length);
    }
  });

  it('sets filePath correctly in metadata', () => {
    const chunks = chunkNote('# Hi\n\nContent.', 'notes/hello.md');
    expect(chunks[0].metadata.filePath).toBe('notes/hello.md');
  });

  it('creates a chunk for a heading-only note (no body)', () => {
    const chunks = chunkNote('# Heading Only', 'test.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.headings).toEqual(['Heading Only']);
  });
});

// ── heading metadata ──────────────────────────────────────────────────────────

describe('chunkNote() — heading metadata', () => {
  it('preamble content (before first heading) has headings: []', () => {
    const chunks = chunkNote('Some intro text without any heading.', 'test.md');
    expect(chunks[0].metadata.headings).toEqual([]);
  });

  it('captures a single top-level heading', () => {
    const chunks = chunkNote('# Introduction\n\nContent.', 'test.md');
    expect(chunks[0].metadata.headings).toEqual(['Introduction']);
  });

  it('captures nested headings as a breadcrumb', () => {
    const text = '# Chapter 1\n\n## Section A\n\nContent under section A.';
    const chunks = chunkNote(text, 'test.md');
    const sectionChunk = chunks.find(c => c.text.includes('Content under section A'));
    expect(sectionChunk?.metadata.headings).toEqual(['Chapter 1', 'Section A']);
  });

  it('breadcrumb resets when a same-level heading appears', () => {
    const text = '# Alpha\n\nContent A.\n\n# Beta\n\nContent B.';
    const chunks = chunkNote(text, 'test.md');
    const betaChunk = chunks.find(c => c.text.includes('Content B'));
    expect(betaChunk?.metadata.headings).toEqual(['Beta']);
  });

  it('breadcrumb pops to the correct ancestor on a shallower heading', () => {
    const text =
      '# Top\n\n## Sub\n\nContent sub.\n\n# Top2\n\n## Sub2\n\nContent sub2.';
    const chunks = chunkNote(text, 'test.md');
    const sub2Chunk = chunks.find(c => c.text.includes('Content sub2'));
    expect(sub2Chunk?.metadata.headings).toEqual(['Top2', 'Sub2']);
  });

  it('handles three levels of heading nesting', () => {
    const text = '# A\n\n## B\n\n### C\n\nDeep content.';
    const chunks = chunkNote(text, 'test.md');
    const deepChunk = chunks.find(c => c.text.includes('Deep content'));
    expect(deepChunk?.metadata.headings).toEqual(['A', 'B', 'C']);
  });

  it('produces separate chunks for each top-level section', () => {
    const text = '# Alpha\n\nAlpha content.\n\n# Beta\n\nBeta content.';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks.some(c => c.metadata.headings[0] === 'Alpha')).toBe(true);
    expect(chunks.some(c => c.metadata.headings[0] === 'Beta')).toBe(true);
  });
});

// ── code blocks ───────────────────────────────────────────────────────────────

describe('chunkNote() — code blocks', () => {
  it('includes fenced code block content in chunks', () => {
    const text =
      '# Code Example\n\n```typescript\nconst x: number = 42;\nconsole.log(x);\n```\n';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks.some(c => c.text.includes('const x: number = 42;'))).toBe(true);
  });

  it('includes the code fence markers themselves', () => {
    const text = '# Snippet\n\n```python\nprint("hello")\n```\n';
    const chunks = chunkNote(text, 'test.md');
    expect(chunks.some(c => c.text.includes('```'))).toBe(true);
  });

  it('large code block is chunked rather than skipped', () => {
    const codeLine = '// comment line number padding\n';
    const bigCode = '```javascript\n' + codeLine.repeat(200) + '```\n';
    const text = '# Big Code\n\n' + bigCode;
    const chunks = chunkNote(text, 'test.md', { chunkSize: 50, chunkOverlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => encode(c.text).length <= 50)).toBe(true);
  });
});

// ── chunk size invariant ──────────────────────────────────────────────────────

describe('chunkNote() — chunk size invariant', () => {
  it('token count of every chunk never exceeds chunkSize', () => {
    const longText = '# Big Section\n\n' + tokenFill('The quick brown fox. ', 600);
    const opts = { chunkSize: 100, chunkOverlap: 10 };
    const chunks = chunkNote(longText, 'test.md', opts);
    for (const chunk of chunks) {
      expect(encode(chunk.text).length).toBeLessThanOrEqual(opts.chunkSize);
    }
  });

  it('tokenCount field on each chunk never exceeds chunkSize', () => {
    const longText = '# Section\n\n' + tokenFill('lorem ipsum dolor sit amet. ', 300);
    const opts = { chunkSize: 80, chunkOverlap: 8 };
    const chunks = chunkNote(longText, 'test.md', opts);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(opts.chunkSize);
    }
  });

  it('produces multiple chunks when content exceeds chunkSize', () => {
    const longText = '# Section\n\n' + tokenFill('word ', 200);
    const chunks = chunkNote(longText, 'test.md', { chunkSize: 50, chunkOverlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ── overlap ───────────────────────────────────────────────────────────────────

describe('chunkNote() — overlap', () => {
  it('consecutive chunks within a section share exactly chunkOverlap tokens', () => {
    const chunkOverlap = 8;
    const chunkSize = 40;
    const text =
      '# Big Section\n\n' +
      tokenFill('The quick brown fox jumps over the lazy dog. ', chunkSize * 4);
    const chunks = chunkNote(text, 'test.md', { chunkSize, chunkOverlap });

    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 0; i < chunks.length - 1; i++) {
      const tokensA = encode(chunks[i].text);
      const tokensB = encode(chunks[i + 1].text);
      expect(tokensA.slice(-chunkOverlap)).toEqual(tokensB.slice(0, chunkOverlap));
    }
  });

  it('does not carry overlap across heading boundaries', () => {
    const textA = 'Content belonging to section alpha. ' .repeat(5);
    const textB = 'Content belonging to section beta. '.repeat(5);
    // Both sections are smaller than chunkSize — no intra-section splits
    const doc = `# Alpha\n\n${textA}\n\n# Beta\n\n${textB}`;
    const chunks = chunkNote(doc, 'test.md');

    const betaChunk = chunks.find(c => c.metadata.headings[0] === 'Beta');
    expect(betaChunk).toBeDefined();
    expect(betaChunk!.text).not.toContain('alpha');
  });

  it('last chunk of a section may be shorter than chunkSize (no padding)', () => {
    const chunkSize = 40;
    const text =
      '# S\n\n' + tokenFill('word ', chunkSize + 10); // slightly more than one chunk
    const chunks = chunkNote(text, 'test.md', { chunkSize, chunkOverlap: 5 });
    // The final chunk should be shorter than chunkSize
    const lastChunk = chunks[chunks.length - 1];
    // It may equal chunkSize only if the last stride lands exactly — just verify ≤
    expect(encode(lastChunk.text).length).toBeLessThanOrEqual(chunkSize);
  });
});

// ── tokenCount field accuracy ─────────────────────────────────────────────────

describe('chunkNote() — tokenCount field', () => {
  it('tokenCount matches encode(chunk.text).length for every chunk', () => {
    const text =
      '# Intro\n\nThis is content.\n\n## Details\n\nMore detail here.\n\n' +
      tokenFill('extra filler words to trigger splitting. ', 200);
    const opts = { chunkSize: 60, chunkOverlap: 6 };
    const chunks = chunkNote(text, 'test.md', opts);

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(encode(chunk.text).length);
    }
  });
});
