# Validation

## Current Responses compaction v2 validation

The full live Pi RPC suite passes with both:

- `openai/gpt-5.6-luna` through the direct OpenAI Responses API
- `openai-codex/gpt-5.6-sol` through the ChatGPT Codex subscription backend

The validated compaction request uses the normal Responses endpoint with a trailing `{ "type": "compaction_trigger" }`. Both backends returned an opaque `compaction` output item, persisted as `details.remoteCompaction` with `implementation: "responses_compaction_v2"`.

Validated continuity on both providers includes same-process recall, fork safety, resume/reload, and model-switch round trips. The direct OpenAI suite also includes reduced-plaintext replay; that test recovered a generated secret absent from all visible retained history and from the portable Pi summary.

`cliproxy/*` Responses models now use this same protocol, but are **not** covered
by that live evidence. See [CLIProxy Responses compaction v2](#cliproxy-responses-compaction-v2)
for what has and has not been proven for that backend.

## Controlled product-defaults benchmark

A retained GPT-5.6 Sol benchmark compared Pi 0.80.9's actual default
compaction policy, this extension's actual Responses compaction/replay policy,
and a full-context control. It increased task difficulty by replacing filler
with exact state at a fixed roughly 50K-token history, without imposing an
output cap from one arm on the other.

On held-out seeds 301–304, full context scored 600/600, native scored 468/600
(78.0%), and Pi default scored 288/600 (48.0%). Native used 4.58x Pi's mean
compaction output tokens, 2.52x its compaction cost, and 1.29x its downstream
input tokens. Pi had zero length-stopped summaries. All five native artifacts
above 10K output tokens scored 75/75, while the three below 5K scored 39, 26,
and 28. The supported conclusion is that the native default policy preserved
more old state in aggregate while using more resources and exhibiting high
allocation variability—not that it was more accurate at an equal budget.

See:

- `benchmarks/product-defaults/REPORT.md`
- `benchmarks/product-defaults/README.md`
- `benchmarks/product-defaults/CALIBRATION.md`

## Correction to the earlier matched-cap benchmark

The earlier native-vs-text run set each text summary's maximum output tokens
after observing its paired native request's output usage. That creates a
one-sided, post-treatment cap and is not a symmetric matched-budget comparison.
Its raw results remain reproducible, but its same-budget interpretation is
superseded by the methodological note in:

- `benchmarks/native-vs-text/REPORT.md`
- `benchmarks/native-vs-text/README.md`

## CLIProxy Responses compaction v2

`cliproxy/*` Responses models previously used the standard non-streaming
`POST /v1/responses/compact` endpoint. That selection is removed. It is not a
preference: the route stopped working, and calling it damages the account pool
it is proxying.

### The compatibility transition

The compact-v1 request succeeded repeatedly through 2026-08-12 14:21 and
returned 404 from 15:49 the same day onward, with no later success across the
following two weeks. Nothing on the client changed at that boundary.

### Where the 404 comes from

CLIProxyAPI is not the missing piece. At the release running locally,
`7.2.128`:

- `internal/api/server_routes.go` still registers `POST /v1/responses/compact`
  and `POST /backend-api/codex/responses/compact`
- `sdk/api/handlers/openai/openai_responses_handlers.go` still implements the
  non-streaming `Compact` handler
- `internal/runtime/executor/codex_executor_execute.go` still dispatches
  `Alt == "responses/compact"` to `<codex base>/responses/compact` and wraps a
  non-2xx upstream status with `newCodexStatusErr`

The 404 therefore originates upstream of the proxy. Codex's own client agrees on
the direction of travel: `codex-rs/core/src/compact_remote.rs` refers to
`/responses/compact` as "Legacy", and `codex-rs/core/src/tasks/compact.rs`
selects the compaction-trigger v2 path for OpenAI providers.

### Why it broke ordinary turns, not just compaction

`sdk/cliproxy/auth/conductor_cooldown.go` treats an upstream 404 as a
credential-level fault: status 404 sets `NextRetryAfter` to 12 hours with
`not_found` and suspends the model on that auth. The conductor then retries the
next eligible credential, which fails the same way. One `/compact` therefore
walks the whole Codex pool into cooldown, and later *ordinary* `/v1/responses`
turns fail with `503 auth_unavailable: no auth available`. The count_tokens
404 exemption in `conductor_execution.go` does not apply to this path.

That is the acceptance-criterion failure this change removes: the extension no
longer constructs `/responses/compact` for any provider, so the initiating
`/compact` can no longer cool the pool.

### What replaced it

`cliproxy/*` compaction now uses the same Responses compaction v2 protocol the
package already owned for `openai/*` and `openai-codex/*`: an ordinary
`POST <baseUrl>/responses` with a trailing `compaction_trigger`, read as SSE,
requiring exactly one `compaction` output item. CLIProxyAPI forwards that as a
normal Responses request through the same path the captain's ordinary turns
already use.

Source facts that make this the right target, at `7.2.128`:

- `internal/translator/codex/openai/responses/codex_openai-responses_request.go`
  passes `input` items through unchanged apart from system-to-developer role
  normalization, and forces exactly the fields the v2 body already sets
  (`stream:true`, `store:false`, `parallel_tool_calls:true`,
  `include:["reasoning.encrypted_content"]`)
- `codex_openai-responses_response.go` passes streaming events back through
  essentially verbatim, so `response.output_item.done` carrying a `compaction`
  item and `response.completed` reach the client
- `openai_responses_signature.go` sanitizes only `reasoning` input items, so
  `compaction` and `compaction_trigger` items are untouched
- `codex_executor_request.go` forwards a downstream `X-Codex-Beta-Features`
  header upstream, so `remote_compaction_v2` still reaches the Codex backend
- the reasoning-replay cache is enabled only for Claude-format sources
  (`codex_executor_reasoning.go`), so it does not interfere here

Headers for this path deliberately carry only the downstream proxy credential
and the session identity the proxy's affinity selector reads. The proxy chooses
the account and injects the real Codex authorization, account id, originator,
and user agent itself, so the extension does not decode the loopback credential
as a Codex JWT and does not pin an account.

### Offline validation

`npm test`, `npm pack --dry-run`, and `npm audit` pass. `scripts/smoke.mjs`
adds focused coverage for the transition:

- CLIProxy compaction resolves to `http://127.0.0.1:8317/v1/responses`, and the
  captured request URL never ends in `/compact`
- the request body is the compaction-v2 shape with a trailing
  `compaction_trigger`
- CLIProxy headers carry the proxy bearer, `session_id`,
  `x-client-request-id`, and `x-codex-beta-features`, and omit
  `chatgpt-account-id`, `originator`, `user-agent`, and the Codex
  installation/window identifiers
- a synthetic 404 is raised as a `RemoteCompactionError` carrying its status, is
  attempted exactly once, leaves the persisted session branch byte-identical,
  and closes the eligibility gate
- the removed compact-v1 helpers stay removed, and no file under `src/`
  constructs the `/responses/compact` URL
- driving the real `session_before_compact` handler end to end: one 404 closes
  the gate, is announced exactly once, and the next compaction issues no further
  remote request
- persisted `responses_compact_v1` artifacts from older sessions still parse and
  still replay

### Live canary status

**Not yet run.** At the time of this change every Codex credential in the local
pool was still in the `auth_unavailable` state left by the earlier compact-v1
404 cascade, so an ordinary `cliproxy/gpt-5.6-sol` turn failed with
`503 auth_unavailable: no auth available` before any compaction could be
attempted. That is the pre-existing incident, not a result of this change, and
it is itself direct confirmation of the cooldown mechanism described above.

Consequently this change is validated by source inspection and offline
regression only. Remote compaction through CLIProxyAPI is **not** claimed to be
live-proven. When the pool recovers, the intended canary is a disposable Pi
profile driving `cliproxy/gpt-5.6-sol` with a synthetic marker, checking:
ordinary response, `responses_compaction_v2` details with exactly one non-empty
opaque artifact, persistence into the session JSONL, same-process recall, and
resumed-process recall. Until that passes, treat CLIProxy remote compaction as
implemented and offline-verified, not field-verified.

## Legacy `/responses/compact` validation (historical)

This section records the original direct-OpenAI probe. It is retained as
history. It is **not** a current compatibility claim: see the transition above.

Before the v2 migration, a direct manual probe against the OpenAI API succeeded:

1. `POST /v1/responses/compact`
   - returned `object: "response.compaction"`
   - returned an `output` array containing:
     - a preserved `message` item
     - a `compaction` item with large `encrypted_content`

2. A follow-up `POST /v1/responses`
   - used the returned compaction output plus a new user message
   - correctly recovered hidden prior information from the compaction artifact

### Concrete probe

Compressed history contained the fact:
- `My launch code is ORANGE-17.`

After compaction, the next request included:
- the returned `compaction` item
- a fresh user message: `What is my launch code?`

The model replied:
- `Your launch code is ORANGE-17.`

## Meaning

This confirms that the OpenAI compaction endpoint is real, returns opaque compaction artifacts, and that replaying those artifacts in later Responses requests does preserve continuity across the compaction boundary.

## Live Pi RPC tests

A full live Pi RPC test run also passed using this extension.

The maintained regression harness now lives at:
- `tests/live/openai-compaction-rpc-live.ts`

Validated end-to-end for:
- direct OpenAI Responses (`openai/*`)
- OpenAI Codex subscription provider (`openai-codex/*`)

Validated end-to-end:

1. **Same-process continuity across compaction**
   - prompt stored a secret
   - `/compact` equivalent RPC compaction was run with custom instructions explicitly telling the text summary to omit the secret
   - compaction response contained `details.remoteCompaction.replacementHistory`
   - the current direct OpenAI and OpenAI Codex paths return a `compaction` artifact item
   - legacy session entries containing `compaction_summary` remain supported for replay compatibility
   - a later prompt in the same session correctly recovered the secret

2. **`/model`-style switching mid-session**
   - after compaction and successful recall, the session switched to another direct OpenAI Responses model
   - the next prompt completed successfully
   - the session then switched back to the original direct OpenAI Responses model
   - remote continuity still worked after the round-trip
   - Pi remained usable and cost totals stayed non-zero

3. **Fork safety after compaction**
   - after compaction, a fork was created from an earlier user message
   - the forked session stayed usable and answered correctly on the next prompt

4. **Resume/reload continuity after remote compaction**
   - a session was compacted
   - Pi was restarted on the saved session file
   - the resumed session correctly recovered the secret even though the portable text summary omitted it

5. **Resume/reload after a `/model` round-trip**
   - a session was compacted under one direct OpenAI model
   - the session switched to another OpenAI Responses model for a completed turn
   - the session switched back and successfully recalled the hidden secret
   - Pi was restarted on the saved session file
   - the resumed session still recovered the secret, confirming reconstructed replay excluded the intervening other-model turn

This confirms the extension uses Responses compaction v2 artifacts in a way that materially affects continuity, while keeping Pi operational across key session features on both the direct API provider and the OpenAI Codex subscription provider.

## Hardening notes

After the first successful live pass, an additional cleanup/hardening pass was applied:

- in-memory remote history is now only extended when the active model still matches the compaction model, preventing cross-model pollution during `/model` round-trips
- local portable-summary generation now falls back to Pi's built-in compaction helper if the full-branch summary attempt fails
- remote compaction output is now shape-checked before being persisted or reconstructed from session details
- the WebSocket connection manager now handles reconnect scheduling and pre-open close/error cases more defensively
