import {
  ProviderError,
  ProviderAuthError,
  ProviderNetworkError,
  ProviderRateLimitError,
  readLines,
} from '../../providers/base';

describe('ProviderError hierarchy', () => {
  describe('ProviderAuthError', () => {
    it('is an instance of Error, ProviderError, and ProviderAuthError', () => {
      const err = new ProviderAuthError('openai');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toBeInstanceOf(ProviderAuthError);
    });

    it('sets name to "ProviderAuthError"', () => {
      expect(new ProviderAuthError('openai').name).toBe('ProviderAuthError');
    });

    it('stores the provider name', () => {
      expect(new ProviderAuthError('anthropic').provider).toBe('anthropic');
      expect(new ProviderAuthError('ollama').provider).toBe('ollama');
    });

    it('includes the provider name in the message', () => {
      expect(new ProviderAuthError('openai').message).toContain('openai');
    });
  });

  describe('ProviderNetworkError', () => {
    it('is an instance of Error, ProviderError, and ProviderNetworkError', () => {
      const err = new ProviderNetworkError('openai', 'timeout', true);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toBeInstanceOf(ProviderNetworkError);
    });

    it('sets name to "ProviderNetworkError"', () => {
      expect(new ProviderNetworkError('openai', 'x').name).toBe('ProviderNetworkError');
    });

    it('stores the retryable flag', () => {
      expect(new ProviderNetworkError('openai', 'x', true).retryable).toBe(true);
      expect(new ProviderNetworkError('openai', 'x', false).retryable).toBe(false);
    });

    it('defaults retryable to true', () => {
      expect(new ProviderNetworkError('openai', 'x').retryable).toBe(true);
    });

    it('includes the custom message', () => {
      expect(new ProviderNetworkError('openai', 'timed out').message).toContain('timed out');
    });
  });

  describe('ProviderRateLimitError', () => {
    it('is an instance of Error, ProviderError, and ProviderRateLimitError', () => {
      const err = new ProviderRateLimitError('openai');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toBeInstanceOf(ProviderRateLimitError);
    });

    it('sets name to "ProviderRateLimitError"', () => {
      expect(new ProviderRateLimitError('openai').name).toBe('ProviderRateLimitError');
    });

    it('stores retryAfterMs when provided', () => {
      expect(new ProviderRateLimitError('openai', 5000).retryAfterMs).toBe(5000);
    });

    it('leaves retryAfterMs undefined when not provided', () => {
      expect(new ProviderRateLimitError('openai').retryAfterMs).toBeUndefined();
    });

    it('includes retry timing in message when provided', () => {
      const err = new ProviderRateLimitError('openai', 5000);
      expect(err.message).toContain('5000');
    });

    it('includes the provider name in the message', () => {
      expect(new ProviderRateLimitError('anthropic').message).toContain('anthropic');
    });
  });
});

// ── readLines ─────────────────────────────────────────────────────────────────

describe('readLines()', () => {
  function makeBodyStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
    const lines: string[] = [];
    for await (const l of readLines(stream)) lines.push(l);
    return lines;
  }

  it('yields each newline-terminated line without the newline', async () => {
    const lines = await drain(makeBodyStream(['foo\nbar\nbaz\n']));
    expect(lines).toEqual(['foo', 'bar', 'baz']);
  });

  it('handles lines split across multiple chunks', async () => {
    const lines = await drain(makeBodyStream(['fo', 'o\nb', 'ar\n']));
    expect(lines).toEqual(['foo', 'bar']);
  });

  it('flushes trailing content with no final newline', async () => {
    const lines = await drain(makeBodyStream(['hello\nworld']));
    expect(lines).toContain('world');
  });

  it('returns an empty array for an empty stream', async () => {
    const lines = await drain(makeBodyStream([]));
    expect(lines).toEqual([]);
  });
});
