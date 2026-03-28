import { getChatProvider, getEmbedProvider, type ProviderSettings } from '../../providers/factory';
import { OpenAIProvider } from '../../providers/openai';
import { ClaudeProvider } from '../../providers/claude';
import { OllamaProvider } from '../../providers/ollama';
import { ProviderAuthError, ProviderNetworkError } from '../../providers/base';

const BASE_SETTINGS: ProviderSettings = {
  chatProvider: 'openai',
  embedProvider: 'openai',
  chatModel: 'gpt-4o',
  embedModel: 'text-embedding-3-small',
  openaiApiKey: 'sk-test',
  anthropicApiKey: 'sk-ant-test',
  ollamaBaseUrl: 'http://localhost:11434',
};

describe('getChatProvider()', () => {
  it('returns an OpenAIProvider for chatProvider="openai"', () => {
    const p = getChatProvider({ ...BASE_SETTINGS, chatProvider: 'openai' });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.providerId).toBe('openai');
  });

  it('returns a ClaudeProvider for chatProvider="anthropic"', () => {
    const p = getChatProvider({ ...BASE_SETTINGS, chatProvider: 'anthropic' });
    expect(p).toBeInstanceOf(ClaudeProvider);
    expect(p.providerId).toBe('anthropic');
  });

  it('returns an OllamaProvider for chatProvider="ollama"', () => {
    const p = getChatProvider({ ...BASE_SETTINGS, chatProvider: 'ollama' });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerId).toBe('ollama');
  });

  it('throws ProviderAuthError when OpenAI key is missing', () => {
    expect(() =>
      getChatProvider({ ...BASE_SETTINGS, chatProvider: 'openai', openaiApiKey: undefined }),
    ).toThrow(ProviderAuthError);
  });

  it('throws ProviderAuthError when Anthropic key is missing', () => {
    expect(() =>
      getChatProvider({ ...BASE_SETTINGS, chatProvider: 'anthropic', anthropicApiKey: undefined }),
    ).toThrow(ProviderAuthError);
  });

  it('falls back to default Ollama URL when ollamaBaseUrl is undefined', () => {
    const p = getChatProvider({
      ...BASE_SETTINGS,
      chatProvider: 'ollama',
      ollamaBaseUrl: undefined,
    }) as OllamaProvider;
    expect(p).toBeInstanceOf(OllamaProvider);
  });

  it('uses custom timeoutMs when provided', () => {
    const p = getChatProvider({ ...BASE_SETTINGS, timeoutMs: 30_000 });
    expect(p).toBeDefined();
  });
});

describe('getEmbedProvider()', () => {
  it('returns an OpenAIProvider for embedProvider="openai"', () => {
    const p = getEmbedProvider({ ...BASE_SETTINGS, embedProvider: 'openai' });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.providerId).toBe('openai');
  });

  it('returns an OllamaProvider for embedProvider="ollama"', () => {
    const p = getEmbedProvider({ ...BASE_SETTINGS, embedProvider: 'ollama' });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerId).toBe('ollama');
  });

  it('throws ProviderNetworkError for embedProvider="anthropic" (no embed API)', () => {
    expect(() =>
      getEmbedProvider({ ...BASE_SETTINGS, embedProvider: 'anthropic' }),
    ).toThrow(ProviderNetworkError);
  });

  it('includes a helpful message when anthropic embed is requested', () => {
    expect(() =>
      getEmbedProvider({ ...BASE_SETTINGS, embedProvider: 'anthropic' }),
    ).toThrow(expect.objectContaining({ message: expect.stringContaining('embed') }));
  });

  it('throws ProviderAuthError when OpenAI key is missing for embed', () => {
    expect(() =>
      getEmbedProvider({ ...BASE_SETTINGS, embedProvider: 'openai', openaiApiKey: undefined }),
    ).toThrow(ProviderAuthError);
  });
});
