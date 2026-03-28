# Development

## Prerequisites

- Node.js ≥ 20
- npm ≥ 10
- An Obsidian vault for manual testing

---

## Setup

```bash
git clone <repo-url>
cd obsidian-rag
npm install
```

---

## Scripts

| Script | Command | Description |
|---|---|---|
| Dev build (watch) | `npm run dev` | esbuild in watch mode, rebuilds on save |
| Production build | `npm run build` | Type-check with `tsc --noEmit`, then bundle |
| Run tests | `npm test` | Jest (single run) |
| Tests (watch) | `npm run test:watch` | Jest in watch mode |
| Coverage | `npm run test:coverage` | Jest with coverage report (≥ 80% threshold) |

---

## Project Structure

```
obsidian-rag/
├── src/
│   ├── main.ts                    Plugin entry point
│   ├── settings.ts                Settings types, defaults, validation
│   ├── providers/
│   │   ├── base.ts                ChatProvider / EmbedProvider interfaces
│   │   ├── factory.ts             Provider instantiation from settings
│   │   ├── openai.ts              OpenAI chat + embed
│   │   ├── claude.ts              Anthropic Claude chat
│   │   └── ollama.ts              Ollama chat + embed
│   ├── rag/
│   │   ├── chunker.types.ts       Chunk type definitions
│   │   ├── chunker.ts             Markdown → token-window chunks
│   │   ├── indexer.ts             Delta indexing orchestration
│   │   └── retriever.ts           Query embedding + prompt assembly
│   ├── store/
│   │   ├── base.ts                VectorStore interface
│   │   └── vectraStore.ts         Vectra LocalIndex implementation
│   └── ui/
│       ├── ChatView.ts            Right-sidebar ItemView
│       ├── DashboardModal.ts      Index status modal
│       ├── SettingsTab.ts         Settings tab
│       └── FloatingChatPanel.ts   Floating overlay (alternative, unused)
├── __mocks__/
│   └── obsidian.ts                Manual mock of the Obsidian API
├── docs/                          Documentation
├── esbuild.config.js              Build configuration
├── jest.config.ts                 Test configuration
├── manifest.json                  Plugin metadata
├── tsconfig.json                  TypeScript configuration
├── styles.css                     Plugin CSS (loaded by Obsidian)
└── main.js                        Built output (committed for distribution)
```

---

## Development Workflow

### Live Reload

1. Run `npm run dev` — esbuild watches for changes and rebuilds instantly.
2. Symlink the plugin folder into your test vault:

```bash
# macOS / Linux
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/vaultrag"

# Windows (run as Administrator)
mklink /D "C:\path\to\vault\.obsidian\plugins\vaultrag" "%CD%"
```

3. Install the **Hot Reload** community plugin in your test vault so Obsidian picks up changes automatically without restarting.

### Manual Copy

If you prefer not to symlink:

```bash
npm run build
cp main.js styles.css /path/to/vault/.obsidian/plugins/vaultrag/
```

Then disable and re-enable the plugin in Obsidian.

---

## Testing

### Stack

| Tool | Version | Purpose |
|---|---|---|
| Jest | 29.7 | Test runner |
| ts-jest | 29.2 | TypeScript transformation |
| `__mocks__/obsidian.ts` | — | Manual Obsidian API mock |

Tests run in the **Node.js** environment (no jsdom). Obsidian's DOM APIs are not available in tests — all UI tests mock the relevant methods.

### Running Tests

```bash
npm test                 # all tests, single run
npm run test:watch       # re-run on file change
npm run test:coverage    # generate coverage report
```

Coverage threshold: **80%** for branches, functions, lines, and statements. The build fails if any threshold is not met.

### Mock Strategy

`__mocks__/obsidian.ts` is a hand-written mock (not auto-generated) covering every Obsidian API used by VaultRAG:

- `App`, `Plugin`, `Vault`, `TFile`, `TFolder`
- `PluginManifest`, `WorkspaceLeaf`, `ItemView`, `Modal`, `PluginSettingTab`
- All methods are `jest.fn()` stubs

Providers accept an injectable `fetchFn` parameter so HTTP calls are mocked without patching `globalThis.fetch`.

```typescript
// Example: testing OpenAI provider without real HTTP
const provider = new OpenAIProvider('sk-test', 60_000, mockFetch);
```

### Test Layout

```
src/__tests__/
├── main.test.ts                  Plugin lifecycle
├── main.wiring.test.ts           Infrastructure + command integration
├── settings.test.ts              Validation + defaults
├── providers/
│   ├── openai.test.ts
│   ├── claude.test.ts
│   └── ollama.test.ts
├── rag/
│   ├── chunker.test.ts
│   ├── indexer.test.ts
│   └── retriever.test.ts
├── store/
│   └── vectraStore.test.ts
└── ui/
    ├── ChatView.test.ts
    ├── DashboardModal.test.ts
    └── SettingsTab.test.ts
```

---

## Build System

**esbuild** bundles `src/main.ts` into `main.js`:

- **Format:** CommonJS (required by Obsidian)
- **Target:** ES2018
- **External:** `obsidian`, `electron`, all `@codemirror/*` and `@lezer/*` packages, Node built-ins (`fs`, `path`, etc.)
- **Dev:** inline sourcemap, no minification
- **Production:** no sourcemap, tree-shaking enabled

TypeScript is type-checked separately (`tsc --noEmit --skipLibCheck`) before the esbuild step in the production build. This ensures type errors are caught even though esbuild does not perform type checking itself.

---

## Adding a New Provider

1. Implement `ChatProvider` and/or `EmbedProvider` from `src/providers/base.ts`.
2. Add the provider name to the `ProviderName` union in `base.ts`.
3. Register it in `src/providers/factory.ts` inside `getChatProvider` / `getEmbedProvider`.
4. Add the corresponding settings fields to `src/settings.ts` (`PluginSettings`, `DEFAULT_SETTINGS`, `applyDefaults`, `validateSettings`, `toProviderSettings`).
5. Add a settings section in `src/ui/SettingsTab.ts`.
6. Write provider tests in `src/__tests__/providers/`.

---

## CSS

`styles.css` at the project root is loaded by Obsidian automatically alongside `main.js`. Do **not** put CSS inside `src/` — it will not be loaded.

All styles use Obsidian CSS variables (`--background-primary`, `--interactive-accent`, `--font-interface`, etc.) to adapt to any theme automatically. Avoid hardcoded colors.

---

## Releasing

1. Bump `version` in `manifest.json` and `package.json`.
2. Run `npm run build`.
3. Commit `main.js`, `manifest.json`, `styles.css`.
4. Tag the commit: `git tag v0.x.0`.
5. Create a GitHub release with `main.js`, `manifest.json`, and `styles.css` as assets.
