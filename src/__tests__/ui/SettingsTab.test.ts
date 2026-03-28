/**
 * SettingsTab tests.
 *
 * Strategy: test the internal logic (save patching, test-connection flow)
 * directly via private-method access (cast to `any`) rather than simulating
 * DOM events — the mock Setting class doesn't execute callbacks.
 *
 * Factory calls are mocked to keep tests fast and deterministic.
 */

import { App, Notice } from 'obsidian';
import { VaultRAGSettingsTab } from '../../ui/SettingsTab';
import { DEFAULT_SETTINGS } from '../../settings';
import { getChatProvider, getEmbedProvider } from '../../providers/factory';
import { ProviderAuthError, ProviderNetworkError } from '../../providers/base';

// ── Mock factory ──────────────────────────────────────────────────────────────
jest.mock('../../providers/factory');

const mockGetChatProvider = getChatProvider as jest.MockedFunction<typeof getChatProvider>;
const mockGetEmbedProvider = getEmbedProvider as jest.MockedFunction<typeof getEmbedProvider>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPlugin(overrides: Record<string, unknown> = {}) {
  return {
    app: new App(),
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTab(plugin = makeMockPlugin()) {
  return new VaultRAGSettingsTab(new App(), plugin as never);
}

// Notice is already a jest.fn() in __mocks__/obsidian.ts — cast to access mock API.
const MockNotice = Notice as unknown as jest.Mock;

// ── Construction ──────────────────────────────────────────────────────────────

describe('VaultRAGSettingsTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('constructs without throwing', () => {
    expect(() => makeTab()).not.toThrow();
  });

  // ── display() ───────────────────────────────────────────────────────────────

  describe('display()', () => {
    it('does not throw', () => {
      const tab = makeTab();
      expect(() => tab.display()).not.toThrow();
    });

    it('calls containerEl.empty() to clear stale content', () => {
      const tab = makeTab();
      tab.display();
      expect((tab.containerEl as unknown as { empty: jest.Mock }).empty).toHaveBeenCalledTimes(1);
    });

    it('can be called multiple times without throwing (re-render)', () => {
      const tab = makeTab();
      expect(() => {
        tab.display();
        tab.display();
      }).not.toThrow();
    });
  });

  // ── save() ──────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('merges the patch into plugin.settings', () => {
      const plugin = makeMockPlugin();
      const tab = makeTab(plugin);
      (tab as never as { save(p: object): void }).save({ openaiApiKey: 'sk-new' });
      expect(plugin.settings.openaiApiKey).toBe('sk-new');
    });

    it('calls plugin.saveSettings()', () => {
      const plugin = makeMockPlugin();
      const tab = makeTab(plugin);
      (tab as never as { save(p: object): void }).save({ timeoutMs: 30_000 });
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it('shows a Notice when validation fails after save', () => {
      const plugin = makeMockPlugin();
      const tab = makeTab(plugin);
      // Saving an empty API key while OpenAI is the chat provider → validation error
      (tab as never as { save(p: object): void }).save({
        chatProvider: 'openai',
        openaiApiKey: '',
      });
      expect(MockNotice).toHaveBeenCalled();
    });

    it('does NOT show a Notice when validation passes', () => {
      const plugin = makeMockPlugin();
      const tab = makeTab(plugin);
      (tab as never as { save(p: object): void }).save({ timeoutMs: 45_000 });
      expect(MockNotice).not.toHaveBeenCalled();
    });
  });

  // ── testChatConnection() ────────────────────────────────────────────────────

  describe('testChatConnection()', () => {
    it('shows a success Notice when the provider returns a token', async () => {
      const mockProvider = {
        providerId: 'openai' as const,
        chat: jest.fn().mockImplementation(async function* () {
          yield 'hello';
        }),
      };
      mockGetChatProvider.mockReturnValue(mockProvider as never);

      const plugin = makeMockPlugin({ settings: { ...DEFAULT_SETTINGS, openaiApiKey: 'sk-live' } });
      const tab = makeTab(plugin);
      await (tab as never as { testChatConnection(p: string): Promise<void> }).testChatConnection('openai');

      expect(MockNotice).toHaveBeenCalled();
      const msg = MockNotice.mock.calls[0][0] as string;
      expect(msg).toContain('successful');
    });

    it('shows an error Notice when the factory throws ProviderAuthError', async () => {
      mockGetChatProvider.mockImplementation(() => {
        throw new ProviderAuthError('openai');
      });

      const tab = makeTab();
      await (tab as never as { testChatConnection(p: string): Promise<void> }).testChatConnection('openai');

      expect(MockNotice).toHaveBeenCalled();
      const msg = MockNotice.mock.calls[0][0] as string;
      expect(msg).toContain('openai');
    });

    it('shows an error Notice when the chat call throws ProviderNetworkError', async () => {
      const mockProvider = {
        providerId: 'ollama' as const,
        chat: jest.fn().mockImplementation(async function* () {
          throw new ProviderNetworkError('ollama', 'Connection refused', true);
          yield ''; // unreachable, satisfies generator type
        }),
      };
      mockGetChatProvider.mockReturnValue(mockProvider as never);

      const tab = makeTab();
      await (tab as never as { testChatConnection(p: string): Promise<void> }).testChatConnection('ollama');

      expect(MockNotice).toHaveBeenCalled();
      const msg = MockNotice.mock.calls[0][0] as string;
      expect(msg).toContain('Connection refused');
    });
  });

  // ── testEmbedConnection() ───────────────────────────────────────────────────

  describe('testEmbedConnection()', () => {
    it('shows a success Notice when embed returns vectors', async () => {
      const mockProvider = {
        providerId: 'openai' as const,
        embed: jest.fn().mockResolvedValue([[0.1, 0.2]]),
      };
      mockGetEmbedProvider.mockReturnValue(mockProvider as never);

      const plugin = makeMockPlugin({ settings: { ...DEFAULT_SETTINGS, openaiApiKey: 'sk-live' } });
      const tab = makeTab(plugin);
      await (tab as never as { testEmbedConnection(p: string): Promise<void> }).testEmbedConnection('openai');

      expect(MockNotice).toHaveBeenCalled();
      const msg = MockNotice.mock.calls[0][0] as string;
      expect(msg).toContain('successful');
    });

    it('shows an error Notice when factory throws for unsupported provider', async () => {
      mockGetEmbedProvider.mockImplementation(() => {
        throw new ProviderNetworkError('anthropic', 'Anthropic does not provide an embed API', false);
      });

      const tab = makeTab();
      await (tab as never as { testEmbedConnection(p: string): Promise<void> }).testEmbedConnection(
        'anthropic',
      );

      expect(MockNotice).toHaveBeenCalled();
    });

    it('shows an error Notice when embed call fails', async () => {
      const mockProvider = {
        providerId: 'openai' as const,
        embed: jest.fn().mockRejectedValue(new ProviderAuthError('openai')),
      };
      mockGetEmbedProvider.mockReturnValue(mockProvider as never);

      const tab = makeTab();
      await (tab as never as { testEmbedConnection(p: string): Promise<void> }).testEmbedConnection('openai');

      expect(MockNotice).toHaveBeenCalled();
    });
  });
});
