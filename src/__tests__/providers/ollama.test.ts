import { OllamaProvider } from '../../providers/ollama';
import { ProviderNetworkError, type FetchFn } from '../../providers/base';
import { collectStream, makeNDJSONResponse, makeJSONResponse } from './helpers';

const BASE_URL = 'http://localhost:11434';
const CHAT_OPTS = { model: 'llama3' };
const EMBED_OPTS = { model: 'nomic-embed-text' };
const MESSAGES = [{ role: 'user' as const, content: 'Hello' }];

/** Builds NDJSON chat stream chunks for given tokens. */
function makeChatNDJSON(tokens: string[]): object[] {
  return [
    ...tokens.map((t, i) => ({
      model: 'llama3',
      message: { role: 'assistant', content: t },
      done: i === tokens.length - 1 ? false : false,
    })),
    { model: 'llama3', message: { role: 'assistant', content: '' }, done: true },
  ];
}

describe('OllamaProvider', () => {
  let mockFetch: jest.MockedFunction<FetchFn>;
  let provider: OllamaProvider;

  beforeEach(() => {
    mockFetch = jest.fn() as jest.MockedFunction<FetchFn>;
    provider = new OllamaProvider(BASE_URL, 60_000, mockFetch);
  });

  // ── chat() ───────────────────────────────────────────────────────────────

  describe('chat()', () => {
    it('streams tokens from NDJSON response', async () => {
      mockFetch.mockResolvedValueOnce(makeNDJSONResponse(makeChatNDJSON(['Hello', ' world'])));
      const tokens = await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(tokens).toEqual(['Hello', ' world']);
    });

    it('sends to /api/chat on the configured base URL', async () => {
      mockFetch.mockResolvedValueOnce(makeNDJSONResponse(makeChatNDJSON(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/chat`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('stops yielding after the done:true chunk', async () => {
      const chunks = [
        { model: 'llama3', message: { role: 'assistant', content: 'stop here' }, done: true },
        { model: 'llama3', message: { role: 'assistant', content: 'should not appear' }, done: false },
      ];
      mockFetch.mockResolvedValueOnce(makeNDJSONResponse(chunks));
      const tokens = await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(tokens).not.toContain('should not appear');
    });

    it('throws ProviderNetworkError when Ollama server is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderNetworkError,
      );
    });

    it('includes the base URL in the unreachable error message', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toMatchObject({
        message: expect.stringContaining(BASE_URL),
        retryable: true,
      });
    });

    it('throws ProviderNetworkError on non-200 HTTP status', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'not found' }, 404));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderNetworkError,
      );
    });

    it('throws ProviderNetworkError when response body is null', async () => {
      const nullBodyRes = { ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: null } as unknown as Response;
      mockFetch.mockResolvedValueOnce(nullBodyRes);
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderNetworkError,
      );
    });

    it('throws ProviderNetworkError on AbortError (timeout)', async () => {
      const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      mockFetch.mockRejectedValueOnce(abortErr);
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toMatchObject({
        message: expect.stringContaining('timed out'),
      });
    });
  });

  // ── embed() ──────────────────────────────────────────────────────────────

  describe('embed()', () => {
    const embedResponse = {
      model: 'nomic-embed-text',
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
    };

    it('returns one vector per input text', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse(embedResponse));
      const result = await provider.embed(['hello', 'world'], EMBED_OPTS);
      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it('sends to /api/embed on the configured base URL', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse(embedResponse));
      await provider.embed(['test'], EMBED_OPTS);
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/embed`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws ProviderNetworkError when server is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(provider.embed(['test'], EMBED_OPTS)).rejects.toThrow(ProviderNetworkError);
    });

    it('includes the base URL in the unreachable error message', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(provider.embed(['test'], EMBED_OPTS)).rejects.toMatchObject({
        message: expect.stringContaining(BASE_URL),
      });
    });

    it('throws ProviderNetworkError on non-200 HTTP status', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'not found' }, 404));
      await expect(provider.embed(['test'], EMBED_OPTS)).rejects.toThrow(ProviderNetworkError);
    });

    it('throws ProviderNetworkError on embed AbortError (timeout)', async () => {
      const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      mockFetch.mockRejectedValueOnce(abortErr);
      await expect(provider.embed(['test'], EMBED_OPTS)).rejects.toMatchObject({
        message: expect.stringContaining('timed out'),
      });
    });
  });

  // ── providerId ───────────────────────────────────────────────────────────

  it('has providerId "ollama"', () => {
    expect(provider.providerId).toBe('ollama');
  });
});
