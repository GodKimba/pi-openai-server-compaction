# TESTPLAN

## Goals

1. Verify supported OpenAI-compatible Responses sessions use the expected continuity path:
   - direct `openai/*` requests use `store: true`, `context_management`, and `previous_response_id` when safe
   - direct OpenAI, OpenAI Codex, and eligible CLIProxy compaction all use compaction v2: `/v1/responses` with a trailing `compaction_trigger`
   - no code path constructs the removed `/v1/responses/compact` endpoint
   - OpenAI Codex keeps its built-in transport between compactions
   - eligible CLIProxy models keep Pi's Responses transport between compactions
2. Verify Pi remains usable:
   - `/model`
   - `/tree`
   - session resume/reload
   - cost totals on WS path are non-zero and plausible

## Suggested manual tests

### 1. Baseline supported turn
- Start Pi with this extension enabled.
- Use one of:
  - a direct `openai/*` Responses model
  - an `openai-codex/*` model
  - an explicitly eligible `cliproxy/*` Responses model
- Confirm normal response succeeds.

### 2. Live continuation path
- Run a multi-turn session with tool calls.
- For direct `openai/*`, confirm later requests use `previous_response_id` or WS continuation.
- For `openai-codex/*`, confirm normal Codex transport behavior remains intact.
- For eligible `cliproxy/*`, confirm Pi's Responses transport remains intact.
- Confirm no obvious continuity drop across normal turns.

### 3. Remote compaction path
- Force `/compact` in a supported session.
- Confirm extension returns a Pi compaction entry.
- Inspect the session JSONL and confirm `details.remoteCompaction.replacementHistory` exists.
- Continue the session and confirm later compatible turns still behave coherently.
- If the branch already contains a local Pi compaction, confirm the first remote request includes its latest summary plus kept and trailing messages exactly once, and excludes the superseded raw history.
- Confirm `details.remoteCompaction.implementation` is `responses_compaction_v2` for every supported backend, and replacement history ends with an opaque `compaction` item while retaining only the recent user-message budget outside it.
- Sessions recorded before compact v1 was removed still carry `responses_compact_v1` details; confirm those keep replaying rather than being rewritten.

### 4. `/model` safety
- After remote compaction, switch to another model with `/model`.
- Confirm the session continues normally.
- Switch back to the original direct OpenAI model.
- Confirm the session still works, does not crash, and does not reuse polluted remote history.
- Restart or reload after that round-trip and confirm reconstructed remote replay still excludes the intervening other-model turns.

### 5. Tree/fork safety
- Compact, then use `/tree` or fork navigation.
- Confirm session remains usable.
- Confirm stale WS / previous-response state is not reused incorrectly.

### 6. Resume/reload safety
- Compact remotely.
- Restart Pi or reload extensions.
- Resume the same session.
- Confirm remote compaction state is reconstructed from compaction details.

### 7. Cost accounting
- Use the supported provider path for several turns.
- Confirm footer/session stats show non-zero token/cost totals.
- Compare rough totals against dashboard/provider logs when possible.

## Automated offline regression

```bash
npm run smoke
```

The offline harness in `scripts/smoke.mjs` covers:
- initial remote input derived from Pi's active compacted context without duplicate or superseded history
- CLIProxy compaction resolving to `/v1/responses` (never `/compact`), with the compaction-v2 request shape and proxy-appropriate headers
- successful persistence of exactly one non-empty opaque artifact, marked `responses_compaction_v2`
- replacement-history reconstruction after session reload/resume
- the success-to-404 compatibility transition: a 404 is surfaced with its status, is not retried in place, leaves persisted history untouched, and closes the eligibility gate
- gate policy: route-level failures disable immediately, other failures after two consecutive failures, aborts do not count, success resets
- the removed compact-v1 helpers staying removed, and no file under `src/` constructing that URL
- end-to-end wiring: driving the real `session_before_compact` handler, one 404 closes the gate, announces itself once, and the next compaction issues no further remote request

### Exact Astra main CLIProxy identity (Pi 0.85.1)

`npm test` also runs `scripts/cli-proxy-targets.mjs`: real `ModelRuntime`
400k/272k catalogs (including the follow-main counterexample), selected-provider
auth, actual Responses serialization, SDK compaction, JSONL persistence,
resume and original/alias round trips. Network responses and opaque artifacts
are explicitly mocked; this is not upstream recall evidence. It rejects
identity/base near misses, malformed entries and project widening, tests
permission removal/disable, rejects auth-base mismatch before fetch, and
checks that a 404 prevents a second remote attempt. Existing smoke retains
legacy artifact replay and active-context-projection coverage.

A live test must run on an identified clean head, load only the development
extension in a private temporary agent directory, reuse only the existing
credential reference, and stop at the first error without retry. The explicit
`tests/live/cli-proxy-target-canary.mjs --canary` fixture uses ~2–5k synthetic
tokens, validates one persisted v2 artifact, and requires recall without the
marker in portable/visible history after same-process replay, identity return,
and resume. Only after that succeeds on the same head may `--capacity` send
one ~300k-token input. That proves >272k only, not exactly 400k or compaction
under large-context load. No production session is used or rewritten. Results
contain only sanitized checks, usage, paths/status and head; private fixture
files are removed at process exit.

## Automated live test

```bash
node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai/gpt-5.6-luna node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.6-sol node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
```

The harness also accepts a CLIProxy Responses model, which drives the same
compaction-v2 assertions through the proxy:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=cliproxy/gpt-5.6-sol node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
```

Its `/model` round-trip scenarios need a second model from the same provider, so
a single-model CLIProxy configuration only reaches the compaction, recall, and
resume scenarios. Note that the harness writes `keepRecentTokens` to the
project's `.pi/settings.json`; that file is only honoured for trusted projects,
so on an untrusted workspace put compaction settings in the agent directory
instead or `/compact` will refuse with "Nothing to compact (session too small)".

When a canary must also prove which upstream paths were used, route Pi at a
local reverse proxy that forwards to the real endpoint and records only
`METHOD PATH -> STATUS`. That is how the CLIProxy result in `VALIDATION.md`
establishes zero requests to any `/compact` path.

The automated live harness lives in `tests/live/openai-compaction-rpc-live.ts`.

Current automated coverage includes:
- compaction continuity in the same session
- `/model`-style switch away and back again
- fork after compaction
- resume/reload after compaction
- resume/reload after switching away from and back to the compacted model

Recommended follow-up live regression:
- explicit tree navigation after an intervening other-model turn, followed by restart

## Controlled compaction benchmark

The native-vs-text benchmark, reproduction instructions, retained evidence, and report live under:
- `benchmarks/native-vs-text/`
