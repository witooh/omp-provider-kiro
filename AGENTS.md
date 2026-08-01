# AGENTS.md — omp-provider-kiro

> Context file for AI coding assistants working on this codebase.

## Project Overview

omp extension that registers the Kiro API (AWS CodeWhisperer/Q) as a provider with multi-provider
authentication (AWS Builder ID, IAM Identity Center, Google, GitHub). Models come from the
account's live management catalog after login; a 15-model bootstrap list covers the pre-login menu.

Ported from the pi extension `@witooh/pi-provider-kiro`. Keep the delta thin — prefer extending an
existing module over reshaping the layout, so future upstream fixes stay easy to carry over.

## Directory Structure

```
omp-provider-kiro/
├── src/                    # feature-oriented modules, one concern per file
│   ├── index.ts            # pi.registerProvider("kiro", …) — the only entry point
│   ├── models.ts           # model catalog + ID resolution + on-disk cache
│   ├── oauth.ts            # login / refresh, credential cascade
│   ├── kiro-cli.ts         # kiro-cli SQLite credential sharing (sqlite3 CLI via execSync)
│   ├── kiro-ide.ts         # Kiro IDE token file (~/.aws/sso/cache)
│   ├── login.ts / login-ui.ts   # interactive login + ctx.ui.custom overlay
│   ├── transform.ts        # message transformation (+ outbound toolUseId normalise)
│   ├── history.ts          # history truncation + sanitization
│   ├── thinking-parser.ts  # streaming <thinking> tag parser
│   ├── event-parser.ts     # Kiro stream JSON event parser
│   ├── stream.ts           # streaming orchestrator (largest module)
│   ├── effort.ts           # reasoning-effort → Kiro request fields
│   └── endpoints.ts / retry.ts / management.ts / truncation.ts / tokenizer.ts / debug.ts
├── test/                   # bun:test suite, mostly 1:1 with src
│   ├── setup.ts            # preloaded via bunfig.toml; isolates HOME/PATH into a temp dir
│   └── vi.ts               # `vi` shim (bun:test has no stubGlobal/unstubAllGlobals/mocked)
├── bunfig.toml             # [test] preload
└── package.json            # omp.extensions → dist/index.js
```

## omp contract (do not regress)

`ProviderConfigInput` is narrower than pi's `ProviderConfig`. What omp accepts:
`baseUrl`, `api`, `streamSimple`, `models` **or** `fetchDynamicModels`, `headers`, `compat`,
`authHeader`, `transport`, `remoteCompaction`, `apiKey`, and
`oauth: { name, login, refreshToken?, getApiKey?, modifyModels? }`.

- `registerProvider` returns early when `models` is non-empty, so `fetchDynamicModels` would never
  run. We ship the bootstrap catalog in `models` and project the live catalog through
  `oauth.modifyModels`.
- `oauth.getCliCredentials` and `oauth.fetchUsage` do not exist in omp — do not re-add them to the
  provider config. Usage lives in `src/usage.ts` behind the `/kiro-usage` command: `pi-ai` resolves
  usage providers from the module-private `DEFAULT_USAGE_PROVIDERS` map, and `omp usage` (`cli/usage-cli.ts`)
  builds its `AuthStorage` without loading extensions, so no plugin can feed that view.
- `Get-Usage-Limits` rejects a request with no `profileArn` (400 `Invalid profileArn`), so
  `fetchKiroUsage` always resolves one first. The stored credential holds only
  `access`/`refresh`/`expires`/`authorizedAt` — region comes from the packed refresh string.
- `api: "kiro-api"` is a custom API. `registerProvider` forwards `streamSimple` to pi-ai's
  `registerCustomApi`, and `stream.ts` dispatches on `model.api` before the built-ins.

## Key type deltas vs pi 0.82

| pi | omp 17.2.2 |
|---|---|
| `Model.contextWindow: number` | `number \| null` — `KiroModel` narrows both limits back to `number` |
| `Model.compat` absent | **required**; Kiro always sets `undefined` (attached once by `KIRO_MODEL_SPECS.map`) |
| `model.thinkingLevelMap` | `model.thinking?: ThinkingConfig` — this plugin only ever sets `{ mode: "effort", efforts }` |
| `ThinkingLevel` (incl. `"off"`) | const enum `Effort` (no `off` — `undefined` means off) |
| `clampThinkingLevel` in the provider | omp clamps upstream; `mapPiLevelToKiroEffort(level, config)` takes no model |
| `Context.systemPrompt: string` | `string[]` |
| `options.apiKey: string` | `ApiKey = string \| ApiKeyResolver` — resolve with `resolveApiKeyOnce` |
| `calculateCost` exported from pi-ai | not exported; Kiro reports no per-token pricing (plan-based billing), so cost is written as zeros |

`Effort` is an **ambient const enum** and must never be referenced as a value from this bundle.
`src/effort.ts` exports `KiroEffortLevel = \`${Effort}\`` (the string-literal union) — use that.

