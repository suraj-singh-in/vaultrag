import { ClaudeProvider } from '../../providers/claude';
import {
  ProviderAuthError,
  ProviderNetworkError,
  ProviderRateLimitError,
  type FetchFn,
} from '../../providers/base';
import { collectStream, makeSSEResponse, makeJSONResponse } from './helpers';

const TEST_KEY = 'sk-ant-test-key';
const CHAT_OPTS = { model: 'claude-sonnet-4-6' };
const MESSAGES = [{ role: 'user' as const, content: 'Hello' }];

/**
 * Builds Anthropic SSE lines for given text tokens.
 * Emits: message_start → content_block_start → N content_block_delta → message_stop
 */
function makeAnthropicSSE(tokens: string[]): string[] {
  const lines: string[] = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
  ];

  for (const token of tokens) {
    lines.push(
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(token)}}}`,
      '',
    );
  }

  lines.push(
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  );

  return lines;
}

describe('ClaudeProvider', () => {
  let mockFetch: jest.MockedFunction<FetchFn>;
  let provider: ClaudeProvider;

  beforeEach(() => {
    mockFetch = jest.fn() as jest.MockedFunction<FetchFn>;
    provider = new ClaudeProvider(TEST_KEY, 60_000, mockFetch);
  });

  // ── chat() ───────────────────────────────────────────────────────────────

  describe('chat()', () => {
    it('streams tokens from content_block_delta events', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['Hello', ' world'])));
      const tokens = await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(tokens).toEqual(['Hello', ' world']);
    });

    it('sends to the correct Anthropic endpoint', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('sends x-api-key header', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(TEST_KEY);
    });

    it('sends anthropic-version header', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['anthropic-version']).toBeDefined();
    });

    it('sets stream:true in the request body', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['Hi'])));
      await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['stream']).toBe(true);
    });

    it('ignores non-text SSE events (message_start etc.)', async () => {
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['Only this'])));
      const tokens = await collectStream(provider.chat(MESSAGES, CHAT_OPTS));
      expect(tokens).toEqual(['Only this']);
    });

    it('throws ProviderAuthError on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: { message: 'Unauthorized' } }, 401));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderAuthError,
      );
    });

    it('throws ProviderRateLimitError on 429', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: { message: 'Rate limited' } }, 429));
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toThrow(
        ProviderRateLimitError,
      );
    });

    it('parses retry-after-ms header on 429', async () => {
      const res = new Response(JSON.stringify({}), {
        status: 429,
        headers: { 'retry-after-ms': '10000' },
      });
      mockFetch.mockResolvedValueOnce(res);
      await expect(collectStream(provider.chat(MESSAGES, CHAT_OPTS))).rejects.toMatchObject({
        retryAfterMs: 10_000,
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
      mockFetch.mockResolvedValueOnce(makeSSEResponse(makeAnthropicSSE(['a', 'b', 'c'])));
      const gen = provider.chat(MESSAGES, CHAT_OPTS) as AsyncGenerator<string>;
      await gen.next();
      await gen.return(undefined);
    });

    it('throws ProviderNetworkError on 500', async () => {
      mockFetch.mockResolvedValueOnce(makeJSONResponse({ error: 'Server error' }, 500));
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
  });

  // ── providerId ───────────────────────────────────────────────────────────

  it('has providerId "anthropic"', () => {
    expect(provider.providerId).toBe('anthropic');
  });
});
