# Changelog

This changelog intentionally starts at **0.1.0**.

## Unreleased
- add global-only `cliProxyTargets` opt-in for exact additional Pi provider/API/model/base identities using the existing CLIProxy Responses v2 path; context windows remain in Pi's catalog, with selected-identity auth and no new WebSocket transport
- validate Pi 0.85.1 with real offline SDK/catalog/serialization/resource-filter regressions and a synthetic live Astra canary covering persisted opaque recall, identity round trip and resume; separately validate one >272k input request, not an exact 400k boundary or large compaction (see `VALIDATION.md`)
- remove the legacy `POST /v1/responses/compact` (compact v1) selection entirely; the Codex upstream behind CLIProxyAPI began answering 404 on 2026-08-12 after succeeding until that day, and CLIProxyAPI charges an upstream 404 against the selected credential with a 12-hour `not_found` cooldown, so one `/compact` walked the whole pool into cooldown and made later ordinary turns fail with `503 auth_unavailable`
- route `cliproxy/*` Responses compaction through the already-owned Responses compaction v2 path instead: an ordinary `POST <baseUrl>/responses` with a trailing `compaction_trigger`
- send CLIProxy compaction headers that carry only the downstream proxy credential, the session identity its affinity selector reads, and the forwarded `x-codex-beta-features` value; never derive a ChatGPT account id from the proxy credential and never write Codex installation state for this path
- persist `cliproxy/*` artifacts as `responses_compaction_v2` while keeping existing `responses_compact_v1` session entries readable and replayable
- add a per-model remote-compaction eligibility gate: a route-level status (`404`/`405`/`410`/`501`) disables remote compaction for that model for the rest of the process on first occurrence, other failures after two consecutive failures, aborts do not count, and success resets. Pi keeps producing its portable summary while the gate is closed
- stop discarding a successful compaction artifact when the model definition has no usable pricing metadata
- live-validate the CLIProxy path end to end against the real pool through a recording reverse proxy: compaction v2 artifact, session persistence, same-process recall, resumed-process recall, and an ordinary turn after compaction all pass, with zero requests to any `/compact` path
- target Pi 0.80.9 and the `@earendil-works/*` package namespace
- align compaction fallback, Responses payload normalization, Codex identity headers, and WebSocket behavior with Pi 0.80.9
- replace the legacy direct-provider `/responses/compact` call with Codex's current Responses compaction v2 protocol (this line described an interim state in which eligible CLIProxy models still used compact v1; that path is now removed, see above)
- stream a normal Responses request with a trailing `compaction_trigger` and persist the returned `compaction` item
- retain recent user messages with the same 20K-token budget shape used by Codex while continuing to read older version 1 session artifacts
- add a reproducible native-vs-text compaction benchmark, retained GPT-5.6 Sol evidence, and a standalone report
- add a fixed-context, information-density-calibrated product-defaults benchmark comparing Pi's real default compactor with the extension's real native replay policy
- correct the earlier benchmark's same-budget interpretation: its text cap was selected after observing native output usage
- build initial remote-compaction input from Pi's active compacted context so prior summaries and kept history are included once without replaying superseded raw messages

During local development on 2026-04-09, the project used temporary internal version bumps while features, tests, docs, and packaging were being assembled. Those local-only bumps were collapsed before the first public push so the repository does not imply a longer tracked public release history than it actually has.

## 0.1.0 - 2026-04-09
- initial public release
- added hybrid Codex-style remote compaction for direct OpenAI Responses models
- added OpenAI `POST /v1/responses/compact` integration
- persisted opaque replacement history in Pi compaction details
- reconstructed remote compaction state across resume/reload/tree navigation
- added WS-backed continuation and conservative `previous_response_id` reuse
- tightened direct OpenAI continuation so unchanged request shapes send only incremental post-turn deltas instead of replaying full input alongside `previous_response_id`
- fixed reconstructed post-compaction remote replay to exclude turns completed by other models after later resume/tree reconstruction
- kept portable Pi text summaries as the readable fallback and non-OpenAI portability path
- hardened cross-model runtime state handling and remote output validation
- mirrored observed Responses `reasoning` and `text` tuning into remote compaction requests when available, with thinking-level fallback for reasoning
- fixed the direct OpenAI WS path to carry reasoning configuration and encrypted-reasoning inclusion like Pi's normal HTTP Responses path
- persisted remote compaction usage metadata when the backend returns it
- added a reduced-plaintext live replay regression with tiny Pi `keepRecentTokens`
- added a live Pi RPC regression harness in `tests/live/openai-compaction-rpc-live.ts`
- added a local smoke harness that bootstraps Pi peer-package links and runs small regression checks
- added `ARCHITECTURE.md`, testing docs, packaging polish, and MIT licensing
