# Installation

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Obsidian | ≥ 1.4.0 | Desktop app only |
| One AI provider | — | OpenAI key, Anthropic key, or Ollama running locally |
| Node.js | ≥ 20 | Build from source only |

VaultRAG uses Node.js `fs` for the vector index and is therefore **desktop-only**. It will not run in the Obsidian mobile app.

---

## Option A — Manual Install (Recommended)

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. In your vault, create the folder `.obsidian/plugins/vaultrag/` if it does not exist.
3. Copy the three files into that folder.
4. Open Obsidian → **Settings → Community plugins → Installed plugins**.
5. Toggle **VaultRAG** on.

---

## Option B — Build from Source

```bash
git clone <repo-url>
cd obsidian-rag
npm install
npm run build
```

Copy the output files to your vault:

```bash
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/vaultrag/
```

---

## First-Run Setup

### 1. Choose a Provider

Open **Settings → VaultRAG**. The default provider is Ollama (no API key needed).

**Ollama (local / private)**

1. Install Ollama from [ollama.com](https://ollama.com).
2. Pull a chat model: `ollama pull llama3`
3. Pull an embed model: `ollama pull nomic-embed-text`
4. Leave the base URL as `http://localhost:11434` unless you changed it.
5. Click **Test connection** to verify.

**OpenAI**

1. Set **Chat provider** and **Embed provider** both to OpenAI.
2. Paste your API key (starts with `sk-`).
3. Default models: `gpt-4o` (chat), `text-embedding-3-small` (embed).
4. Click **Test connection** to verify.

**Anthropic**

1. Set **Chat provider** to Anthropic.
2. Set **Embed provider** to OpenAI or Ollama (Anthropic has no embedding API).
3. Paste your Anthropic API key (starts with `sk-ant-`).
4. Click **Test connection** to verify.

### 2. Index Your Vault

Run **VaultRAG: Re-index vault** from the command palette (`Ctrl/Cmd+P`).

A notification appears when indexing is complete:

```
VaultRAG: re-index complete — 142 indexed, 0 skipped, 0 failed
```

You can monitor progress and per-file status in the **Index Dashboard** (`VaultRAG: Open index dashboard`).

### 3. Start Chatting

Click the chat icon (message-square) in the left ribbon, or run **VaultRAG: Toggle chat panel**. The chat opens in the right sidebar.

---

## File Locations

| File | Path |
|---|---|
| Vector index | `<vault>/.obsidian/vaultrag-index/index.json` |
| Indexer state (mtimes) | `<vault>/.obsidian/vaultrag-state.json` |
| Plugin settings | `<vault>/.obsidian/plugins/vaultrag/data.json` |

> **Vault sync:** Exclude `vaultrag-index/` and `vaultrag-state.json` from Obsidian Sync or Git — they are large binary-like files that are machine-specific and rebuilt on demand.

---

## Updating

Replace `main.js` and `styles.css` in `.obsidian/plugins/vaultrag/` with the new versions, then disable and re-enable the plugin (or use the Hot Reload community plugin).

The vector index and state files are forward-compatible. A re-index is only required if the chunking strategy changes between versions (noted in the changelog).
