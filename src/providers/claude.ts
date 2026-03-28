import {
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type FetchFn,
  ProviderNetworkError,
  assertResponseOk,
  readLines,
} from './base';

/** Stable Anthropic API version header value. */
const ANTHROPIC_VERSION = '2023-06-01';

// ── Private response-shape types ────────────────────────────────────────────

interface AnthropicContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string };
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * Anthropic Claude provider — chat-only (no embedding API exists).
 *
 * Models: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001 …
 *
 * Streaming format: Server-Sent Events with typed event names.
 * Only `content_block_delta` events with `text_delta` deltas are yielded.
 */
export class ClaudeProvider implements ChatProvider {
  readonly providerId = 'anthropic' as const;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(apiKey: string, timeoutMs = 60_000, fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  // ── chat() ─────────────────────────────────────────────────────────────

  /**
   * Stream a chat completion via Anthropic's Messages API (SSE).
   * Yields string tokens extracted from `content_block_delta` events only.
   *
   * @throws {ProviderAuthError}       on HTTP 401
   * @throws {ProviderRateLimitError}  on HTTP 429 (reads `retry-after-ms` header)
   * @throws {ProviderNetworkError}    on network failure or other HTTP errors
   * @complexity O(n) where n = response tokens
   */
  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: opts.maxTokens ?? 4096,
            messages,
            stream: true,
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderNetworkError('anthropic', 'Request timed out after 60s', true);
        }
        throw new ProviderNetworkError('anthropic', `Network error: ${String(err)}`, true);
      }

      assertResponseOk(response, 'anthropic');

      const body = response.body;
      if (!body) throw new ProviderNetworkError('anthropic', 'Empty response body', false);

      // SSE parser: track `event:` type so we only parse `content_block_delta` data lines.
      let currentEvent = '';

      for await (const line of readLines(body)) {
        const trimmed = line.trim();

        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7);
          continue;
        }

        if (trimmed === '') {
          currentEvent = '';
          continue;
        }

        if (currentEvent === 'content_block_delta' && trimmed.startsWith('data: ')) {
          try {
            const chunk = JSON.parse(trimmed.slice(6)) as AnthropicContentBlockDelta;
            if (chunk.delta.type === 'text_delta') {
              yield chunk.delta.text;
            }
          } catch {
            // Skip malformed SSE frames
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
