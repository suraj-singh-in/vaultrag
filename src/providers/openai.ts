import {
  type ChatMessage,
  type ChatOptions,
  type EmbedOptions,
  type ChatProvider,
  type EmbedProvider,
  type FetchFn,
  ProviderNetworkError,
  assertResponseOk,
  readLines,
} from './base';

// ── Private response-shape types ────────────────────────────────────────────

interface OpenAIStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
}

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * OpenAI provider — supports both chat (streaming) and text embedding.
 *
 * Models:
 *  - Chat:  gpt-4o, gpt-4o-mini, o1, o3-mini …
 *  - Embed: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
 */
export class OpenAIProvider implements ChatProvider, EmbedProvider {
  readonly providerId = 'openai' as const;

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
   * Stream a chat completion via Server-Sent Events.
   * Yields individual string tokens as they arrive from the API.
   *
   * @throws {ProviderAuthError}       on HTTP 401
   * @throws {ProviderRateLimitError}  on HTTP 429
   * @throws {ProviderNetworkError}    on network failure or other HTTP errors
   * @complexity O(n) where n = response tokens
   */
  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: opts.model,
            messages,
            stream: true,
            temperature: opts.temperature ?? 0.7,
            ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderNetworkError('openai', 'Request timed out after 60s', true);
        }
        throw new ProviderNetworkError('openai', `Network error: ${String(err)}`, true);
      }

      assertResponseOk(response, 'openai');

      const body = response.body;
      if (!body) throw new ProviderNetworkError('openai', 'Empty response body', false);

      for await (const line of readLines(body)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          const content = chunk.choices[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed SSE frames
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── embed() ────────────────────────────────────────────────────────────

  /**
   * Embed a batch of texts using the OpenAI Embeddings API.
   * Returns one vector per input text, preserving input order.
   *
   * @throws {ProviderAuthError}       on HTTP 401
   * @throws {ProviderRateLimitError}  on HTTP 429
   * @throws {ProviderNetworkError}    on network failure or other HTTP errors
   * @complexity O(n) where n = number of input texts
   */
  async embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: opts.model, input: texts }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderNetworkError('openai', 'Embedding request timed out', true);
        }
        throw new ProviderNetworkError('openai', `Network error: ${String(err)}`, true);
      }

      assertResponseOk(response, 'openai');

      const data = (await response.json()) as OpenAIEmbedResponse;
      return data.data.map((item) => item.embedding);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
