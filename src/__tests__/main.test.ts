/**
 * VM-000 / VM-002 smoke tests for the VaultRAG plugin entry point.
 */

import { App, PluginManifest } from 'obsidian';
import VaultRAGPlugin from '../main';
import { DEFAULT_SETTINGS } from '../settings';

const mockApp = new App();
const mockManifest: PluginManifest = {
  id: 'vaultrag',
  name: 'VaultRAG',
  version: '0.1.0',
  minAppVersion: '1.4.0',
  description: 'RAG for your Obsidian vault',
  author: 'VaultRAG',
  isDesktopOnly: true,
};

describe('VaultRAGPlugin', () => {
  it('exports a default class', () => {
    expect(VaultRAGPlugin).toBeDefined();
    expect(typeof VaultRAGPlugin).toBe('function');
  });

  it('instantiates without throwing', () => {
    expect(() => new VaultRAGPlugin(mockApp, mockManifest)).not.toThrow();
  });

  it('exposes app and manifest from the Plugin base class', () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    expect(plugin.app).toBe(mockApp);
    expect(plugin.manifest).toBe(mockManifest);
  });

  it('has an onload method', () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    expect(typeof plugin.onload).toBe('function');
  });

  it('has an onunload method', () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    expect(typeof plugin.onunload).toBe('function');
  });

  it('onload resolves without throwing', async () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    await expect(plugin.onload()).resolves.toBeUndefined();
  });

  it('onunload executes without throwing', () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    expect(() => plugin.onunload()).not.toThrow();
  });

  // ── Settings wiring ───────────────────────────────────────────────────────

  it('initialises settings to defaults before onload', () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('loadSettings() populates defaults when loadData returns null', async () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    // mock loadData returns null by default
    await plugin.loadSettings();
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('loadSettings() merges persisted data over defaults', async () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    (plugin.loadData as jest.Mock).mockResolvedValueOnce({ openaiApiKey: 'sk-stored' });
    await plugin.loadSettings();
    expect(plugin.settings.openaiApiKey).toBe('sk-stored');
    expect(plugin.settings.chatProvider).toBe(DEFAULT_SETTINGS.chatProvider);
  });

  it('saveSettings() calls saveData with current settings', async () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    await plugin.loadSettings();
    plugin.settings.openaiApiKey = 'sk-new';
    await plugin.saveSettings();
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ openaiApiKey: 'sk-new' }),
    );
  });

  it('onload() registers the settings tab via addSettingTab', async () => {
    const plugin = new VaultRAGPlugin(mockApp, mockManifest);
    await plugin.onload();
    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
  });
});
