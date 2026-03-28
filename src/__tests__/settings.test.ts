import {
  applyDefaults,
  validateSettings,
  toProviderSettings,
  DEFAULT_SETTINGS,
  type PluginSettings,
} from '../settings';

// ── applyDefaults() ───────────────────────────────────────────────────────────

describe('applyDefaults()', () => {
  it('returns full defaults when passed an empty object', () => {
    expect(applyDefaults({})).toEqual(DEFAULT_SETTINGS);
  });

  it('overrides only the specified fields', () => {
    const result = applyDefaults({ openaiApiKey: 'sk-test', timeoutMs: 30_000 });
    expect(result.openaiApiKey).toBe('sk-test');
    expect(result.timeoutMs).toBe(30_000);
    expect(result.chatProvider).toBe(DEFAULT_SETTINGS.chatProvider);
  });

  it('fills any missing field with the default value', () => {
    const result = applyDefaults({ chatProvider: 'openai' });
    expect(result.openaiChatModel).toBe(DEFAULT_SETTINGS.openaiChatModel);
    expect(result.ollamaBaseUrl).toBe(DEFAULT_SETTINGS.ollamaBaseUrl);
  });

  it('does not mutate DEFAULT_SETTINGS', () => {
    const snapshot = { ...DEFAULT_SETTINGS };
    applyDefaults({ chatProvider: 'anthropic' });
    expect(DEFAULT_SETTINGS).toEqual(snapshot);
  });

  it('treats null (missing data.json) the same as empty object', () => {
    // loadData() returns null when no data.json exists; simulate that here.
    const loadDataResult: Partial<PluginSettings> | null = null;
    const result = applyDefaults(loadDataResult ?? {});
    expect(result).toEqual(DEFAULT_SETTINGS);
  });
});

// ── validateSettings() ────────────────────────────────────────────────────────

describe('validateSettings()', () => {
  describe('valid cases', () => {
    it('passes with default (Ollama) settings', () => {
      expect(validateSettings(DEFAULT_SETTINGS).valid).toBe(true);
    });

    it('passes when OpenAI is chat provider and key is provided', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        openaiApiKey: 'sk-live',
      };
      expect(validateSettings(s).valid).toBe(true);
    });

    it('passes when Anthropic is chat provider and key is provided', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'anthropic',
        anthropicApiKey: 'sk-ant-live',
      };
      expect(validateSettings(s).valid).toBe(true);
    });

    it('passes with http Ollama URL', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        ollamaBaseUrl: 'http://localhost:11434',
      };
      expect(validateSettings(s).valid).toBe(true);
    });

    it('passes with https Ollama URL', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        ollamaBaseUrl: 'https://my-ollama.example.com:8080',
      };
      expect(validateSettings(s).valid).toBe(true);
    });

    it('ignores invalid Ollama URL when Ollama is not selected as either provider', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        openaiApiKey: 'sk-live',
        embedProvider: 'openai',
        ollamaBaseUrl: 'not-a-url', // irrelevant — ollama not in use
      };
      expect(validateSettings(s).valid).toBe(true);
    });
  });

  describe('invalid cases', () => {
    it('rejects empty OpenAI key when OpenAI is chat provider', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        openaiApiKey: '',
      };
      const r = validateSettings(s);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('OpenAI'))).toBe(true);
    });

    it('rejects whitespace-only OpenAI key', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        openaiApiKey: '   ',
      };
      expect(validateSettings(s).valid).toBe(false);
    });

    it('rejects empty OpenAI key when OpenAI is embed provider', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        embedProvider: 'openai',
        openaiApiKey: '',
      };
      const r = validateSettings(s);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('OpenAI'))).toBe(true);
    });

    it('rejects empty Anthropic key when Anthropic is chat provider', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'anthropic',
        anthropicApiKey: '',
      };
      const r = validateSettings(s);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('Anthropic'))).toBe(true);
    });

    it('rejects Anthropic as embed provider (no embed API)', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        embedProvider: 'anthropic',
      };
      const r = validateSettings(s);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.toLowerCase().includes('embed'))).toBe(true);
    });

    it('rejects a non-URL Ollama base URL', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        ollamaBaseUrl: 'not-a-url',
      };
      expect(validateSettings(s).valid).toBe(false);
    });

    it('rejects ftp:// Ollama URL', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        ollamaBaseUrl: 'ftp://localhost:11434',
      };
      expect(validateSettings(s).valid).toBe(false);
    });

    it('rejects empty Ollama URL when Ollama is in use', () => {
      const s: PluginSettings = { ...DEFAULT_SETTINGS, ollamaBaseUrl: '' };
      expect(validateSettings(s).valid).toBe(false);
    });

    it('collects multiple errors simultaneously', () => {
      const s: PluginSettings = {
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        openaiApiKey: '',
        embedProvider: 'openai', // same empty key → two errors
      };
      expect(validateSettings(s).errors.length).toBeGreaterThanOrEqual(2);
    });

    it('returns errors array when invalid', () => {
      const r = validateSettings({
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        openaiApiKey: '',
      });
      expect(Array.isArray(r.errors)).toBe(true);
      expect(r.errors.length).toBeGreaterThan(0);
    });
  });
});

