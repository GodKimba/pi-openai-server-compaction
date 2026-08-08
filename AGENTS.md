# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run `npm test` for the focused typecheck and smoke regression suite; benchmark harness checks are `node --experimental-strip-types benchmarks/native-vs-text/self-test.ts` and `node --experimental-strip-types benchmarks/product-defaults/self-test.ts`.
- Preserve the compaction-context invariant in `src/index.ts`: initial remote input comes from Pi's `buildContextEntries()` projection, while persisted remote artifacts continue through reconstructed replacement history. The regression is in `scripts/smoke.mjs`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
