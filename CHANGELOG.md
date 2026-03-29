# Changelog

All notable changes to VaultRAG are documented here.

---

## [0.0.1] — 2026-03-29 · First Alpha Release

### Core RAG Pipeline

- **Vector indexing** — Markdown notes are chunked using a token sliding window (512 tokens, 51-token overlap) that respects heading boundaries and preserves a heading breadcrumb per chunk
- **Delta indexing** — Only new or modified files (by `mtime`) are re-embedded on each run; unchanged files are skipped
- **Embed-first safety** — New embeddings are stored before old chunks for the same file are deleted, so a failed API call leaves the existing index intact
- **Retrieval** — Query is embedded with the same model used during indexing; top-K nearest chunks are fetched by cosine similarity and assembled into a structured XML prompt
- **Token budget** — Context block is capped at a configurable token limit; lowest-scoring chunks are dropped first when the budget is exceeded
- **Active-note injection** — The currently open note is injected as highest-priority context and excluded from the retrieval results to avoid duplication

### AI Provider Support

- **OpenAI** — Chat (GPT-4o, GPT-4o mini, o1, o3-mini) and embedding (text-embedding-3-small, text-embedding-3-large, ada-002) via streaming SSE
- **Anthropic Claude** — Chat only (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5) via streaming SSE; no embedding API available
- **Ollama** — Local chat and embedding (llama3, mistral, gemma2 / nomic-embed-text, mxbai-embed-large) via NDJSON streaming; no API key required
- **Independent provider selection** — Chat and embed providers are configured separately; any supported combination works
- **Injectable fetch** — All providers accept a `fetchFn` parameter, enabling deterministic unit testing without global monkey-patching
- **Fixed illegal invocation** — `globalThis.fetch` is now bound correctly in all three providers to prevent "fetch on window illegal invocation" errors

### Chat UI

- **Right sidebar panel** — Chat opens in Obsidian's native right sidebar via `workspace.getRightLeaf(false)`, pushing editor content rather than overlaying it; resizable by dragging the sidebar edge
- **Toggle behavior** — Ribbon icon and command palette entry expand the sidebar if collapsed, collapse it if open
- **Streaming with live markdown** — Response tokens are throttled through `MarkdownRenderer.renderMarkdown` every 80 ms so headings, code blocks, and lists appear formatted as the response streams in
- **Typing indicator** — Three bouncing dots appear in the assistant bubble while waiting for the first token; removed on first token arrival
- **Send button disabled during stream** — Button is disabled for the entire duration of a streaming response; re-enabled in `finally` so it always recovers on error
- **Enter to send / Shift+Enter for newline** — Enter key is also blocked while streaming
- **Source attribution** — Every assistant response lists the vault files used as context; clicking a source opens the file in the editor
- **Copy button** — Icon-only button copies response text to clipboard with a 1.5 s green flash confirmation
- **Copy to note button** — Appends the response to the currently open note; falls back to any open markdown leaf when the chat panel itself is focused
- **Text selection** — `user-select: text` applied to all message content so partial selection works despite Obsidian's sidebar-level `user-select: none`
- **Scrollable messages** — `overflow: scroll` with `height: calc(100% - 120px)` and `min-height: 0` on the messages container; input row is `position: sticky; bottom: 0`

### Empty State & First-Run Experience

- **Unindexed state** — When no index exists, the chat panel shows 📂 with an explanation and a **Re-index vault** button instead of the suggestion chips
- **Re-index progress** — Clicking Re-index vault disables the button, shows a live progress bar and `"N / total files"` counter that updates as each file is processed; subscribes to the plugin's progress emitter so it works even when re-indexing was triggered from the command palette
- **Auto-refresh on completion** — Empty state switches from the unindexed view to the suggestion chips automatically once indexing finishes
- **Suggestion chips** — When the vault is indexed, 5 questions are randomly picked from a pool of 20 note-related prompts; clicking a chip pastes it into the input
- **Mid-chat guard** — If a message is sent before indexing, an inline `[!warning]` callout is shown explaining what to do; no API call is made

