# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run `npm test` for the focused typecheck and smoke regression suite; benchmark harness checks are `node --experimental-strip-types benchmarks/native-vs-text/self-test.ts` and `node --experimental-strip-types benchmarks/product-defaults/self-test.ts`.
- Preserve the compaction-context invariant in `src/index.ts`: initial remote input comes from Pi's `buildContextEntries()` projection, while persisted remote artifacts continue through reconstructed replacement history. The regression is in `scripts/smoke.mjs`.
- Never reintroduce the compact-v1 route (`POST /v1/responses/compact`) for any provider. Behind CLIProxyAPI an upstream 404 is charged against the selected credential as a 12-hour `not_found` cooldown, so a single call walks the whole account pool into `503 auth_unavailable` and breaks later ordinary turns. `VALIDATION.md` records the source chain; `scripts/smoke.mjs` fails if any source path rebuilds that URL.
- Treat a failed remote compaction as a contained fallback. The per-model eligibility gate lives in `src/state.ts` and is keyed by model, not session, so it deliberately survives session switch/fork/tree within a process.

- Additional CLIProxy identities are a global-only exact opt-in; Pi still owns window configuration. `scripts/cli-proxy-targets.mjs` tests the Pi 0.85.1 SDK and resource-filtering contract; README documents activation without loading old and new extensions together.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
