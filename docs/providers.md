# Providers

VaultRAG supports three AI providers. Chat and embedding are configured independently — you can mix providers (e.g. Anthropic for chat + OpenAI for embeddings).

---

## OpenAI

**Requires:** API key (starts with `sk-`)

### Chat Models

| Model | Context | Notes |
|---|---|---|
| `gpt-4o` (default) | 128k | Best quality, multimodal |
| `gpt-4o-mini` | 128k | Faster, cheaper |
| `o1` | 200k | Reasoning model |
| `o3-mini` | 200k | Compact reasoning |

### Embed Models

| Model | Dimensions | Price (per 1M tokens) |
|---|---|---|
| `text-embedding-3-small` (default) | 1536 | $0.020 |
| `text-embedding-3-large` | 3072 | $0.130 |
| `text-embedding-ada-002` | 1536 | $0.100 |

`text-embedding-3-small` is the recommended choice — it is cheaper than ada-002 and more capable.

### Configuration

```
Settings → VaultRAG → OpenAI

API Key:        sk-...
Chat model:     gpt-4o
Embed model:    text-embedding-3-small
```

### Getting an API Key

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. Go to **API Keys → Create new secret key**.
3. Copy the key immediately — it is only shown once.

---

## Anthropic

**Requires:** API key (starts with `sk-ant-`)

**Note:** Anthropic does not provide an embedding API. When using Anthropic for chat, you must set the embed provider to OpenAI or Ollama.

### Chat Models

| Model | Context | Notes |
|---|---|---|
| `claude-sonnet-4-6` (default) | 200k | Best balance of speed and quality |
| `claude-opus-4-6` | 200k | Highest capability |
| `claude-haiku-4-5-20251001` | 200k | Fastest, lowest cost |

### Configuration

```
Settings → VaultRAG → Anthropic

API Key:        sk-ant-...
Chat model:     claude-sonnet-4-6
Embed provider: OpenAI or Ollama  ← must not be Anthropic
```

### Getting an API Key

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. Go to **API Keys → Create Key**.
3. Copy the key.

---

## Ollama (Local)

**Requires:** Ollama running locally. No API key needed.

Ollama runs models entirely on your machine. No data leaves your device.

### Installation

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows: download installer from https://ollama.com
```

### Recommended Models

**Chat:**

| Model | Size | Notes |
|---|---|---|
| `llama3` (default) | 4.7 GB | Meta Llama 3 8B — good general purpose |
| `mistral` | 4.1 GB | Fast, good instruction following |
| `gemma2` | 5.4 GB | Google Gemma 2 9B |

**Embedding:**

| Model | Dimensions | Notes |
|---|---|---|
| `nomic-embed-text` (default) | 768 | Fast, high quality, 8192 token context |
| `mxbai-embed-large` | 1024 | Higher quality, slower |

### Pulling Models

```bash
ollama pull llama3
ollama pull nomic-embed-text
```

### Configuration

```
Settings → VaultRAG → Ollama

Base URL:     http://localhost:11434
Chat model:   llama3
Embed model:  nomic-embed-text
```

The base URL can be changed if Ollama is running on a different port or a remote host.

### Verifying Ollama is Running

```bash
ollama list          # shows installed models
curl http://localhost:11434/api/tags   # should return JSON
```

---

## Mixing Providers

Because chat and embedding are configured separately, you can combine providers:

| Use Case | Chat Provider | Embed Provider |
|---|---|---|
| Fully local / private | Ollama | Ollama |
| Best quality | Anthropic | OpenAI |
| Cost-efficient cloud | OpenAI (gpt-4o-mini) | OpenAI (text-embedding-3-small) |
| Local embed + cloud chat | OpenAI / Anthropic | Ollama |

> **Important:** Use the same embed model for both indexing and querying. Switching embed models after indexing will produce incorrect retrieval results. Re-index the vault after changing the embed model.

---

## Test Connection

Each provider section in settings has a **Test connection** button (for both chat and embed). It sends a minimal request (embed one word / stream one chat token) and reports success or the error message.

Use this to verify API keys and Ollama connectivity before indexing.

---

## Timeout

All provider requests share a global timeout (default: 60 000 ms). Increase it in **Settings → VaultRAG → Advanced → Request timeout** if you are using large local models that respond slowly.