// ── toProviderSettings() ──────────────────────────────────────────────────────

describe('toProviderSettings()', () => {
  it('selects openai chat model when openai is chat provider', () => {
    const s: PluginSettings = {
      ...DEFAULT_SETTINGS,
      chatProvider: 'openai',
      openaiChatModel: 'gpt-4o',
    };
    expect(toProviderSettings(s).chatModel).toBe('gpt-4o');
  });

  it('selects anthropic chat model when anthropic is chat provider', () => {
    const s: PluginSettings = {
      ...DEFAULT_SETTINGS,
      chatProvider: 'anthropic',
      anthropicChatModel: 'claude-sonnet-4-6',
    };
    expect(toProviderSettings(s).chatModel).toBe('claude-sonnet-4-6');
  });

  it('selects ollama chat model when ollama is chat provider', () => {
    const s: PluginSettings = {
      ...DEFAULT_SETTINGS,
      chatProvider: 'ollama',
      ollamaChatModel: 'llama3',
    };
    expect(toProviderSettings(s).chatModel).toBe('llama3');
  });

  it('selects openai embed model when openai is embed provider', () => {
    const s: PluginSettings = {
      ...DEFAULT_SETTINGS,
      embedProvider: 'openai',
      openaiEmbedModel: 'text-embedding-3-small',
    };
    expect(toProviderSettings(s).embedModel).toBe('text-embedding-3-small');
  });

  it('selects ollama embed model when ollama is embed provider', () => {
    const s: PluginSettings = {
      ...DEFAULT_SETTINGS,
      embedProvider: 'ollama',
      ollamaEmbedModel: 'nomic-embed-text',
    };
    expect(toProviderSettings(s).embedModel).toBe('nomic-embed-text');
  });

  it('converts empty openaiApiKey to undefined', () => {
    const s: PluginSettings = { ...DEFAULT_SETTINGS, openaiApiKey: '' };
    expect(toProviderSettings(s).openaiApiKey).toBeUndefined();
  });

  it('preserves a non-empty openaiApiKey', () => {
    const s: PluginSettings = { ...DEFAULT_SETTINGS, openaiApiKey: 'sk-live' };
    expect(toProviderSettings(s).openaiApiKey).toBe('sk-live');
  });

  it('converts empty anthropicApiKey to undefined', () => {
    const s: PluginSettings = { ...DEFAULT_SETTINGS, anthropicApiKey: '' };
    expect(toProviderSettings(s).anthropicApiKey).toBeUndefined();
  });

  it('passes timeoutMs through', () => {
    const s: PluginSettings = { ...DEFAULT_SETTINGS, timeoutMs: 30_000 };
    expect(toProviderSettings(s).timeoutMs).toBe(30_000);
  });
});

// ── round-trip ────────────────────────────────────────────────────────────────

describe('JSON round-trip (simulate data.json serialize → load)', () => {
  it('preserves all fields through JSON serialisation', () => {
    const original: PluginSettings = {
      ...DEFAULT_SETTINGS,
      chatProvider: 'openai',
      openaiApiKey: 'sk-live-key',
      anthropicApiKey: 'sk-ant-live',
      timeoutMs: 30_000,
    };
    const restored = applyDefaults(
      JSON.parse(JSON.stringify(original)) as Partial<PluginSettings>,
    );
    expect(restored).toEqual(original);
  });

  it('restores unknown keys from future versions without crashing', () => {
    const futureData = { ...DEFAULT_SETTINGS, unknownFutureKey: 'value' };
    expect(() => applyDefaults(futureData as Partial<PluginSettings>)).not.toThrow();
  });
});