### History & Compaction

- **Persistent history** — Conversation turns are saved to `data.json` after every message and restored on panel open
- **50-message cap with auto-compaction** — When history reaches 50 turns, the oldest 40 are summarised by the chat provider (max 512 tokens); the summary replaces those turns and is injected into every subsequent system prompt inside `<conversation-summary>` tags
- **Summary marker** — A visual divider ("⬆ Earlier conversation summarised") is inserted in the chat UI with a collapsible "View summary" section
- **Graceful compaction failure** — If the summarisation request fails, the old turns are silently truncated without a summary rather than blocking the chat
- **Clear history** — Clears both history and the stored summary; restores the empty state

### Index Dashboard

- **Per-file status** — Modal showing each vault file as indexed / failed / not indexed
- **Last run snapshot** — Timestamp, file counts (indexed, skipped, failed), and individual error messages
- **Embedding cost estimate** — Token-based cost table for OpenAI models (text-embedding-3-small, text-embedding-3-large, ada-002)
- **Re-index trigger** — Button in the dashboard triggers a full re-index with a progress bar

### Settings

- **Provider dropdowns** — Separate selectors for chat provider and embed provider
- **Per-provider fields** — API key, chat model, and embed model for OpenAI and Anthropic; base URL, chat model, and embed model for Ollama
- **Test connection** — Chat and embed test buttons send a minimal request and surface errors inline
- **Retrieval tuning** — `topK` (default 5), `maxContextTokens` (default 3000), custom system prompt
- **Timeout** — Global request timeout (default 60 000 ms) applied via `AbortController`
- **Validation** — Settings are validated on save; first error surfaced as an Obsidian Notice

### Infrastructure & Architecture

- **Lazy infrastructure init** — Store, indexer, and retriever are built on first use; `onload` never throws
- **Singleton promise** — `ensureInfrastructure()` returns the same promise to concurrent callers; failure resets it so the next call retries
- **Lazy store proxy in view factory** — Obsidian restores saved workspace views before infrastructure completes; the proxy forwards all store calls through `ensureInfrastructure()` to guarantee a ready store at query time
- **Corruption recovery** — Corrupt `index.json` is detected on open and rebuilt automatically with a Notice
- **State file** — `vaultrag-state.json` stores per-file mtimes and chunk IDs separately from the vector index for fast delta comparisons

### Documentation

- `README.md` — Key features, provider table, quick start, how-it-works diagram, commands, and versioned roadmap
- `docs/install.md` — Prerequisites, manual install, first-run setup for all three providers, file locations, update instructions
- `docs/architecture.md` — Module breakdown, RAG pipeline walkthrough, data flow diagram, key design decisions
- `docs/providers.md` — Per-provider model tables, API key setup, mixing providers, test connection guide
- `docs/configuration.md` — Every settings field with type, default, and description
- `docs/development.md` — Build setup, live reload, test stack, mock strategy, adding a new provider, release process
- `versions.json` — Plugin version to minimum Obsidian version mapping (required for community plugin submission)
- `CHANGELOG.md` — This file

### Bug Fixes

- **Fetch illegal invocation** — All three providers now use `globalThis.fetch.bind(globalThis)` to prevent detached-reference errors when Obsidian calls the stored fetch function
- **VectraStore not opened** — View factory created an un-opened store fallback; replaced with a lazy proxy that awaits `ensureInfrastructure()` at query time
- **Copy to note fails when chat is focused** — `getActiveViewOfType(MarkdownView)` returns null when the sidebar panel is the active view; now falls back to `getLeavesOfType('markdown')` to find any open note
- **Messages not scrolling** — `min-height: auto` on the flex child prevented the messages container from shrinking; fixed with `min-height: 0` and `overflow: scroll`
- **Source links did nothing** — `<a href="#">` anchors had no handler; now use `vault.getFileByPath` + `leaf.openFile` with an `openLinkText` fallback

---

## Roadmap

See [README.md](README.md#roadmap) for planned features in v0.2 through v0.5.
