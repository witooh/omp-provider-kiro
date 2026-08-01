---
name: ship
description: Release workflow for this repo — verify, commit, push, tag from package.json version, create the GitHub release. Use when asked to ship, release, cut a version, or commit+push+tag in one go.
---

# Ship

Cut a release of `@witooh/omp-provider-kiro`: verify → commit → push → tag → GitHub release.
Steps are ordered; do not tag before every commit that belongs in the release has landed.

## 1. Preflight

- `git status --porcelain` — know exactly what is shipping. Nothing half-done goes in.
- Docs must match code before anything is tagged: model-count claims, refresh-string format,
  pricing wording in `README.md` / `AGENTS.md` (v0.1.0 needed a tag force-move because docs
  landed after the tag — don't repeat that).
- Gates, all green, in this order:
  ```bash
  npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
  npx biome check .
  npm test          # NEVER bare `bun test` — npm test launches bun under a scratch HOME;
                    # bare bun test hard-fails by design (setup.ts guard)
  npm run build
  ```

## 2. Version

- Release version = `version` in `package.json`.
- If `git tag -l "v$(node -p "require('./package.json').version")"` already exists, bump first
  (patch unless told otherwise), and include that bump in the release commit.

## 3. Commit

- `git add -A`, one commit for the release scope.
- Message: imperative summary line; body lists user-visible changes (crib from
  `git log $(git describe --tags --abbrev=0)..HEAD --oneline` when prior commits exist).
- No AI attribution, no emoji.

## 4. Push, tag, release

```bash
git push origin main
V=v$(node -p "require('./package.json').version")
git tag -a "$V" -m "$V"       # annotated, at HEAD, AFTER all release commits
git push origin "$V"
gh release create "$V" --title "$V" -F -   # notes on stdin
```

Release notes: what changed since the last tag (fixes first, then features/docs), then the
install snippet:

```bash
omp plugin install github:witooh/omp-provider-kiro
# then: /login kiro
```

## 5. Verify (all three, every time)

- `git rev-parse "$V^{commit}"` equals `git rev-parse HEAD`
- `gh release view "$V" --json url -q .url` returns the release URL
- `gh api repos/witooh/omp-provider-kiro/tarball/$V --method HEAD` answers 200

## Rules

- Tag moves only when the tag was created this session AND `git ls-remote` proves nobody could
  have fetched it meaningfully (brand-new repo). Otherwise: new patch version, never force-move.
- `npm publish` is NOT part of ship — only on explicit request (`prepublishOnly` runs
  check + build by itself).
- A failing gate stops the ship. Report the failure; do not tag around it.
