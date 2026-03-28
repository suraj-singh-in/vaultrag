import {
  type ProviderName,
  type ChatProvider,
  type EmbedProvider,
  ProviderAuthError,
  ProviderNetworkError,
} from './base';
import { OpenAIProvider } from './openai';
import { ClaudeProvider } from './claude';
import { OllamaProvider } from './ollama';

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Provider configuration sourced from VaultRAG plugin settings.
 * Chat and embed providers can be different (e.g. Ollama for chat, OpenAI for embed).
 */
export interface ProviderSettings {
  /** Provider used for chat completions. */
  chatProvider: ProviderName;
  /** Provider used for text embedding. */
  embedProvider: ProviderName;
  /** Model identifier for the chat provider. */
  chatModel: string;
  /** Model identifier for the embed provider. */
  embedModel: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  /** Defaults to "http://localhost:11434". */
  ollamaBaseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 60 000. */
  timeoutMs?: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Instantiates the configured ChatProvider.
 *
 * @throws {ProviderAuthError}     when the required API key is absent.
 * @throws {ProviderNetworkError}  for unsupported provider/capability combinations.
 */
export function getChatProvider(settings: ProviderSettings): ChatProvider {
  const timeout = settings.timeoutMs ?? 60_000;

  switch (settings.chatProvider) {
    case 'openai': {
      if (!settings.openaiApiKey) throw new ProviderAuthError('openai');
      return new OpenAIProvider(settings.openaiApiKey, timeout);
    }
    case 'anthropic': {
      if (!settings.anthropicApiKey) throw new ProviderAuthError('anthropic');
      return new ClaudeProvider(settings.anthropicApiKey, timeout);
    }
    case 'ollama': {
      return new OllamaProvider(settings.ollamaBaseUrl ?? 'http://localhost:11434', timeout);
    }
  }
}

/**
 * Instantiates the configured EmbedProvider.
 * Anthropic is explicitly rejected — it has no public embedding API.
 *
 * @throws {ProviderAuthError}     when the required API key is absent.
 * @throws {ProviderNetworkError}  when the selected provider does not support embedding.
 */
export function getEmbedProvider(settings: ProviderSettings): EmbedProvider {
  const timeout = settings.timeoutMs ?? 60_000;

  switch (settings.embedProvider) {
    case 'openai': {
      if (!settings.openaiApiKey) throw new ProviderAuthError('openai');
      return new OpenAIProvider(settings.openaiApiKey, timeout);
    }
    case 'anthropic': {
      throw new ProviderNetworkError(
        'anthropic',
        'Anthropic does not provide an embed API. Choose "openai" or "ollama" as your embed provider.',
        false,
      );
    }
    case 'ollama': {
      return new OllamaProvider(settings.ollamaBaseUrl ?? 'http://localhost:11434', timeout);
    }
  }
}
