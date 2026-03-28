import {
  type ChatMessage,
  type ChatOptions,
  type EmbedOptions,
  type ChatProvider,
  type EmbedProvider,
  type FetchFn,
  ProviderNetworkError,
  readLines,
} from './base';

// ── Private response-shape types ────────────────────────────────────────────

interface OllamaStreamChunk {
  model: string;
  message: { role: string; content: string };
  done: boolean;
}

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * Ollama provider — local inference server, supports both chat and embedding.
 *
 * Chat models:    llama3, mistral, gemma2 … (any model pulled via `ollama pull`)
 * Embed models:   nomic-embed-text, mxbai-embed-large …
 *
 * Streaming format: NDJSON — one JSON object per line, `done: true` on the final chunk.
 * Embed endpoint:   POST /api/embed  (batch input, requires Ollama ≥ 0.1.34)
 */
export class OllamaProvider implements ChatProvider, EmbedProvider {
  readonly providerId = 'ollama' as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(
    baseUrl = 'http://localhost:11434',
    timeoutMs = 60_000,
    fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  // ── chat() ─────────────────────────────────────────────────────────────

  /**
   * Stream a chat completion from a local Ollama server (NDJSON).
   * Yields string tokens from each `message.content` field until `done: true`.
   *
   * @throws {ProviderNetworkError}  when Ollama is unreachable or returns non-200
   * @complexity O(n) where n = response tokens
   */
  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
    const url = `${this.baseUrl}/api/chat`;
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            messages,
            stream: true,
            options: {
              temperature: opts.temperature ?? 0.7,
              ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
            },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderNetworkError('ollama', 'Request timed out after 60s', true);
        }
        throw new ProviderNetworkError(
          'ollama',
          `Cannot connect to Ollama server at ${this.baseUrl}: ${String(err)}`,
          true,
        );
      }

      if (!response.ok) {
        throw new ProviderNetworkError(
          'ollama',
          `HTTP ${response.status} ${response.statusText}`,
          response.status >= 500,
        );
      }

      const body = response.body;
      if (!body) throw new ProviderNetworkError('ollama', 'Empty response body', false);

      for await (const line of readLines(body)) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as OllamaStreamChunk;
          const content = chunk.message?.content;
          if (content) yield content;
          if (chunk.done) return;
        } catch {
          // Skip malformed NDJSON lines
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── embed() ────────────────────────────────────────────────────────────

  /**
   * Embed a batch of texts using Ollama's /api/embed endpoint.
   * Requires Ollama ≥ 0.1.34 for batch input support.
   *
   * @throws {ProviderNetworkError}  when Ollama is unreachable or returns non-200
   * @complexity O(n) where n = number of input texts
   */
  async embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.model, input: texts }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderNetworkError('ollama', 'Embedding request timed out', true);
        }
        throw new ProviderNetworkError(
          'ollama',
          `Cannot connect to Ollama server at ${this.baseUrl}: ${String(err)}`,
          true,
        );
      }

      if (!response.ok) {
        throw new ProviderNetworkError(
          'ollama',
          `HTTP ${response.status} ${response.statusText}`,
          response.status >= 500,
        );
      }

      const data = (await response.json()) as OllamaEmbedResponse;
      return data.embeddings;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
