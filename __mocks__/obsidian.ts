/**
 * Manual mock for the Obsidian API.
 *
 * Rules:
 *   1. Only mock the API surface that VaultRAG actually uses.
 *   2. Extend this file — do NOT replace it — as new Obsidian APIs are consumed.
 *   3. All method stubs use jest.fn() so tests can spy/assert on them.
 *   4. No document.createElement calls; use typed stubs for HTMLElement fields
 *      so this mock works in the `node` Jest environment without jsdom.
 */

// ── Shared minimal types ─────────────────────────────────────────────────────
// Declared here (not imported from `obsidian`) to avoid circular resolution.

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface Command {
  id: string;
  name: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean | void;
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

// ── File abstractions ────────────────────────────────────────────────────────

export class TAbstractFile {
  path: string = '';
  name: string = '';
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension: string = 'md';
  basename: string = '';
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot = jest.fn<boolean, []>().mockReturnValue(false);
}

// ── Vault ────────────────────────────────────────────────────────────────────

export class Vault {
  getMarkdownFiles = jest.fn<TFile[], []>().mockReturnValue([]);
  getFiles = jest.fn<TAbstractFile[], []>().mockReturnValue([]);
  read = jest.fn<Promise<string>, [TFile]>().mockResolvedValue('');
  cachedRead = jest.fn<Promise<string>, [TFile]>().mockResolvedValue('');
  create = jest.fn<Promise<TFile>, [string, string]>().mockResolvedValue(new TFile());
  modify = jest.fn<Promise<void>, [TFile, string]>().mockResolvedValue(undefined);
  delete = jest.fn<Promise<void>, [TAbstractFile, boolean?]>().mockResolvedValue(undefined);
  adapter = {
    read: jest.fn<Promise<string>, [string]>().mockResolvedValue(''),
    write: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
    exists: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(false),
  };
}

// ── MetadataCache ────────────────────────────────────────────────────────────

export class MetadataCache {
  getFileCache = jest.fn().mockReturnValue(null);
  getCache = jest.fn().mockReturnValue(null);
  on = jest.fn();
  off = jest.fn();
}

// ── Workspace ────────────────────────────────────────────────────────────────

export class WorkspaceLeaf {
  view: unknown = null;
  setViewState = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
}

export class Workspace {
  getLeaf = jest.fn<WorkspaceLeaf, []>().mockReturnValue(new WorkspaceLeaf());
  getLeavesOfType = jest.fn<WorkspaceLeaf[], [string]>().mockReturnValue([]);
  revealLeaf = jest.fn<Promise<void>, [WorkspaceLeaf]>().mockResolvedValue(undefined);
  getActiveViewOfType = jest.fn<unknown, [unknown]>().mockReturnValue(null);
  on = jest.fn();
  off = jest.fn();
}

// ── App ──────────────────────────────────────────────────────────────────────

export class App {
  vault = new Vault();
  metadataCache = new MetadataCache();
  workspace = new Workspace();
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class Plugin {
  app: App;
  manifest: PluginManifest;

  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  /** Lifecycle — overridden by subclasses. */
  onload(): void | Promise<void> {}
  /** Lifecycle — overridden by subclasses. */
  onunload(): void {}

  addCommand = jest.fn((command: Command): Command => command);
  addRibbonIcon = jest.fn<HTMLElement, [string, string, (evt: MouseEvent) => void]>(
    () => ({} as HTMLElement),
  );
  loadData = jest.fn<Promise<unknown>, []>().mockResolvedValue(null);
  saveData = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
  registerView = jest.fn<void, [string, unknown]>();
  registerExtensions = jest.fn<void, [string[], string]>();
  addSettingTab = jest.fn();
}

// ── Obsidian-extended HTMLElement stub ────────────────────────────────────────
// Obsidian adds extra methods to HTMLElement globally (empty, createEl, etc.).
// This factory creates a minimal stub usable in the node test environment.

/** Creates a minimal child element stub with full chaining support. */
function createChildStub(): Record<string, unknown> {
  const child: Record<string, unknown> = {
    empty: jest.fn(),
    createEl: jest.fn().mockImplementation(() => createChildStub()),
    createDiv: jest.fn().mockImplementation(() => createChildStub()),
    setText: jest.fn().mockReturnThis(),
    setAttr: jest.fn().mockReturnThis(),
    addClass: jest.fn().mockReturnThis(),
    appendChild: jest.fn().mockReturnThis(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    innerHTML: '',
    textContent: '',
    placeholder: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
  };
  return child;
}

export function createMockEl(): HTMLElement {
  const el: Record<string, unknown> = {
    empty: jest.fn(),
    createEl: jest.fn().mockImplementation(() => createChildStub()),
    createDiv: jest.fn().mockImplementation(() => createChildStub()),
    setText: jest.fn().mockReturnThis(),
    setAttr: jest.fn().mockReturnThis(),
    addClass: jest.fn().mockReturnThis(),
    appendChild: jest.fn().mockReturnThis(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    innerHTML: '',
    textContent: '',
    placeholder: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
  };
  return el as unknown as HTMLElement;
}

// ── ItemView ──────────────────────────────────────────────────────────────────

/**
 * Base class for sidebar views in Obsidian.
 * Subclasses must implement getViewType, getDisplayText, onOpen, onClose.
 */
export class ItemView {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  app: App;
  leaf: WorkspaceLeaf;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = new App();
    this.containerEl = createMockEl();
    this.contentEl = createMockEl();
  }

  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  getIcon(): string { return ''; }

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}

  registerEvent = jest.fn();
  register = jest.fn();
  addAction = jest.fn();
}

// ── MarkdownRenderer ──────────────────────────────────────────────────────────

export class MarkdownRenderer {
  static renderMarkdown = jest.fn<Promise<void>, [string, HTMLElement, string, unknown]>()
    .mockResolvedValue(undefined);
}

// ── MarkdownView ──────────────────────────────────────────────────────────────

export class MarkdownView extends ItemView {
  file: TFile | null = null;
  getViewData = jest.fn<string, []>().mockReturnValue('');
  editor = {
    replaceRange: jest.fn<void, [string, { line: number; ch: number }]>(),
    lastLine: jest.fn<number, []>().mockReturnValue(0),
    getLine: jest.fn<string, [number]>().mockReturnValue(''),
  };
}

// ── UI stubs ─────────────────────────────────────────────────────────────────

export class Modal {
  app: App;
  contentEl: HTMLElement = createMockEl();

  constructor(app: App) {
    this.app = app;
  }

  open = jest.fn();
  close = jest.fn();
  onOpen(): void {}
  onClose(): void {}
}

/**
 * Notice is exported as a jest.fn() (not a class) so tests can assert on
 * constructor invocations: `expect(Notice).toHaveBeenCalledWith(...)`.
 * The type annotation satisfies TypeScript's `new (...)` call sites.
 */
export const Notice: new (message: string, timeout?: number) => {
  hide: jest.Mock;
  setMessage: jest.Mock;
} = jest.fn().mockImplementation(() => ({
  hide: jest.fn(),
  setMessage: jest.fn(),
})) as unknown as new (message: string, timeout?: number) => {
  hide: jest.Mock;
  setMessage: jest.Mock;
};

export class PluginSettingTab {
  app: App;
  containerEl: HTMLElement;

  constructor(app: App, _plugin: Plugin) {
    this.app = app;
    this.containerEl = createMockEl();
  }

  display(): void {}
  hide(): void {}
}

// ── Setting component stubs ──────────────────────────────────────────────────
// Each stub supports method chaining and — crucially for coverage — executes
// the onChange callback immediately with the current value so inline arrow
// functions like `(value) => plugin.save({...})` are counted as covered.
// onClick is NOT auto-called (it would trigger async provider network probes).

function makeTextStub(): {
  setPlaceholder: jest.Mock;
  setValue: jest.Mock;
  onChange: jest.Mock;
  getValue: jest.Mock;
} {
  let value = '';
  const stub = {
    setPlaceholder: jest.fn(),
    setValue: jest.fn(),
    onChange: jest.fn(),
    getValue: jest.fn(),
  };
  stub.setPlaceholder.mockReturnValue(stub);
  stub.setValue.mockImplementation((v: string) => { value = v; return stub; });
  stub.onChange.mockImplementation((fn: (v: string) => unknown) => { fn(value); return stub; });
  stub.getValue.mockImplementation(() => value);
  return stub;
}

function makeDropdownStub(): {
  addOption: jest.Mock;
  setValue: jest.Mock;
  onChange: jest.Mock;
} {
  let value = '';
  const stub = {
    addOption: jest.fn(),
    setValue: jest.fn(),
    onChange: jest.fn(),
  };
  stub.addOption.mockReturnValue(stub);
  stub.setValue.mockImplementation((v: string) => { value = v; return stub; });
  stub.onChange.mockImplementation((fn: (v: string) => unknown) => { fn(value); return stub; });
  return stub;
}

function makeButtonStub(): {
  setButtonText: jest.Mock;
  onClick: jest.Mock;
  setClass: jest.Mock;
  setDisabled: jest.Mock;
} {
  const stub = {
    setButtonText: jest.fn(),
    onClick: jest.fn(),    // stores fn but does NOT call it (async side-effects)
    setClass: jest.fn(),
    setDisabled: jest.fn(),
  };
  stub.setButtonText.mockReturnValue(stub);
  stub.onClick.mockReturnValue(stub);
  stub.setClass.mockReturnValue(stub);
  stub.setDisabled.mockReturnValue(stub);
  return stub;
}

export class Setting {
  settingEl: HTMLElement = createMockEl();
  controlEl: HTMLElement = createMockEl();

  constructor(_containerEl: HTMLElement) {}

  setName = jest.fn().mockReturnThis();
  setDesc = jest.fn().mockReturnThis();

  addText = jest.fn().mockImplementation((cb: (text: ReturnType<typeof makeTextStub>) => unknown) => {
    cb(makeTextStub());
    return this;
  });

  addTextArea = jest.fn().mockImplementation((cb: (text: ReturnType<typeof makeTextStub>) => unknown) => {
    cb(makeTextStub());
    return this;
  });

  addDropdown = jest.fn().mockImplementation(
    (cb: (dd: ReturnType<typeof makeDropdownStub>) => unknown) => {
      cb(makeDropdownStub());
      return this;
    },
  );

  addButton = jest.fn().mockImplementation(
    (cb: (btn: ReturnType<typeof makeButtonStub>) => unknown) => {
      cb(makeButtonStub());
      return this;
    },
  );

  addToggle = jest.fn().mockReturnThis();
  addSlider = jest.fn().mockReturnThis();
}

// ── Utilities ────────────────────────────────────────────────────────────────

export const normalizePath = jest.fn((path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+/g, '/'),
);
