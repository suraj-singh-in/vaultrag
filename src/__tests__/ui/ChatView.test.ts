/**
 * ChatView tests.
 *
 * Strategy: test business logic directly (sendMessage, clearHistory,
 * copyToNote) by injecting mocked retriever and chatProvider.  DOM
 * assertions are limited to what's observable without jsdom — primarily
 * MarkdownRenderer.renderMarkdown calls and history/saveSettings state.
 */

import {
  App,
  Notice,
  WorkspaceLeaf,
  MarkdownRenderer,
  MarkdownView,
} from 'obsidian';
import { ChatView, VIEW_TYPE_CHAT } from '../../ui/ChatView';
import { DEFAULT_SETTINGS } from '../../settings';
import type { StoredMessage } from '../../settings';
import type { Retriever, ContextChunk } from '../../rag/retriever';
import type { ChatProvider } from '../../providers/base';

// ── Async generator helper ────────────────────────────────────────────────────

async function* tokenStream(tokens: string[]): AsyncIterable<string> {
  for (const t of tokens) yield t;
}

// ── Factories ─────────────────────────────────────────────────────────────────

function makeChunks(overrides: Partial<ContextChunk>[] = []): ContextChunk[] {
  return overrides.map((o, i) => ({
    text: `chunk ${i}`,
    filePath: `note${i}.md`,
    headings: [],
    score: 0.9 - i * 0.1,
    chunkIndex: i,
    ...o,
  }));
}

function makeRetriever(chunks: ContextChunk[] = []): jest.Mocked<Retriever> {
  return {
    retrieve: jest.fn().mockResolvedValue(chunks),
    buildPrompt: jest.fn().mockReturnValue([
      { role: 'system', content: 'sys' },
      { role: 'user',   content: 'user msg' },
    ]),
  } as unknown as jest.Mocked<Retriever>;
}

function makeChatProvider(tokens: string[] = ['Hello', ' world']): jest.Mocked<ChatProvider> {
  return {
    providerId: 'ollama',
    chat: jest.fn().mockImplementation(() => tokenStream(tokens)),
  } as jest.Mocked<ChatProvider>;
}

function makePlugin(historyOverride: StoredMessage[] = []) {
  return {
    app: new App(),
    settings: {
      ...DEFAULT_SETTINGS,
      chatHistory: historyOverride,
    },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  };
}

function makeView(
  opts: {
    chunks?: ContextChunk[];
    tokens?: string[];
    history?: StoredMessage[];
  } = {},
) {
  const plugin  = makePlugin(opts.history ?? []);
  const retriever = makeRetriever(opts.chunks ?? []);
  const chatProvider = makeChatProvider(opts.tokens ?? ['Hello', ' world']);
  const leaf    = new WorkspaceLeaf();
  const view    = new ChatView(leaf, plugin as never, retriever, chatProvider);
  return { view, plugin, retriever, chatProvider };
}

const MockNotice = Notice as unknown as jest.Mock;
const MockMarkdownRenderer = MarkdownRenderer as unknown as {
  renderMarkdown: jest.Mock;
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Identity ──────────────────────────────────────────────────────────────────

describe('ChatView identity', () => {
  it('VIEW_TYPE_CHAT is vaultrag-chat', () => {
    expect(VIEW_TYPE_CHAT).toBe('vaultrag-chat');
  });

  it('getViewType returns vaultrag-chat', () => {
    const { view } = makeView();
    expect(view.getViewType()).toBe('vaultrag-chat');
  });

  it('getDisplayText returns a non-empty string', () => {
    const { view } = makeView();
    expect(view.getDisplayText().length).toBeGreaterThan(0);
  });

  it('getIcon returns a non-empty string', () => {
    const { view } = makeView();
    expect(view.getIcon().length).toBeGreaterThan(0);
  });
});

// ── onOpen() ──────────────────────────────────────────────────────────────────

describe('ChatView.onOpen()', () => {
  it('does not throw with an empty history', async () => {
    const { view } = makeView();
    await expect(view.onOpen()).resolves.not.toThrow();
  });

  it('loads chatHistory from plugin.settings into internal state', async () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'hi', sources: [], timestamp: 1 },
      { role: 'assistant', content: 'hello', sources: [], timestamp: 2 },
    ];
    const { view } = makeView({ history: stored });
    await view.onOpen();
    expect((view as never as { history: StoredMessage[] }).history).toHaveLength(2);
  });
});

// ── sendMessage() ─────────────────────────────────────────────────────────────

describe('ChatView.sendMessage()', () => {
  it('calls retriever.retrieve with the query', async () => {
    const { view, retriever } = makeView();
    await view.onOpen();
    await view.sendMessage('what is X?');
    expect(retriever.retrieve).toHaveBeenCalledWith('what is X?');
  });

  it('calls retriever.buildPrompt with the returned chunks', async () => {
    const chunks = makeChunks([{ filePath: 'a.md' }]);
    const { view, retriever } = makeView({ chunks });
    await view.onOpen();
    await view.sendMessage('query');
    // Third arg is activeNote — undefined when no markdown file is open
    expect(retriever.buildPrompt).toHaveBeenCalledWith('query', chunks, undefined);
  });

  it('calls chatProvider.chat with the built messages', async () => {
    const { view, chatProvider } = makeView();
    await view.onOpen();
    await view.sendMessage('query');
    expect(chatProvider.chat).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'sys' },
        { role: 'user',   content: 'user msg' },
      ],
      expect.objectContaining({ model: expect.any(String) }),
    );
  });

  it('calls MarkdownRenderer.renderMarkdown on completion', async () => {
    const { view } = makeView({ tokens: ['Hello', ' world'] });
    await view.onOpen();
    await view.sendMessage('query');
    expect(MockMarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
      'Hello world',
      expect.anything(),
      '',
      view,
    );
  });

  it('appends both user and assistant turns to history', async () => {
    const { view } = makeView({ tokens: ['response'] });
    await view.onOpen();
    await view.sendMessage('user query');

    const history = (view as never as { history: StoredMessage[] }).history;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'user query' });
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'response' });
  });

  it('stores source file paths on the assistant history entry', async () => {
    const chunks = makeChunks([{ filePath: 'vault/note.md' }, { filePath: 'vault/note.md' }]);
    const { view } = makeView({ chunks });
    await view.onOpen();
    await view.sendMessage('query');

    const history = (view as never as { history: StoredMessage[] }).history;
    const assistantMsg = history.find(m => m.role === 'assistant');
    expect(assistantMsg?.sources).toContain('vault/note.md');
  });

  it('calls plugin.saveSettings after a successful response', async () => {
    const { view, plugin } = makeView();
    await view.onOpen();
    await view.sendMessage('query');
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('persists the updated history to plugin.settings.chatHistory', async () => {
    const { view, plugin } = makeView({ tokens: ['answer'] });
    await view.onOpen();
    await view.sendMessage('question');
    expect(plugin.settings.chatHistory).toHaveLength(2);
  });
});

