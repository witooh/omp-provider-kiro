# @witooh/omp-provider-kiro

[omp](https://github.com/can1357/oh-my-pi) extension that registers **Kiro** (AWS CodeWhisperer/Q) as a
provider behind AWS Builder ID / IAM Identity Center / Google / GitHub login. The model list follows
your account's live catalog after login (Claude Opus/Sonnet, GPT-5.6, DeepSeek, GLM, Qwen, MiniMax —
19 on an Enterprise IdC account today); a 15-model bootstrap catalog covers the pre-login menu.
Usage is governed by your Kiro plan — the API reports no per-token pricing, so omp meters cost as 0.

Port of [`@witooh/pi-provider-kiro`](https://github.com/witooh/pi-provider-kiro) to omp's extension
API. Same streaming engine, same credential cascade, same outbound `toolUseId` normalisation
(Kiro enforces Bedrock's `^[A-Za-z0-9_-]{1,64}$`, so foreign ids from cross-provider session
branches are rewritten once at the stream choke point).

## Install

```bash
# from a local clone
omp plugin link /absolute/path/to/omp-provider-kiro

# or from git / npm
omp plugin install git:github.com/witooh/omp-provider-kiro
```

Requires omp ≥ 17.2.2 (the extension is built against `@oh-my-pi/pi-{ai,coding-agent,tui}@17.2.2`).

Then log in:

```text
/login kiro
```

The login flow offers:

- **Builder ID** — native device-code flow, works over SSH/remotes
- **Your organization** — IAM Identity Center start URL
- **Google** / **GitHub** — social login, delegated to `kiro-cli`

If you already have a `kiro-cli` session, the provider reuses those credentials instead of forcing a
second login.

## Models

| Model | Context | Max out | Reasoning efforts | Input |
|---|---|---|---|---|
| `claude-opus-4-8` | 1M | 128K | minimal…max | text+image |
| `claude-opus-4-7` | 1M | 128K | minimal…max | text+image |
| `claude-opus-4-6` | 1M | 32K | minimal…high, max | text+image |
| `claude-sonnet-5` | 1M | 64K | minimal…max | text+image |
| `claude-sonnet-4-6` | 1M | 64K | minimal…high, max | text+image |
| `claude-sonnet-4-5` | 200K | 64K | minimal…high | text+image |
| `claude-sonnet-4` | 200K | 64K | minimal…high | text+image |
| `claude-haiku-4-5` | 200K | 64K | — | text+image |
| `claude-fable-5` | 1M | 64K | minimal…max | text+image |
| `deepseek-3-2` | 164K | 8K | minimal…high | text |
| `minimax-m2-5` | 196K | 8K | — | text |
| `minimax-m2-1` | 196K | 8K | — | text |
| `glm-5` | 200K | 8K | minimal…high | text |
| `qwen3-coder-next` | 256K | 8K | minimal…high | text |
| `auto` | 1M | 64K | minimal…high | text+image |

This list is the bootstrap catalog. Once authenticated, the real regional catalog is fetched from
Kiro's management API and cached at `~/.kiro-management-models-cache.json`; omp then sees the live
list through the provider's `modifyModels` hook.

## Usage

```text
/model claude-sonnet-4-6      # or /model auto
/reasoning high
```

`/reasoning` levels come from each model's declared `thinking.efforts`; the selected effort is
translated into Kiro's structured `reasoning` / `output_config` request field.

## Differences from the pi extension

omp's `registerProvider` contract is narrower than pi's, so three hooks were dropped:

| pi hook | Status in omp |
|---|---|
| `oauth.getCliCredentials` | Not in omp's contract. No loss — `loginKiro`/`refreshKiroToken` read the `kiro-cli` DB themselves. |
| `refreshModels` (host-driven catalog refresh) | Not in `ProviderConfigInput`. The catalog is refreshed from the login, token-refresh, and stream paths instead. |
| `oauth.fetchUsage` | omp has no extension usage hook, so `/usage` does not show Kiro quota. `src/usage.ts` was removed rather than left dead. |

## Retry behavior

Generic transient retries (HTTP 429/5xx) are handled by omp at the session layer. This provider only
keeps Kiro-specific recovery:

- `403` auth races → refresh credentials from `kiro-cli`
- first-token / stalled-stream recovery
- empty-stream and echo-loop retries
- non-retryable body markers (`MONTHLY_REQUEST_COUNT`, `INSUFFICIENT_MODEL_CAPACITY`)

## Development

```bash
npm install
npm run check   # tsc --noEmit for src and test
npm test        # bun test  (323 tests)
npm run build   # esbuild bundle -> dist/index.js
npm run lint    # biome
```

Tests run on **Bun**, not Node: the `@oh-my-pi/*` packages ship raw TypeScript and use Bun-only
globals, so Node/vitest cannot import them.

## Architecture

```
src/
├── index.ts            # registerProvider wiring
├── models.ts           # 15 model definitions, ID resolution, disk cache
├── oauth.ts            # login + refresh, credential cascade
├── login.ts / login-ui.ts  # interactive login + TUI overlay
├── kiro-cli.ts         # kiro-cli SQLite credential sharing
├── kiro-ide.ts         # Kiro IDE token file (~/.aws/sso/cache)
├── transform.ts        # omp <-> Kiro message conversion + toolUseId normalise
├── history.ts          # history truncation + sanitization
├── effort.ts           # reasoning-effort mapping
├── event-parser.ts     # Kiro stream event parser
├── thinking-parser.ts  # streaming <thinking> tag parser
└── stream.ts           # streaming orchestrator
```

See [AGENTS.md](AGENTS.md) for development guidance.

## License

MIT
