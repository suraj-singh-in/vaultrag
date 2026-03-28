/**
 * Core abstractions for the VaultRAG provider layer.
 *
 * Design decisions:
 *  - ChatProvider and EmbedProvider are separate interfaces because
 *    Anthropic has no embedding API — a unified interface would require
 *    stub throws, which masks real capability differences.
 *  - FetchFn is exported so providers can accept it as a constructor arg
 *    for deterministic unit testing without global monkey-patching.
 *  - Error classes use Object.setPrototypeOf to fix the instanceof chain
 *    when TypeScript targets < ES2022 and transpiles class extends.
 */

// ── Provider identity ────────────────────────────────────────────────────────

export type ProviderName = 'openai' | 'anthropic' | 'ollama';

// ── Message types ────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

// ── Option types ─────────────────────────────────────────────────────────────

export interface ChatOptions {
  /** Model identifier, e.g. "gpt-4o" or "claude-sonnet-4-6". */
  model: string;
  /** Sampling temperature in [0, 2]. Defaults to 0.7. */
  temperature?: number;
  /** Hard cap on generated tokens. */
  maxTokens?: number;
  /** Caller-supplied cancellation signal (merged with provider timeout). */
  signal?: AbortSignal;
}

export interface EmbedOptions {
  /** Embedding model identifier, e.g. "text-embedding-3-small". */
  model: string;
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
}

// ── Fetch abstraction (injectable for testing) ────────────────────────────────

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ── Provider interfaces ───────────────────────────────────────────────────────

export interface ChatProvider {
  readonly providerId: ProviderName;
  /**
   * Stream a chat completion as an AsyncIterable of string tokens.
   * Throws a ProviderError subclass on auth failure, rate limiting, or
   * network errors — never a raw HTTP status or fetch rejection.
   *
   * @complexity O(n) where n = number of response tokens.
   */
  chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
}

export interface EmbedProvider {
  readonly providerId: ProviderName;
  /**
   * Embed a batch of texts, returning one float32 vector per input.
   * Throws a ProviderError subclass on failure.
   *
   * @complexity O(n) where n = number of input texts.
   */
  embed(texts: string[], opts: EmbedOptions): Promise<number[][]>;
}

// ── Error hierarchy ───────────────────────────────────────────────────────────

/**
 * Base class for all VaultRAG provider errors.
 * Catch this to handle any provider failure generically.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;

  constructor(message: string, provider: ProviderName) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the provider rejects the request due to invalid credentials.
 * UI should prompt the user to re-enter their API key.
 */
export class ProviderAuthError extends ProviderError {
  constructor(provider: ProviderName) {
    super(
      `Authentication failed for provider "${provider}". Check your API key in VaultRAG settings.`,
      provider,
    );
    this.name = 'ProviderAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown on connectivity failures (server down, timeout, DNS, etc.).
 * `retryable` indicates whether an automatic retry makes sense.
 */
export class ProviderNetworkError extends ProviderError {
  readonly retryable: boolean;

  constructor(provider: ProviderName, message: string, retryable = true) {
    super(message, provider);
    this.name = 'ProviderNetworkError';
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the provider returns HTTP 429.
 * `retryAfterMs` is populated from the `retry-after` / `retry-after-ms` header when present.
 */
export class ProviderRateLimitError extends ProviderError {
  readonly retryAfterMs?: number;

  constructor(provider: ProviderName, retryAfterMs?: number) {
    super(
      `Rate limited by provider "${provider}"${
        retryAfterMs !== undefined ? ` — retry after ${retryAfterMs}ms` : ''
      }.`,
      provider,
    );
    this.name = 'ProviderRateLimitError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Shared internal helpers (not exported) ────────────────────────────────────

/**
 * Inspects a Response and throws the appropriate typed error for non-OK statuses.
 * @internal
 */
export function assertResponseOk(response: Response, provider: ProviderName): void {
  if (response.status === 401) throw new ProviderAuthError(provider);

  if (response.status === 429) {
    // Anthropic uses `retry-after-ms`, OpenAI uses `retry-after` (seconds)
    const retryMs = response.headers.get('retry-after-ms');
    const retryS = response.headers.get('retry-after');
    const retryAfterMs = retryMs
      ? parseInt(retryMs, 10)
      : retryS
        ? parseInt(retryS, 10) * 1_000
        : undefined;
    throw new ProviderRateLimitError(provider, retryAfterMs);
  }

  if (!response.ok) {
    throw new ProviderNetworkError(
      provider,
      `HTTP ${response.status} ${response.statusText}`,
      response.status >= 500,
    );
  }
}

/**
 * Reads a ReadableStream<Uint8Array> line by line, yielding complete lines.
 * Handles chunks that split across line boundaries.
 * @internal
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        yield line;
      }
    }

    // Flush any trailing content without a final newline
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
