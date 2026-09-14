# Validation

## Additional CLIProxy identity: Astra 400k catalog (2026-09-14)

Validated code head: `861a8152711511df0ac1acd6b8456feb8b21d9ff`, based on
upstream v2 `db6880ed2c084fb334fd6167354ad8e292aec1aa`. Pi and its AI/agent
packages were **0.85.1**, Node 24.18.1. Later evidence/resource-filter test
edits do not change the extension code exercised by these calls.

### Offline evidence

`npm test` passes: typecheck, existing smoke and the real Pi SDK/catalog/
serialization suite in `scripts/cli-proxy-targets.mjs`. Both benchmark
self-tests also pass. The catalog keeps the original identity at 272000 and
selects the additional identity at 400000; a separate runtime following the
main identity also gets 400000, demonstrating why supervision must be pinned.
Network responses in this suite are mocked and are **not** upstream evidence.
The real resource loader additionally verifies an exact negative extension
path in an `autoload:false` project delta; an empty delta array alone does not
disable an inherited package resource.

### Real small canary — PASS

The explicit SDK fixture `tests/live/cli-proxy-target-canary.mjs --canary`
loaded only this development extension, with no tools/discovered resources,
into a private temporary agent directory. It reused the existing CLIProxy
credential **command reference**, resolving only the selected test identity;
no credential values were logged or written into the fixture configuration.
Production configs, installations, sessions, workers and services were not
modified. Temporary fixture files were removed. Client retries and automatic
compaction were disabled; the fixture stops on the first error.

- Additional identity: `cliproxy-main-400k/gpt-6-astra`; upstream request id
  remained `gpt-6-astra`, base `http://127.0.0.1:8317/v1`.
- Synthetic padding: **2600 local o200k_base tokens**, plus short instructions
  and turns. This encoding is a local measurement, not a certified Astra tokenizer.
- **Eight HTTP 200 requests**, all `POST /v1/responses`; **one** remote
  `compaction_trigger`, no HTTP request to a `/compact` path.
- One nonempty v2 opaque artifact persisted in Pi JSONL.
- Exact generated-codename recall passed in the same process, after a real
  original/alias model round trip, and after SDK dispose/reopen/resume.
- The marker was absent from the portable summary and from the visible input
  at **each** recall request. Public Pi tree navigation returned to the
  compaction checkpoint before later scenarios, preventing the previous
  recall answer from becoming a plaintext shortcut. No JSONL/blob was edited.
- The original-identity turn sent no alias artifact; returning to the alias
  restored compatible replay. The normal original and alias turns succeeded.

### Single capacity request — PASS (>272k, not exact 400k)

After the canary passed, the same head ran `--capacity` once with one synthetic
input of **300011 o200k_base tokens** and a request to answer only `OK`.
The normal Pi Responses call returned HTTP 200 and `OK`; provider usage was
**300393 input tokens, 5 output tokens**, zero cache-read/write tokens.
This establishes capacity above 272000 on this route for this request. It
proves neither the exact 400000 boundary nor large-context compaction/replay,
automatic threshold behavior under load, or every account in the pool.

No large compaction was attempted. Proving the combination under load would
require a separately authorized large synthetic compaction plus replay; the
remote and portable-summary passes alone can add roughly **600k input tokens**
to a 300k history, before setup/replay/output costs. There is no verified
subscription tariff here; zero catalog cost is not evidence of free usage.
No production activation or merge is implied by these results.

## Current Responses compaction v2 validation

The full live Pi RPC suite passes with both:

- `openai/gpt-5.6-luna` through the direct OpenAI Responses API
- `openai-codex/gpt-5.6-sol` through the ChatGPT Codex subscription backend

The validated compaction request uses the normal Responses endpoint with a trailing `{ "type": "compaction_trigger" }`. Both backends returned an opaque `compaction` output item, persisted as `details.remoteCompaction` with `implementation: "responses_compaction_v2"`.

Validated continuity on both providers includes same-process recall, fork safety, resume/reload, and model-switch round trips. The direct OpenAI suite also includes reduced-plaintext replay; that test recovered a generated secret absent from all visible retained history and from the portable Pi summary.

`cliproxy/*` Responses models use this same protocol and have their own live
canary, including the `/model` round-trip they cannot cover. See
[CLIProxy Responses compaction v2](#cliproxy-responses-compaction-v2).

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

### Live canary

**Passed** against the real local CLIProxyAPI pool on 2026-08-26, after the
captain authorised a proxy restart that cleared the `auth_unavailable` cooldown
left by the earlier compact-v1 cascade.

Setup: a disposable `PI_CODING_AGENT_DIR`, session directory, and workspace, all
removed afterwards. The provider definition was reused verbatim, including its
`!command` apiKey form, so no credential value was read, copied, or printed.
`keepRecentTokens` was set to 1 in the disposable global agent settings — the
workspace is untrusted, so project-local `.pi/settings.json` is not honoured —
which leaves almost nothing as plaintext after compaction. The marker was a
codename the model itself invented, so it is not among the retained *user*
messages that compaction v2 keeps outside the artifact.

Every Pi request was routed through a local recording reverse proxy that
forwarded verbatim to `127.0.0.1:8317` and recorded only `METHOD PATH -> STATUS`
(never header values, never bodies), so the set of paths actually requested is
observed evidence rather than an assumption.

Retained result:

```json
{
  "ordinaryResponseWorked": true,
  "paddingResponseWorked": true,
  "compactCommandWorked": true,
  "remoteImplementation": "responses_compaction_v2",
  "remoteArtifactCount": 1,
  "remoteArtifactNonEmpty": true,
  "replacementHistoryCount": 3,
  "visibleReplacementHistoryOmittedMarker": true,
  "portableSummaryOmittedMarker": true,
  "persistedRemoteArtifactInSessionFile": true,
  "sameProcessRecoveredMarker": true,
  "ordinaryTurnAfterCompactWorked": true,
  "resumedProcessRecoveredMarker": true,
  "compactEndpointRequestCount": 0,
  "responsesEndpointRequestCount": 7,
  "observedPathsWithStatus": ["POST /v1/responses -> 200"],
  "firstProcessStderrClass": "none",
  "secondProcessStderrClass": "none",
  "modelSwitchScenario": "skipped: catalogue exposes a single cliproxy model",
  "verdict": "PASS"
}
```

What this establishes:

1. Ordinary `cliproxy/gpt-5.6-sol` turns work through the extension.
2. `/compact` returns `responses_compaction_v2` details holding exactly one
   non-empty opaque artifact.
3. That artifact is persisted into the session JSONL under
   `details.remoteCompaction`.
4. The marker appears in neither the portable summary nor the visible
   replacement history, yet the next turn in the same process recovered it
   exactly — so recall is attributable to the opaque artifact, not to surviving
   plaintext.
5. A second Pi process resumed the saved session and recovered the marker again,
   with no account pin.
6. An ordinary turn after compaction succeeded, and every observed request
   returned 200. **No `auth_unavailable` cascade followed the compaction**,
   which is the regression this change exists to remove.
7. Across the whole run the proxy observed exactly one distinct path,
   `POST /v1/responses`, and zero requests to any `/compact` path.

Both Pi processes produced no stderr and emitted no error events.

Not covered: the `/model` switch round-trip. The captain's catalogue exposes a
single `cliproxy` model, so there is no second model to switch to. Cross-model
replay filtering remains covered by the offline reconstruction regression and by
the direct-OpenAI live suite.

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