`AssistantMessageEventStream` is re-exported type-only in pi-ai's `.d.ts` while the runtime
`export *` still carries the class; `stream.ts` reads it off the namespace import.

## Key patterns

- **Model ID convention**: omp uses dashes (`claude-sonnet-4-6`), Kiro uses dots
  (`claude-sonnet-4.6`). Converted in `resolveKiroModel()` via `(\d)-(\d)` → `$1.$2`.
  `KIRO_MODEL_IDS` is the source of truth for valid IDs.
- **Kiro history format**: strict alternating `userInputMessage` / `assistantResponseMessage`;
  tool results are wrapped in synthetic user messages. `buildHistory()` in transform.ts,
  sanitization/truncation in history.ts.
- **Streaming pipeline**: bytes → `parseKiroEvents()` → `KiroStreamEvent` → `ThinkingTagParser`
  (when reasoning) → omp `AssistantMessageEventStream` events.
- **Tool schemas**: `tool.parameters` is a `TSchema` (Zod / ArkType / JSON Schema), never wire-ready.
  `convertToolsToKiro()` must run it through `toolWireSchema(tool)` — the same call
  `amazon-bedrock.ts` makes — or Kiro answers `400 Improperly formed request`
  (`REQUEST_BODY_INVALID`).
- **413/too-large**: propagated immediately, no retry — the caller compacts, matching kiro-cli.
- **Credential cascade**: Kiro IDE token → kiro-cli social token → kiro-cli IDC token →
  OAuth device-code flow.
- **Auth methods**: `idc` (Builder ID / IAM Identity Center, refresh via SSO OIDC, refresh token
  format `refreshToken|clientId|clientSecret|idc|region`) and `desktop` (Google/GitHub, refresh via
  `prod.{region}.auth.desktop.kiro.dev`, format `refreshToken|desktop|region`). Both built by
  `packKiroRefresh()`; pre-region strings (no trailing region segment) parse with a us-east-1
  fallback.

## Development

```bash
npm run build      # esbuild → dist/index.js (@oh-my-pi/* stay external)
npm run check      # tsc --noEmit for src + test
npm test           # bun test
npm run lint       # biome check
```

Use **npm** for dependencies and **bun** for tests.

## Testing patterns

- Runner is `bun test`, not vitest: the `@oh-my-pi/*` packages ship raw TypeScript and depend on
  Bun globals, so Node (and therefore vitest) cannot import them. Measured, not assumed.
- Import `vi` from `./vi.js`, everything else from `bun:test`.
- `bun test` runs every file in **one process** with a shared `$HOME`. A suite that depends on the
  absence of `~/.kiro-management-models-cache.json` must delete it in `beforeEach`.
- `vi.mock` is not hoisted under Bun. Do not rely on a mock declared inside `it()` applying to the
  whole file.
- External calls (`fetch`, `execSync`, `existsSync`) are mocked; stream tests mock `fetch` with a
  `ReadableStream`-like reader. No integration tests.
- `process.env.NODE_ENV === "test"` (set by `bun test`) suppresses the background catalog refresh.

## Adding a model

1. Add the Kiro model ID to the spec list in `src/models.ts` (`KIRO_MODEL_SPECS`).
2. Give it `thinking: kiroThinking([...])` when it reasons — omp derives the `/reasoning` ladder
   from `thinking.efforts`, so a reasoning model without it offers no levels.
3. Update the counts in `test/models.test.ts` and `test/registration.test.ts`.
4. `npm test`.

## Common gotchas

- `ZERO_COST` is a frozen shared object — never mutate model costs.
- `kiro-cli.ts` shells out to the `sqlite3` CLI, not a native module.
- Output token count is estimated (`content.length / 4`) when the API omits it.
- `contextUsagePercentage` is the only usage metric Kiro reports; input tokens are back-calculated
  from it and the model's context window.
- Social login (Google/GitHub) requires `kiro-cli` to be installed.
- `currentMessage.content` must never be empty: Kiro has no assistant-prefill turn, so an empty
  user turn makes the model reply `"Continue"` and burn the echo-loop retry budget. `stream.ts`
  falls back to `CONTINUATION_PROMPT` — `buildHistory()` returns no current message at all when
  the conversation ends on a plain assistant reply (omp's advisor pass does that).
- Provider logs live under `~/.omp/logs/` (`kiro-debug.log`, `capacity-retries.log`), not `~/.pi/`.
- omp's credential store persists only `{ access, refresh, expires, authorizedAt }` — `region`,
  `clientId`, `authMethod` and `profileArn` on `KiroCredentials` are gone by the next refresh.
  Anything a refresh needs rides inside the `refresh` string via `packKiroRefresh()`
  (`token|clientId|clientSecret|idc|region`). Losing the region sends the OIDC refresh to
  us-east-1 and AWS answers `400 invalid_request "Invalid token provided"` — an unrecoverable
  login for every non-us-east-1 Identity Center user.
