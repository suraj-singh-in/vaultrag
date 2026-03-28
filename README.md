# VaultRAG

Retrieval-Augmented Generation for your Obsidian vault. Chat with your notes using multi-provider AI — OpenAI, Anthropic Claude, or a fully local Ollama setup.

---

## Key Features

- **Chat with your vault** — Ask questions in natural language; VaultRAG retrieves the most relevant chunks from your notes and uses them as context for the AI response.
- **Multi-provider AI** — Switch between OpenAI (GPT-4o), Anthropic Claude, and Ollama (local/private). Chat and embed providers are configured independently.
- **Fully local option** — Run everything on-device with Ollama. No API keys, no data leaves your machine.
- **Delta indexing** — Only new or modified notes are re-embedded on each index run. Unchanged notes are skipped.
- **Active-note context** — The note currently open in the editor is automatically injected as highest-priority context.
- **Source attribution** — Every AI response links back to the exact vault files it drew from. Click a source to open the note.
- **Index dashboard** — See per-file status (indexed / failed / not indexed), last run stats, estimated embedding cost, and trigger a full re-index.
- **Resizable sidebar panel** — Chat lives in Obsidian's native right sidebar and pushes editor content — it does not overlay.
- **Persistent history** — Conversation history survives plugin reloads and vault restarts.
- **Custom system prompt** — Override the built-in prompt with your own instructions.
- **Token budget** — Context is capped at a configurable token limit; lowest-scoring chunks are dropped first.

---

## Supported Providers

| Provider | Chat | Embedding | Auth |
|---|---|---|---|
| **OpenAI** | GPT-4o, GPT-4o mini, o1, o3-mini | text-embedding-3-small / large, ada-002 | API key |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | — not supported | API key |
| **Ollama** | llama3, mistral, gemma2, … | nomic-embed-text, mxbai-embed-large, … | None (local) |

> Anthropic does not offer an embedding API. When using Anthropic for chat, choose OpenAI or Ollama as the embed provider.

---

## Quick Start

1. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vaultrag/`.
2. Enable the plugin in **Settings → Community plugins**.
3. Open **Settings → VaultRAG** and configure your provider (Ollama works out of the box with no key).
4. Run **VaultRAG: Re-index vault** from the command palette.
5. Click the chat icon in the ribbon or run **VaultRAG: Toggle chat panel**.

See [docs/install.md](docs/install.md) for the full installation guide.

---

## Documentation

| Document | Description |
|---|---|
| [docs/install.md](docs/install.md) | Installation, prerequisites, and first-run setup |
| [docs/architecture.md](docs/architecture.md) | System design, RAG pipeline, and module overview |
| [docs/providers.md](docs/providers.md) | Provider configuration, supported models, and API key setup |
| [docs/configuration.md](docs/configuration.md) | All settings fields with types, defaults, and descriptions |
| [docs/development.md](docs/development.md) | Build setup, running tests, and contributing |

---

## How It Works

```
User query
    │
    ▼
EmbedProvider.embed(query)          ← same model used to index your notes
    │
    ▼
VectraStore.search(queryVector, topK)
    │
    ▼
Token budget trimming               ← lowest-score chunks dropped first
    │
    ▼
Prompt assembly
  <active-note>   ← currently open note (highest priority)
  <vault-context> ← top-K retrieved chunks with path + headings
  <user query>
    │
    ▼
ChatProvider.chat(messages)         ← streams response token by token
    │
    ▼
Markdown-rendered response + source links
```

See [docs/architecture.md](docs/architecture.md) for a detailed breakdown.

---

## Commands

| Command | Description |
|---|---|
| `VaultRAG: Toggle chat panel` | Open / collapse the right-sidebar chat |
| `VaultRAG: Open index dashboard` | View per-file index status and run stats |
| `VaultRAG: Re-index vault` | Embed all new and modified notes |

---

## Roadmap

### v0.2 — Performance
- [ ] Batch `beginUpdate` / `endUpdate` per file instead of per chunk (faster indexing)
- [ ] Parallel embedding batches with concurrency limit
- [ ] Incremental state saves (write only changed entries, not full state)
- [ ] Background auto-index on file save / rename / delete events

### v0.3 — Retrieval Quality
- [ ] Hybrid search: combine vector similarity with BM25 keyword ranking
- [ ] Re-ranking pass (cross-encoder or LLM-based) on top-K results
- [ ] Configurable minimum similarity threshold (filter low-confidence chunks)
- [ ] Per-folder index exclusion rules

### v0.4 — Chat Experience
- [ ] Multi-turn conversation context (send recent turns to the model)
- [ ] Named chat sessions / conversation history browser
- [ ] Inline citations rendered inside the response text
- [ ] Image attachment support for multimodal models

### v0.5 — Extensibility
- [ ] Plugin API so other Obsidian plugins can query VaultRAG programmatically
- [ ] Export conversation as a new note
- [ ] Webhook / MCP server mode for external tooling
- [ ] Mobile support (remove `isDesktopOnly` restriction)

---

## Requirements

- Obsidian ≥ 1.4.0
- Node.js ≥ 20 (build only)
- Desktop only (uses Node.js `fs` for the vector index)
- One of: OpenAI API key, Anthropic API key, or a running Ollama server

---

## License

MIT
