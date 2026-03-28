/**
 * main.ts wiring tests — infrastructure setup, commands, view factory.
 *
 * Modules that touch the filesystem (VectraStore) or make network calls
 * (providers) are mocked so these tests run fast and deterministically.
 */

import { App, Notice, WorkspaceLeaf } from 'obsidian';
import type { PluginManifest } from 'obsidian';

// ── Module mocks (hoisted by Jest before imports) ─────────────────────────────

jest.mock('../store/vectraStore', () => ({
  VectraStore: jest.fn().mockImplementation(() => ({
    open:   jest.fn().mockResolvedValue(undefined),
    close:  jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    size:   jest.fn().mockResolvedValue(0),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../rag/indexer', () => ({
  VaultIndexer: jest.fn().mockImplementation(() => ({
    indexAll:   jest.fn().mockResolvedValue({ indexed: 3, skipped: 1, errors: [] }),
    indexFile:  jest.fn().mockResolvedValue(true),
    removeFile: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../providers/factory', () => ({
  getChatProvider: jest.fn().mockReturnValue({
    providerId: 'ollama',
    chat: jest.fn(),
  }),
  getEmbedProvider: jest.fn().mockReturnValue({
    providerId: 'ollama',
    embed: jest.fn().mockResolvedValue([[0.1, 0.2]]),
  }),
}));

jest.mock('../rag/retriever', () => ({
  Retriever: jest.fn().mockImplementation(() => ({
    retrieve:     jest.fn().mockResolvedValue([]),
    buildPrompt:  jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../ui/DashboardModal', () => ({
  DashboardModal: jest.fn().mockImplementation(() => ({
    open:  jest.fn(),
    close: jest.fn(),
  })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import VaultRAGPlugin from '../main';
import { VectraStore } from '../store/vectraStore';
import { VaultIndexer } from '../rag/indexer';
import { getChatProvider, getEmbedProvider } from '../providers/factory';
import { DashboardModal } from '../ui/DashboardModal';
import { ProviderAuthError } from '../providers/base';

const MockVectraStore    = VectraStore    as jest.MockedClass<typeof VectraStore>;
const MockVaultIndexer   = VaultIndexer   as jest.MockedClass<typeof VaultIndexer>;
const MockGetChatProvider = getChatProvider as jest.MockedFunction<typeof getChatProvider>;
const MockGetEmbedProvider = getEmbedProvider as jest.MockedFunction<typeof getEmbedProvider>;
const MockDashboardModal = DashboardModal as jest.MockedClass<typeof DashboardModal>;
const MockNotice         = Notice         as unknown as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

const MANIFEST: PluginManifest = {
  id: 'vaultrag', name: 'VaultRAG', version: '0.1.0',
  minAppVersion: '1.4.0', description: '', author: 'VaultRAG',
};

function makeApp(): App {
  const app = new App();
  // Provide basePath so buildVectraStore() doesn't throw
  (app.vault.adapter as unknown as Record<string, unknown>).basePath = '/mock/vault';
  // Stub configDir (normally ".obsidian" in Obsidian)
  (app.vault as unknown as Record<string, unknown>).configDir = '.obsidian';
  return app;
}

async function makeLoadedPlugin(app = makeApp()): Promise<VaultRAGPlugin> {
  const plugin = new VaultRAGPlugin(app, MANIFEST);
  await plugin.onload();
  return plugin;
}

/** Extracts an addCommand callback by command id. */
function getCommandCallback(plugin: VaultRAGPlugin, id: string): () => void {
  const call = (plugin.addCommand as jest.Mock).mock.calls.find(
    ([cmd]: [{ id: string }]) => cmd.id === id,
  );
  return call?.[0]?.callback as () => void;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── onload registrations ──────────────────────────────────────────────────────

describe('onload() registrations', () => {
  it('registers the chat view type', async () => {
    const plugin = await makeLoadedPlugin();
    expect(plugin.registerView).toHaveBeenCalledWith('vaultrag-chat', expect.any(Function));
  });

  it('adds a ribbon icon', async () => {
    const plugin = await makeLoadedPlugin();
    expect(plugin.addRibbonIcon).toHaveBeenCalledWith(
      'message-square', 'Open VaultRAG Chat', expect.any(Function),
    );
  });

  it('registers open-chat command', async () => {
    const plugin = await makeLoadedPlugin();
    expect(plugin.addCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'open-chat' }),
    );
  });

  it('registers open-dashboard command', async () => {
    const plugin = await makeLoadedPlugin();
    expect(plugin.addCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'open-dashboard' }),
    );
  });

  it('registers reindex-vault command', async () => {
    const plugin = await makeLoadedPlugin();
    expect(plugin.addCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reindex-vault' }),
    );
  });
});

// ── ensureInfrastructure() ────────────────────────────────────────────────────

describe('ensureInfrastructure()', () => {
  it('opens the VectraStore on first call', async () => {
    const plugin = await makeLoadedPlugin();
    // Fire-and-forget from onload may not have resolved yet — call directly
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    // The most recent VectraStore instance had open() called
    const instance = MockVectraStore.mock.results[MockVectraStore.mock.results.length - 1]?.value as { open: jest.Mock };
    expect(instance?.open).toHaveBeenCalled();
  });

  it('returns true on success and populates this.store', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    const result = await ensure.call(plugin);
    expect(result).toBe(true);
    expect((plugin as unknown as { store: unknown }).store).not.toBeNull();
  });

  it('shows a Notice and returns false when store.open() rejects', async () => {
    // Use a fresh plugin (no onload) so we control the first ensureInfrastructure call
    MockVectraStore.mockImplementationOnce(() => ({
      open: jest.fn().mockRejectedValue(new Error('disk full')),
      close: jest.fn(),
    }) as never);

    const plugin = new VaultRAGPlugin(makeApp(), MANIFEST);
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    const result = await ensure.call(plugin);

    expect(result).toBe(false);
    expect(MockNotice).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('is idempotent — second call returns same Promise, VectraStore constructed once', async () => {
    // Fresh plugin, no fire-and-forget interference
    const plugin = new VaultRAGPlugin(makeApp(), MANIFEST);
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;

    const p1 = ensure.call(plugin);
    const p2 = ensure.call(plugin); // concurrent second call
    expect(p1).toBe(p2);           // same Promise object

    await p1;
    expect(MockVectraStore).toHaveBeenCalledTimes(1);
  });

  it('creates a VaultIndexer after opening the store', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);
    expect(MockVaultIndexer).toHaveBeenCalled();
  });
});

// ── buildStateAdapter() ───────────────────────────────────────────────────────

describe('buildStateAdapter()', () => {
  it('returns empty IndexerState when state file does not exist', async () => {
    const app = makeApp();
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
    const plugin = await makeLoadedPlugin(app);
    const adapter = (plugin as unknown as { buildStateAdapter: () => { load: () => Promise<unknown> } }).buildStateAdapter;
    const sa = adapter.call(plugin);
    const state = await sa.load();
    expect(state).toEqual({ mtimes: {}, chunkIds: {} });
  });

  it('reads and parses the state file when it exists', async () => {
    const app = makeApp();
    const stored = { mtimes: { 'a.md': 1 }, chunkIds: { 'a.md': ['a:0'] } };
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.read as jest.Mock).mockResolvedValue(JSON.stringify(stored));
    const plugin = await makeLoadedPlugin(app);
    const adapter = (plugin as unknown as { buildStateAdapter: () => { load: () => Promise<unknown> } }).buildStateAdapter;
    const sa = adapter.call(plugin);
    const state = await sa.load();
    expect(state).toEqual(stored);
  });

  it('returns empty state when JSON parse fails', async () => {
    const app = makeApp();
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.read as jest.Mock).mockResolvedValue('not valid json {{{');
    const plugin = await makeLoadedPlugin(app);
    const adapter = (plugin as unknown as { buildStateAdapter: () => { load: () => Promise<unknown> } }).buildStateAdapter;
    const sa = adapter.call(plugin);
    const state = await sa.load();
    expect(state).toEqual({ mtimes: {}, chunkIds: {} });
  });

  it('writes serialised JSON on save()', async () => {
    const app = makeApp();
    const plugin = await makeLoadedPlugin(app);
    const adapter = (plugin as unknown as { buildStateAdapter: () => { save: (s: unknown) => Promise<void> } }).buildStateAdapter;
    const sa = adapter.call(plugin);
    const state = { mtimes: { 'b.md': 2 }, chunkIds: { 'b.md': ['b:0'] } };
    await sa.save(state);
    expect(app.vault.adapter.write).toHaveBeenCalledWith(
      expect.stringContaining('vaultrag-state.json'),
      JSON.stringify(state),
    );
  });
});

// ── activateChatView() ────────────────────────────────────────────────────────

describe('activateChatView() via open-chat command', () => {
  it('creates a new leaf when no chat leaf exists', async () => {
    const app = makeApp();
    (app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([]);
    const plugin = await makeLoadedPlugin(app);
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    const cb = getCommandCallback(plugin, 'open-chat');
    await (cb as unknown as () => Promise<void>)();

    expect(app.workspace.getLeaf).toHaveBeenCalled();
    expect(app.workspace.revealLeaf).toHaveBeenCalled();
  });

  it('reveals the existing leaf when the chat view is already open', async () => {
    const app = makeApp();
    const existingLeaf = new WorkspaceLeaf();
    (app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([existingLeaf]);
    const plugin = await makeLoadedPlugin(app);
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    const cb = getCommandCallback(plugin, 'open-chat');
    await (cb as unknown as () => Promise<void>)();

    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    // No new leaf should have been created
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
  });

  it('does nothing when ensureInfrastructure fails', async () => {
    const plugin = await makeLoadedPlugin();
    // Override ensureInfrastructure to return false (simulates all failure paths)
    (plugin as unknown as Record<string, unknown>).ensureInfrastructure =
      jest.fn().mockResolvedValue(false);

    const cb = getCommandCallback(plugin, 'open-chat');
    await (cb as unknown as () => Promise<void>)();

    // Workspace methods should not have been called
    expect(plugin.app.workspace.getLeaf).not.toHaveBeenCalled();
  });
});

// ── openDashboard() ───────────────────────────────────────────────────────────

describe('openDashboard() via open-dashboard command', () => {
  it('creates and opens a DashboardModal', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    const cb = getCommandCallback(plugin, 'open-dashboard');
    await (cb as unknown as () => Promise<void>)();

    expect(MockDashboardModal).toHaveBeenCalled();
    const instance = MockDashboardModal.mock.results[0]?.value as { open: jest.Mock };
    expect(instance.open).toHaveBeenCalled();
  });

  it('does nothing when ensureInfrastructure fails', async () => {
    const plugin = await makeLoadedPlugin();
    (plugin as unknown as Record<string, unknown>).ensureInfrastructure =
      jest.fn().mockResolvedValue(false);

    const cb = getCommandCallback(plugin, 'open-dashboard');
    await (cb as unknown as () => Promise<void>)();

    expect(MockDashboardModal).not.toHaveBeenCalled();
  });
});

// ── runReIndex() ──────────────────────────────────────────────────────────────

describe('runReIndex() via reindex-vault command', () => {
  it('calls indexer.indexAll()', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    const cb = getCommandCallback(plugin, 'reindex-vault');
    await (cb as unknown as () => Promise<void>)();

    const indexer = (plugin as unknown as { indexer: { indexAll: jest.Mock } }).indexer;
    expect(indexer.indexAll).toHaveBeenCalled();
  });

  it('shows a start Notice and a completion Notice', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    // Capture callback BEFORE clearing mocks
    const cb = getCommandCallback(plugin, 'reindex-vault');
    jest.clearAllMocks(); // reset Notice call count only after capturing cb

    await (cb as unknown as () => Promise<void>)();

    expect(MockNotice).toHaveBeenCalledTimes(2);
    const calls = MockNotice.mock.calls as string[][];
    expect(calls[0][0]).toMatch(/starting re-index/i);
    expect(calls[1][0]).toMatch(/re-index complete/i);
  });

  it('includes error count in the completion Notice when files fail', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    // Configure the indexer instance created during infrastructure setup
    const indexerInstance = (plugin as unknown as { indexer: { indexAll: jest.Mock } }).indexer;
    indexerInstance.indexAll.mockResolvedValueOnce({
      indexed: 1, skipped: 0,
      errors: [{ file: 'bad.md', error: new Error('timeout') }],
    });

    // Capture callback BEFORE clearing mocks
    const cb = getCommandCallback(plugin, 'reindex-vault');
    jest.clearAllMocks();

    await (cb as unknown as () => Promise<void>)();

    const completionMsg = (MockNotice.mock.calls[1] as string[])[0];
    expect(completionMsg).toMatch(/1 failed/);
  });
});

// ── createChatView() ──────────────────────────────────────────────────────────

describe('createChatView() — view factory', () => {
  it('constructs a ChatView when providers are valid', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    const factory = (plugin.registerView as jest.Mock).mock.calls[0][1] as (leaf: WorkspaceLeaf) => unknown;
    expect(() => factory(new WorkspaceLeaf())).not.toThrow();
  });

  it('shows a Notice and rethrows when getChatProvider throws', async () => {
    MockGetChatProvider.mockImplementationOnce(() => {
      throw new ProviderAuthError('openai');
    });

    const plugin = await makeLoadedPlugin();
    const factory = (plugin.registerView as jest.Mock).mock.calls[0][1] as (leaf: WorkspaceLeaf) => unknown;

    expect(() => factory(new WorkspaceLeaf())).toThrow();
    expect(MockNotice).toHaveBeenCalledWith(expect.any(String));
  });
});

// ── onunload() ────────────────────────────────────────────────────────────────

describe('onunload()', () => {
  it('closes the store when it is open', async () => {
    const plugin = await makeLoadedPlugin();
    const ensure = (plugin as unknown as { ensureInfrastructure: () => Promise<boolean> }).ensureInfrastructure;
    await ensure.call(plugin);

    plugin.onunload();

    const instance = MockVectraStore.mock.results[MockVectraStore.mock.results.length - 1]?.value as { close: jest.Mock };
    expect(instance?.close).toHaveBeenCalled();
  });

  it('does not throw when store is null', async () => {
    const plugin = new VaultRAGPlugin(makeApp(), MANIFEST);
    expect(() => plugin.onunload()).not.toThrow();
  });
});
