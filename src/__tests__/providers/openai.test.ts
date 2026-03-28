import { OpenAIProvider } from '../../providers/openai';
import {
  ProviderAuthError,
  ProviderNetworkError,
  ProviderRateLimitError,
  type FetchFn,
} from '../../providers/base';
import {
  collectStream,
  makeSSEResponse,
  makeJSONResponse,
} from './helpers';

const TEST_KEY = 'sk-test-key';
const CHAT_OPTS = { model: 'gpt-4o' };
const EMBED_OPTS = { model: 'text-embedding-3-small' };
const MESSAGES = [{ role: 'user' as const, content: 'Hello' }];

/** OpenAI SSE lines for a two-token response. */
function makeChatSSE(tokens: string[]): string[] {
  return [
    ...tokens.map(
      (t) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: t }, finish_reason: null }] })}`,
    ),
    'data: [DONE]',
  ];
}

describe('OpenAIProvider', () => {
  let mockFetch: jest.MockedFunction<FetchFn>;
  let provider: OpenAIProvider;

  beforeEach(() => {
    mockFetch = jest.fn() as jest.MockedFunction<FetchFn>;
    provider = new OpenAIProvider(TEST_KEY, 60_000, mockFetch);
  });

  // ── chat() ───────────────────────────────────────────────────────────────

  describe('chat()', () => {
    it('streams tokens from a successful response', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeChatSSE(['Hello', ' world'])));
      const tokens = await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(tokens).toEqual(['Hello', ' world']);
    });

    it('sends the correct URL and method', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeChatSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('sends Authorization header with Bearer token', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeChatSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        `Bearer ${TEST_KEY}`,
      );
    });

    it('sets stream:true in the request body', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeChatSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['stream']).toBe(true);
    });

    it('throws ProviderAuthError on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'Unauthorized' }, 401));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderAuthError,
      );
    });

    it('throws ProviderRateLimitError on 429', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'Rate limited' }, 429));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderRateLimitError,
      );
    });

    it('parses retry-after header on 429', async () => {
      const res = new Response(JSON.stringify({}), {
        status: 429,
        headers: { 'retry-after': '30' },
      });
      mockFetch.mockResolvedValueOnce(res);
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toMatchObject({
        retryAfterMs: 30_000,
      });
    });

    it('throws ProviderNetworkError when fetch rejects', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderNetworkError,
      );
    });

    it('throws ProviderNetworkError on chat AbortError (timeout)', async () => {
      const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      mockFetch.mockRejectedValueOnce(abortErr);
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toMatchObject({
        message: expect.stringContaining('timed out'),
      });
    });

    it('cleans up (finally) when the consumer breaks early', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeChatSSE(['a', 'b', 'c'])));
      const gen = provider.chat(MESSAGES, CHAT_OPTS) as AsyncGenerator<string>;
      await gen.next();
      await gen.return(undefined); // triggers finally → clearTimeout
    });

    it('throws ProviderNetworkError on non-401/429 HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'Server error' }, 500));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderNetworkError,
      );
    });

    it('yields nothing when response has no content deltas', async () => {
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ];
      mockFetch.mockResolvedValueOnce(makeSSEResponse(sse));
      const tokens = await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(tokens).toHaveLength(0);
    });

    it('throws ProviderNetworkError when response body is null', async () => {
      const nullBodyRes = { ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: null } as unknown as Response;
      mockFetch.mockResolvedValueOnce(nullBodyRes);
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderNetworkError,
      );
    });
  });

  // ── embed() ──────────────────────────────────────────────────────────────

  describe('embed()', () => {
    const embedResponse = {
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 1 },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    };

    it('returns a vector per input text', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse(embedResponse));
      const result = await provider.embed(['hello', 'world'], EMBED_OPTS);
      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it('sends the correct URL', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse(embedResponse));
      await provider.embed(['test'], EMBED_OPTS);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws ProviderAuthError on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'Unauthorized' }, 401));
      await expect(provider.embed(['test'], EMBED_OPTS)).rejects.toThrow(ProviderAuthError);
    });

    it('throws ProviderRateLimitError on 429', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'Rate limited' }, 429));
      await expect(provider.embed(['test'], EMBED_OPTS)).rejects.toThrow(ProviderRateLimitError);
    });

    it('throws ProviderNetworkError when fetch rejects', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
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

  it('has providerId "openai"', () => {
    expect(provider.providerId).toBe('openai');
  });
});
