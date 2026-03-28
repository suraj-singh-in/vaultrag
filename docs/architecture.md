# Architecture

## Overview

VaultRAG is structured as a standard Obsidian plugin with a layered architecture. Each layer has a single responsibility and communicates through typed interfaces.

```
┌─────────────────────────────────────────────────────────┐
│                        Obsidian                         │
│            (Plugin API, Vault, Workspace)               │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                  VaultRAGPlugin (main.ts)                │
│  • Lifecycle: onload / onunload                         │
│  • Settings persistence                                 │
│  • Infrastructure init (lazy, singleton promise)        │
│  • Command & view registration                          │
└──────┬─────────────────┬──────────────────┬─────────────┘
       │                 │                  │
┌──────▼──────┐  ┌───────▼───────┐  ┌──────▼──────────────┐
│  UI Layer   │  │  RAG Layer    │  │  Provider Layer      │
│             │  │               │  │                      │
│ ChatView    │  │ VaultIndexer  │  │ OpenAIProvider       │
│ DashModal   │  │ Retriever     │  │ ClaudeProvider       │
│ SettingsTab │  │ Chunker       │  │ OllamaProvider       │
└──────┬──────┘  └───────┬───────┘  └──────────────────────┘
       │                 │
       └────────┬────────┘
                │
       ┌────────▼────────┐
       │   Store Layer   │
       │                 │
       │  VectraStore    │
       │  (index.json)   │
       └─────────────────┘
```

---

## Module Breakdown

### `src/main.ts` — Plugin Entry Point

The root class `VaultRAGPlugin` extends Obsidian's `Plugin`. Its responsibilities are:

- **Settings** — load from `data.json` on startup, save on every mutation.
- **Infrastructure** — lazily initialize `VectraStore`, `VaultIndexer`, and `Retriever` via a singleton promise (`_infraPromise`). Concurrent callers share one initialization attempt; failures reset the promise so the next call retries.
- **View factory** — register `ChatView` under `VIEW_TYPE_CHAT`. The factory creates a lazy-store proxy so the view can be restored from a saved workspace before infrastructure has finished opening.
- **Commands** — `toggle-chat`, `open-dashboard`, `reindex-vault`.

**Infrastructure init sequence:**

```
ensureInfrastructure()
  └── _buildInfrastructure()
        ├── buildStateAdapter()   → StateAdapter (read/write vaultrag-state.json)
        ├── buildVectraStore()    → VectraStore (indexPath from vault.adapter.basePath)
        ├── store.open()          → creates or loads index.json
        └── buildIndexer()        → VaultIndexer (with embed provider from settings)
```

---

### `src/providers/` — AI Provider Layer

All providers implement one or both of two interfaces:

```typescript
interface ChatProvider {
  chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
}

interface EmbedProvider {
  embed(texts: string[], opts: EmbedOptions): Promise<number[][]>;
}
```

Providers are instantiated by `factory.ts` based on the active settings. Chat and embed providers are selected independently — a user can chat with Anthropic while embedding with OpenAI.

**Streaming formats:**

| Provider | Protocol | Format |
|---|---|---|
| OpenAI | HTTPS SSE | `data: {"choices":[{"delta":{"content":"..."}}]}` |
| Anthropic | HTTPS SSE | `event: content_block_delta\ndata: {"delta":{"text":"..."}}` |
| Ollama | HTTPS NDJSON | `{"message":{"content":"..."},"done":false}` |

**Error hierarchy:**

```
ProviderError
  ├── ProviderAuthError      (HTTP 401 — invalid API key)
  ├── ProviderNetworkError   (network failure, retryable flag)
  └── ProviderRateLimitError (HTTP 429, retryAfterMs from header)
```

---

### `src/rag/` — RAG Pipeline

#### Chunker (`chunker.ts`)

Converts a raw markdown string into overlapping token-window chunks with heading metadata.

**Algorithm:**

1. Strip YAML frontmatter (`---\n…\n---`).
2. Split into sections at ATX heading boundaries (`#`, `##`, etc.).
3. For each section, maintain a heading breadcrumb array.
4. Apply a sliding token window within each section:
   - Window: `chunkSize` tokens (default 512)
   - Stride: `chunkSize - chunkOverlap` tokens (default 461)
   - Overlap is bounded to the current section — it never crosses a heading.
5. Each chunk carries: `text`, `tokenCount`, `filePath`, `headings[]`, `charOffset`.

Token counting uses `gpt-tokenizer` with the `cl100k_base` encoding, which is compatible with both OpenAI and Ollama embedding models.

#### Indexer (`indexer.ts`)

Orchestrates the index build and update lifecycle.

**`indexAll(onProgress?)` pipeline:**

```
1. Load IndexerState (mtimes, chunkIds) from vaultrag-state.json
2. List all .md files in the vault
3. For each file:
   a. Compare TFile.stat.mtime with stored mtime
   b. If unchanged → skip (increment skipped counter)
   c. If new or modified:
      i.  cachedRead(file) → raw markdown
      ii. chunkNote(content, filePath) → Chunk[]
      iii. EmbedProvider.embed(texts, batchSize=64) → number[][]
      iv. VectraStore.upsert() for each chunk vector (embed-first safety)
      v.  VectraStore.delete() for each old chunkId
      vi. Update IndexerState
4. StateAdapter.save(state) → vaultrag-state.json
5. Return IndexAllResult { indexed, skipped, errors }
```

**Embed-first safety:** All embedding batches are fetched and stored before any old chunks for the same file are deleted. If the embed API call fails, the old index data remains intact.

**Delta indexing state (`IndexerState`):**

