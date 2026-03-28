# Configuration Reference

All settings are stored in `<vault>/.obsidian/plugins/vaultrag/data.json` and managed through **Settings → VaultRAG**.

---

## Provider Selection

| Field | Type | Default | Description |
|---|---|---|---|
| `chatProvider` | `'openai' \| 'anthropic' \| 'ollama'` | `'ollama'` | Which provider handles chat completions |
| `embedProvider` | `'openai' \| 'ollama'` | `'ollama'` | Which provider generates embeddings (Anthropic not supported) |

---

## OpenAI

| Field | Type | Default | Description |
|---|---|---|---|
| `openaiApiKey` | `string` | `''` | Secret key starting with `sk-`. Required when OpenAI is selected for chat or embed |
| `openaiChatModel` | `string` | `'gpt-4o'` | Model name for chat completions |
| `openaiEmbedModel` | `string` | `'text-embedding-3-small'` | Model name for embeddings |

---

## Anthropic

| Field | Type | Default | Description |
|---|---|---|---|
| `anthropicApiKey` | `string` | `''` | Secret key starting with `sk-ant-`. Required when Anthropic is selected for chat |
| `anthropicChatModel` | `string` | `'claude-sonnet-4-6'` | Model name for chat completions |

---

## Ollama

| Field | Type | Default | Description |
|---|---|---|---|
| `ollamaBaseUrl` | `string` | `'http://localhost:11434'` | Base URL of the Ollama server |
| `ollamaChatModel` | `string` | `'llama3'` | Model name for chat completions |
| `ollamaEmbedModel` | `string` | `'nomic-embed-text'` | Model name for embeddings |

---

## Global

| Field | Type | Default | Description |
|---|---|---|---|
| `timeoutMs` | `number` | `60000` | Request timeout in milliseconds for all provider API calls. Increase for slow local models |

---

## Retrieval

| Field | Type | Default | Description |
|---|---|---|---|
| `topK` | `number` | `5` | Number of chunks retrieved per query. Higher values include more context but consume more tokens |
| `maxContextTokens` | `number` | `3000` | Maximum tokens allocated to the vault context block in the prompt. Lowest-scoring chunks are dropped when the budget is exceeded |
| `systemPrompt` | `string` | `''` | Custom system prompt injected into every chat request. Leave empty to use the built-in VaultRAG system prompt |

### Tuning Tips

- **Large vault, detailed answers:** increase `topK` to 8–10 and `maxContextTokens` to 4000–6000.
- **Fast, focused answers:** lower `topK` to 3 and `maxContextTokens` to 1500.
- **Custom persona:** set `systemPrompt` to override the built-in instructions entirely.

---

## Chat History

| Field | Type | Default | Description |
|---|---|---|---|
| `chatHistory` | `StoredMessage[]` | `[]` | Persisted conversation turns. Restored when the plugin reloads |
| `chatPanelWidth` | `number` | `380` | Pixel width of the chat sidebar panel (min 280, max 720) |
| `chatPanelOpen` | `boolean` | `false` | Whether the panel was open when the plugin last ran |

### `StoredMessage` shape

```typescript
{
  role:      'user' | 'assistant';
  content:   string;
  sources:   string[];   // vault file paths that informed the response
  timestamp: number;     // Unix ms
}
```

---

## Dashboard / Index State

| Field | Type | Default | Description |
|---|---|---|---|
| `lastIndexRun` | `LastIndexRun \| null` | `null` | Snapshot of the most recent `indexAll()` run. Displayed in the dashboard |
| `totalTokensIndexed` | `number` | `0` | Cumulative estimated embed tokens used across all index runs |

### `LastIndexRun` shape

```typescript
{
  timestamp:  number;                             // Unix ms when the run completed
  indexed:    number;                             // Files newly embedded
  skipped:    number;                             // Files unchanged (mtime match)
  totalFiles: number;                             // Total markdown files in vault
  errors:     Array<{ file: string; error: string }>; // Files that failed
}
```

---

## Validation Rules

VaultRAG validates settings on save and before constructing providers:

- OpenAI API key is required when OpenAI is the chat **or** embed provider.
- Anthropic API key is required when Anthropic is the chat provider.
- Anthropic cannot be selected as the embed provider.
- Ollama base URL must be a valid `http://` or `https://` URL when Ollama is selected for either role.

Validation errors are surfaced as Obsidian Notices and shown inline in the settings tab.
