import type { ProviderName } from './providers/base';
import type { ProviderSettings } from './providers/factory';

// ── Settings shape ────────────────────────────────────────────────────────────

/**
 * All persisted VaultRAG settings.
 * Stored in `<vault>/.obsidian/plugins/vaultrag/data.json` via Obsidian's
 * Plugin.loadData / Plugin.saveData API (plaintext — exclude from vault sync).
 *
 * Per-provider model fields are kept separate so switching providers and back
 * remembers the model that was configured.
 */
/**
 * Snapshot of the most recent indexAll() run.
 * Stored in data.json so the dashboard can show last-run stats without
 * re-loading IndexerState.
 */
export interface LastIndexRun {
  timestamp: number;
  indexed: number;
  skipped: number;
  totalFiles: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * A single persisted chat turn.
 * Stored inside `chatHistory` in data.json.
 */
export interface StoredMessage {
  role: 'user' | 'assistant' | 'summary';
  content: string;
  /** Vault file paths of chunks that informed this response. */
  sources: string[];
  timestamp: number;
}

export interface PluginSettings {
  // ── Provider selection ──────────────────────────────────────────────────
  chatProvider: ProviderName;
  embedProvider: ProviderName;

  // ── OpenAI ──────────────────────────────────────────────────────────────
  openaiApiKey: string;
  openaiChatModel: string;
  openaiEmbedModel: string;

  // ── Anthropic ────────────────────────────────────────────────────────────
  anthropicApiKey: string;
  anthropicChatModel: string;

  // ── Ollama ───────────────────────────────────────────────────────────────
  ollamaBaseUrl: string;
  ollamaChatModel: string;
  ollamaEmbedModel: string;

  // ── Global ───────────────────────────────────────────────────────────────
  /** Provider request timeout in milliseconds. */
  timeoutMs: number;

  // ── Retrieval ─────────────────────────────────────────────────────────────
  /** Number of chunks to retrieve per query. */
  topK: number;
  /** Maximum tokens allocated to the assembled vault context block. */
  maxContextTokens: number;
  /**
   * Optional user-supplied system prompt.
   * Empty string → use the hardcoded default in `DEFAULT_SYSTEM_PROMPT`.
   */
  systemPrompt: string;

  // ── Chat history ──────────────────────────────────────────────────────────
  /** Persisted conversation turns (capped at 50; older turns are compacted). */
  chatHistory: StoredMessage[];
  /** Pixel width of the floating chat panel (min 280, max 720). */
  chatPanelWidth: number;
  /** Whether the floating panel is open. Restored on plugin reload. */
  chatPanelOpen: boolean;
  /**
   * AI-generated summary of conversation turns compacted out when history
   * exceeded 50 messages. Injected into the system prompt to preserve context.
   */
  chatSummary: string;

  // ── Index dashboard ───────────────────────────────────────────────────────
  /** Snapshot of the last indexAll() run; null when the vault has never been indexed. */
  lastIndexRun: LastIndexRun | null;
  /**
   * Estimated total embed tokens consumed across all indexing runs.
   * Reset and re-counted when "Re-index all" is triggered from the dashboard.
   */
  totalTokensIndexed: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Ships with Ollama as the default provider so the plugin works out of the
 * box without any API key — users just need a running Ollama server.
 */
export const DEFAULT_SETTINGS: Readonly<PluginSettings> = {
  chatProvider: 'ollama',
  embedProvider: 'ollama',

  openaiApiKey: '',
  openaiChatModel: 'gpt-4o',
  openaiEmbedModel: 'text-embedding-3-small',

  anthropicApiKey: '',
  anthropicChatModel: 'claude-sonnet-4-6',

  ollamaBaseUrl: 'http://localhost:11434',
  ollamaChatModel: 'llama3',
  ollamaEmbedModel: 'nomic-embed-text',

  timeoutMs: 60_000,

  topK: 5,
  maxContextTokens: 3000,
  systemPrompt: '',

  chatHistory: [],
  chatPanelWidth: 380,
  chatPanelOpen: false,
  chatSummary: '',

  lastIndexRun: null,
  totalTokensIndexed: 0,
};

// ── Load helper ───────────────────────────────────────────────────────────────

/**
 * Merges persisted data with defaults.
 * Safe to call with `null` (no data.json yet) or a partial object (forward
 * compatibility with settings added in future plugin versions).
 *
 * @complexity O(k) where k = number of keys in PluginSettings
 */
export function applyDefaults(saved: Partial<PluginSettings>): PluginSettings {
  return { ...DEFAULT_SETTINGS, ...saved };
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  /** Human-readable error strings, one per failed constraint. */
  errors: string[];
}

/**
 * Validates the full settings object.
 * Pure function — no side-effects, no Obsidian API calls.
 * Called by SettingsTab on every save (for inline UX feedback) and by the
 * factory as a final guard before constructing providers.
 *
 * @complexity O(1)
 */
export function validateSettings(s: PluginSettings): ValidationResult {
  const errors: string[] = [];

  // Cloud providers require API keys
  if (s.chatProvider === 'openai' && !s.openaiApiKey.trim()) {
    errors.push('OpenAI API key is required when OpenAI is the chat provider.');
  }
  if (s.chatProvider === 'anthropic' && !s.anthropicApiKey.trim()) {
    errors.push('Anthropic API key is required when Anthropic is the chat provider.');
  }
  if (s.embedProvider === 'openai' && !s.openaiApiKey.trim()) {
    errors.push('OpenAI API key is required when OpenAI is the embed provider.');
  }

  // Anthropic has no embedding API
  if (s.embedProvider === 'anthropic') {
    errors.push(
      'Anthropic does not support embedding. Choose OpenAI or Ollama as embed provider.',
    );
  }

  // Validate Ollama URL only when Ollama is actually selected
  if (s.chatProvider === 'ollama' || s.embedProvider === 'ollama') {
    if (!isValidHttpUrl(s.ollamaBaseUrl)) {
      errors.push('Ollama URL must be a valid http or https URL.');
    }
  }

  return { valid: errors.length === 0, errors };
}

function isValidHttpUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Factory adapter ───────────────────────────────────────────────────────────

/**
 * Projects the plugin's flat settings onto the `ProviderSettings` shape
 * expected by `getChatProvider` / `getEmbedProvider` in the factory.
 * Picks the active model for each provider and converts empty keys to
 * `undefined` so the factory's optional-field semantics are respected.
 *
 * @complexity O(1)
 */
export function toProviderSettings(s: PluginSettings): ProviderSettings {
  return {
    chatProvider: s.chatProvider,
    embedProvider: s.embedProvider,
    chatModel: activeChatModel(s),
    embedModel: activeEmbedModel(s),
    openaiApiKey: s.openaiApiKey.trim() || undefined,
    anthropicApiKey: s.anthropicApiKey.trim() || undefined,
    ollamaBaseUrl: s.ollamaBaseUrl.trim() || undefined,
    timeoutMs: s.timeoutMs,
  };
}

function activeChatModel(s: PluginSettings): string {
  switch (s.chatProvider) {
    case 'openai':    return s.openaiChatModel;
    case 'anthropic': return s.anthropicChatModel;
    case 'ollama':    return s.ollamaChatModel;
  }
}

function activeEmbedModel(s: PluginSettings): string {
  switch (s.embedProvider) {
    case 'openai':    return s.openaiEmbedModel;
    case 'anthropic': return ''; // guarded upstream by validateSettings
    case 'ollama':    return s.ollamaEmbedModel;
  }
}