```typescript
interface IndexerState {
  mtimes:   Record<string, number>;   // filePath → last known mtime
  chunkIds: Record<string, string[]>; // filePath → list of chunk IDs in the index
}
```

Stored at `<vault>/.obsidian/vaultrag-state.json` (separate from the vector index).

#### Retriever (`retriever.ts`)

Handles query-time retrieval and prompt assembly.

**`retrieve(query)` pipeline:**

```
1. EmbedProvider.embed([query]) → queryVector
2. VectraStore.search(queryVector, topK) → SearchResult[]
3. Sort by descending cosine similarity score
4. Return ContextChunk[] (text, filePath, headings, score, chunkIndex)
```

**`buildPrompt(query, chunks, activeNote?)` assembly:**

```xml
[system]
  You are a highly reliable, context-aware AI assistant...
  [CONTEXT USAGE RULES, GROUNDING, ANSWER STYLE, TONE]

[user]
  <active-note path="Current Note.md">     ← if open and not already in chunks
    [full note content]
  </active-note>

  <vault-context>
    <item index="1" path="Notes/Foo.md" headings="H1 > H2" score="0.8412">
      [chunk text]
    </item>
    ...
  </vault-context>

  [user query text]
```

**Token budget trimming:** If the assembled context exceeds `maxContextTokens`, the lowest-scoring chunks are dropped one by one until it fits. The active note is never trimmed.

---

### `src/store/` — Vector Store Layer

`VectorStore<M>` is a minimal interface:

```typescript
interface VectorStore<M> {
  open():                        Promise<void>;
  close():                       Promise<void>;
  upsert(item: VectorItem<M>):   Promise<void>;
  delete(id: string):            Promise<void>;
  search(v: number[], k: number): Promise<SearchResult<M>[]>;
  size():                        Promise<number>;
}
```

`VectraStore` implements this using the `vectra` library's `LocalIndex`. All writes are immediately durable — vectra atomically rewrites `index.json` inside each `beginUpdate / endUpdate` pair. No explicit flush is needed.

**Item ID format:** `<filePath>:<chunkIndex>` — stable across re-indexes of the same file.

**Metadata stored per item:**

```typescript
{
  text:       string,  // raw chunk text
  filePath:   string,  // vault-relative path
  headings:   string,  // JSON-serialised string[]
  chunkIndex: number,  // within-file position
}
```

---

### `src/ui/` — UI Layer

| Component | Base Class | Purpose |
|---|---|---|
| `ChatView` | `ItemView` | Right-sidebar chat panel, registered under `vaultrag-chat` |
| `DashboardModal` | `Modal` | Index status, per-file listing, cost estimate, re-index trigger |
| `SettingsTab` | `PluginSettingTab` | Provider/model config, API key inputs, test connections |
| `FloatingChatPanel` | `Component` | Floating overlay alternative (not currently wired in) |

**ChatView lifecycle:**

```
onOpen()
  ├── load chatHistory from plugin.settings
  ├── buildDOM()       → header, messages area, input row
  └── hydrate()        → re-render persisted history messages
       └── (if empty)  → showEmptyState() with 5 random suggestion chips

sendMessage(query)
  ├── hideEmptyState()
  ├── appendUserBubble(query)
  ├── retriever.retrieve(query)    → ContextChunk[]
  ├── retriever.buildPrompt(...)   → ChatMessage[]
  ├── chatProvider.chat(messages)  → stream tokens
  ├── MarkdownRenderer.renderMarkdown(fullResponse)
  ├── appendSourcesBlock(sources)  → clickable file links
  ├── appendCopyButton(content)    → clipboard + copy-to-note
  └── saveHistory()
```

---

## Data Flow Diagram

```
          ┌─────────────┐
          │  User types │
          │   a query   │
          └──────┬──────┘
                 │
         ChatView.sendMessage()
                 │
         ┌───────▼────────┐
         │   Retriever    │
         │  .retrieve()   │
         └───────┬────────┘
                 │
         EmbedProvider         ← same provider/model used during indexing
         .embed([query])
                 │
         ┌───────▼────────┐
         │  VectraStore   │
         │  .search()     │     cosine similarity
         └───────┬────────┘
                 │ top-K chunks
         token budget trimming
                 │
         Retriever.buildPrompt()
                 │ ChatMessage[]
         ┌───────▼────────┐
         │  ChatProvider  │
         │   .chat()      │     streaming
         └───────┬────────┘
                 │ token stream
         ChatView renders markdown
         + source links → open file on click
```

---

## Key Design Decisions

**Separate chat and embed providers** — Anthropic offers no embedding API. Keeping them as separate configured fields allows any combination rather than forcing a single-provider constraint.

**Lazy infrastructure with singleton promise** — `_infraPromise` ensures concurrent callers (ribbon click, restored workspace view, warm-up) share one initialization attempt. A failure resets it so the next caller triggers a retry.

**Lazy store proxy in view factory** — Obsidian restores saved workspace views synchronously during `onload`, before the background `open()` completes. The proxy forwards all calls through `ensureInfrastructure()` so the first user message always waits for a ready store.

**Delta indexing with separate state file** — Comparing mtimes in `IndexerState` avoids scanning the vector index for every file on startup. The state file is small (one entry per note) vs. the index which contains all chunk vectors.

**Embed-first safety** — Fetching and storing new embeddings before deleting old ones means a provider outage mid-index leaves the vault searchable with its previous data.

**XML context tagging** — Structured XML tags (`<vault-context>`, `<item>`, `<active-note>`) give the model unambiguous boundaries between context items and expose source attribution metadata (path, headings, score) that the model can cite.