// ── sources block ─────────────────────────────────────────────────────────────

describe('ChatView sources', () => {
  it('deduplicates source paths in the history entry', async () => {
    const chunks = makeChunks([
      { filePath: 'same.md', chunkIndex: 0 },
      { filePath: 'same.md', chunkIndex: 1 },
      { filePath: 'other.md', chunkIndex: 0 },
    ]);
    const { view } = makeView({ chunks });
    await view.onOpen();
    await view.sendMessage('query');

    const history = (view as never as { history: StoredMessage[] }).history;
    const sources = history.find(m => m.role === 'assistant')?.sources ?? [];
    const uniqueSources = [...new Set(sources)];
    expect(sources.length).toBe(uniqueSources.length);
    expect(sources).toContain('same.md');
    expect(sources).toContain('other.md');
  });

  it('records empty sources array when no chunks returned', async () => {
    const { view } = makeView({ chunks: [] });
    await view.onOpen();
    await view.sendMessage('query');

    const history = (view as never as { history: StoredMessage[] }).history;
    expect(history.find(m => m.role === 'assistant')?.sources).toEqual([]);
  });
});

// ── clearHistory() ────────────────────────────────────────────────────────────

describe('ChatView.clearHistory()', () => {
  it('empties the internal history array', async () => {
    const { view } = makeView({ tokens: ['answer'] });
    await view.onOpen();
    await view.sendMessage('hello');

    view.clearHistory();

    const history = (view as never as { history: StoredMessage[] }).history;
    expect(history).toHaveLength(0);
  });

  it('calls plugin.saveSettings after clearing', async () => {
    const { view, plugin } = makeView();
    await view.onOpen();
    jest.clearAllMocks();

    view.clearHistory();

    await Promise.resolve(); // flush micro-tasks
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('updates plugin.settings.chatHistory to empty array', async () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'hi', sources: [], timestamp: 1 },
    ];
    const { view, plugin } = makeView({ history: stored });
    await view.onOpen();

    view.clearHistory();
    await Promise.resolve();

    expect(plugin.settings.chatHistory).toEqual([]);
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe('ChatView error handling', () => {
  it('calls MarkdownRenderer.renderMarkdown with a friendly message when provider throws', async () => {
    const { view, chatProvider } = makeView();
    chatProvider.chat.mockImplementation(() => {
      throw new Error('Network timeout');
    });
    await view.onOpen();
    await view.sendMessage('query');

    expect(MockMarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    const rendered: string = MockMarkdownRenderer.renderMarkdown.mock.calls[0][0] as string;
    expect(rendered).toContain('Network timeout');
    // Must not expose raw stack trace
    expect(rendered).not.toMatch(/^\s+at /m);
  });

  it('does not add to history when provider throws', async () => {
    const { view, chatProvider } = makeView();
    chatProvider.chat.mockImplementation(() => {
      throw new Error('fail');
    });
    await view.onOpen();
    await view.sendMessage('query');

    const history = (view as never as { history: StoredMessage[] }).history;
    expect(history.length).toBe(0);
  });

  it('renders a fallback message when the error has no message', async () => {
    const { view, chatProvider } = makeView();
    chatProvider.chat.mockImplementation(() => { throw 'string error'; });
    await view.onOpen();
    await view.sendMessage('query');

    const rendered: string = MockMarkdownRenderer.renderMarkdown.mock.calls[0][0] as string;
    expect(rendered.length).toBeGreaterThan(0);
  });
});

// ── copyToNote() ──────────────────────────────────────────────────────────────

describe('ChatView.copyToNote()', () => {
  it('calls editor.replaceRange with the content when an active note exists', async () => {
    const { view } = makeView();
    await view.onOpen();

    const mockEditor = {
      replaceRange: jest.fn(),
      lastLine: jest.fn().mockReturnValue(5),
      getLine: jest.fn().mockReturnValue('last line text'),
    };
    const mockMarkdownView = new MarkdownView(new WorkspaceLeaf());
    (mockMarkdownView as never as { editor: typeof mockEditor }).editor = mockEditor;

    (view.app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(mockMarkdownView);

    await view.copyToNote('assistant answer here');
    expect(mockEditor.replaceRange).toHaveBeenCalledWith(
      expect.stringContaining('assistant answer here'),
      expect.any(Object),
    );
  });

  it('shows a Notice when there is no active note', async () => {
    const { view } = makeView();
    await view.onOpen();
    (view.app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(null);

    await view.copyToNote('content');
    expect(MockNotice).toHaveBeenCalled();
  });
});
