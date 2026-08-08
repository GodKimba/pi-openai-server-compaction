# TESTPLAN

## Goals

1. Verify supported OpenAI-compatible Responses sessions use the expected continuity path:
   - direct `openai/*` requests use `store: true`, `context_management`, and `previous_response_id` when safe
   - direct-provider and OpenAI Codex compaction v2 use `/v1/responses` with a trailing `compaction_trigger`
   - OpenAI Codex keeps its built-in transport between compactions
   - the configured CLIProxy `/compact` endpoint for eligible compact-v1 models
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
- For compaction v2, confirm `details.remoteCompaction.implementation` is `responses_compaction_v2`, and replacement history ends with an opaque `compaction` item while retaining only the recent user-message budget outside it.
- For eligible CLIProxy compact v1, confirm `details.remoteCompaction.implementation` is `responses_compact_v1`, and replacement history contains exactly one non-empty opaque `compaction` or `compaction_summary` item.

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
- successful compact-v1 persistence of exactly one non-empty opaque artifact
- replacement-history reconstruction after session reload/resume

## Automated live test

```bash
cd /home/algal/gits/pi-openai-server-compaction
node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai/gpt-5.6-luna node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.6-sol node --experimental-strip-types ./tests/live/openai-compaction-rpc-live.ts
```

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
