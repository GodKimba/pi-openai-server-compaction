# pi-openai-server-compaction

This is a Pi extension which adds **Codex-style remote compaction** for OpenAI models, giving you better continuity across compaction boundaries while preserving all of Pi's normal features.

What does that mean? Why would you want it? My impression has been that Codex compacts better than Claude Code and better than Pi. And I supposed this was because Codex compacts by using OpenAI's server-side Responses compaction protocol. That protocol sends a `compaction_trigger` through `POST /v1/responses` and receives an encrypted `compaction` item. This extension configures Pi to use that protocol for OpenAI models alongside Pi's native compaction logic.

But is Codex's compaction _actually_ better? Since the OpenAI compaction endpoint compacts to encrypted binary blobs, no one can say what it is doing under the hood. However, we don't need to know how it works to determine if it works better. Anyone can call the endpoint. And since codex is an open source, we can mimic exactly how codex itself uses the endpoint. That is what this extension configures Pi to do.

So is native compaction better? For the user-facing comparison I care about,
the evidence says yes, with important price and reliability qualifiers. A
held-out benchmark of the real product defaults found 78.0% exact recall for
this extension's native policy versus 48.0% for Pi's default compactor; full
context scored 100%. Native did this while emitting 4.58x as many compaction
output tokens and leaving a 29% larger billed downstream context. It preserved
much more old state, but this is not evidence that it is better at the same
token budget.
Native was also highly variable: every large artifact scored perfectly, while
three small artifacts performed about as poorly as Pi.

Strictly, this directly compares Pi with this extension's reconstruction of
Codex-style compaction, not with an end-to-end run of the Codex CLI. The result
also does not show that the endpoint reliably detects when more capacity is
needed: its short artifacts were the failures. What it does show is that the
native default sometimes allocates far more context, and those large-allocation
runs drove its aggregate advantage.

An earlier benchmark reported 100% native recall versus 82.8% and 76.7% for two
text summaries at apparently matched downstream sizes. That procedure first
observed native's output usage and then imposed it as the text arm's maximum,
which is asymmetric and can favor native. Its same-budget interpretation is
therefore superseded. See the new [product-defaults report](benchmarks/product-defaults/REPORT.md)
and [reproduction instructions](benchmarks/product-defaults/README.md). The
[older matched-cap report](benchmarks/native-vs-text/REPORT.md) remains retained
with a methodological correction.

None of this proves the encrypted blobs use a clever latent-space
representation. They might be encrypted optimized text or structured state
values. (A little reverse engineering suggests the blobs are produced through
a textual prompt, for what it is worth:
https://x.com/alexisgallagher/status/2042396986327060736?s=20 .)

> **Status:** experimental but live-tested against real Pi + real OpenAI backends.
> Recommended rollout: install project-local first, use for a week, keep rollback easy.
>
> Pi 0.84 compatibility is based on upstream Algal commit
> `8a3de2f3b0c178fdd6f73f2f94172dfc3943e466`.
>
> **Compact v1 is gone.** Every supported backend now uses Responses
> compaction v2. The legacy `POST /v1/responses/compact` route is no longer
> reachable through CLIProxyAPI, and calling it is actively harmful — see
> [Why compact v1 was removed](#why-compact-v1-was-removed).

## Support matrix

| Provider/model family | Remote compaction | `previous_response_id` continuity | Custom WS stream                 | Live-tested |
|-----------------------|-------------------|-----------------------------------|----------------------------------|-------------|
| `openai/*`            | Yes (v2)          | Yes                               | Yes                              | Yes         |
| `openai-codex/*`      | Yes (v2)          | No (built-in transport retained)  | No (built-in transport retained) | Yes         |
| `cliproxy/*` Responses models | Yes (v2)  | No                                | No (Pi transport retained)       | Yes (except `/model` round-trip) |
| Azure                 | Partial (opt-in via config) | Partial                 | No                               | No          |

## Why compact v1 was removed

Earlier releases sent `cliproxy/*` compaction to the standard non-streaming
`POST /v1/responses/compact` endpoint. That worked when it was written, and it
stopped working on 2026-08-12: the same request that had been succeeding began
returning 404 and never succeeded again.

CLIProxyAPI is not the missing piece. Release `7.2.128` still registers the
route (`internal/api/server_routes.go`) and still forwards it through its Codex
executor to `<codex base>/responses/compact`. The 404 comes from the Codex
upstream, which has moved to the compaction-v2 protocol; Codex's own client now
labels that path "Legacy".

The failure mode is worse than a failed compaction. CLIProxyAPI treats an
upstream 404 as a credential-level fault: it marks that auth `not_found`, puts
it in a 12-hour cooldown, suspends the model on it, and retries the next
credential — so a single `/compact` walks the whole pool into cooldown, and
later *ordinary* turns fail with `503 auth_unavailable: no auth available`.

So the extension no longer builds that URL at all, for any provider. `cliproxy/*`
compaction now takes the same Responses compaction v2 path already used for
`openai/*` and `openai-codex/*`: an ordinary `POST /v1/responses` with a trailing
`compaction_trigger`, which CLIProxyAPI forwards as a normal Responses request.
Sessions that already contain a compact-v1 artifact keep replaying it; only the
outbound protocol changed.

This is live-validated against the real local pool: compaction, artifact
persistence, same-process recall, resumed-process recall, and an ordinary turn
after compaction all pass, with every observed request going to
`POST /v1/responses` and none to any `/compact` path. The one uncovered
scenario is the `/model` round-trip, which needs a second model from the same
provider. See [VALIDATION.md](VALIDATION.md).

## Install

Project-local (recommended):

```bash
pi install -l git:github.com/GodKimba/pi-openai-server-compaction@<commit-sha>
```

Global:

```bash
pi install git:github.com/GodKimba/pi-openai-server-compaction@<commit-sha>
```

One-shot, non-persistent:

```bash
git clone https://github.com/algal/pi-openai-server-compaction.git
cd pi-openai-server-compaction && npm install
pi -e ./src/index.ts --model openai/gpt-5.6-luna
```

## Requirements

- Node `>= 22`
- Pi `>=0.84.0 <0.85.0` or `0.85.1` (the latter is exercised by the offline SDK/catalog/serialization suite; this is not a claim of compatibility with every 0.85 release)
- Auth/config for the model you want to use must already work in Pi
- A supported direct OpenAI Responses model, or an explicitly configured model with `provider: "cliproxy"`, `api: "openai-responses"`, and a valid HTTP(S) `baseUrl`

## What it does

On compaction, the extension requests Responses compaction v2 through the backend's own `/v1/responses` endpoint — direct OpenAI, OpenAI Codex, and configured CLIProxy Responses models all take that one path. It does this in parallel with generating a portable Pi text summary. This gives you both:

- **An OpenAI-native opaque compaction artifact** for high-fidelity continuity on compatible future turns
- **A portable Pi text summary** so non-OpenAI models, session exports, forking, and tree navigation keep working

For direct `openai/*` models between compactions, the extension also:

- Patches requests with `store: true` and `context_management`
- Uses `previous_response_id` for live continuation when safe
- Provides a WebSocket-backed transport path with HTTP fallback

For `openai-codex/*` models, the extension preserves the built-in Codex transport and only injects reconstructed remote compaction history after compaction boundaries. For eligible `cliproxy/*` models it likewise replays replacement history through Pi's existing Responses transport; model names alone never enable this path, and no provider override or WebSocket transport is registered for `cliproxy`.

For CLIProxy models the compaction request carries only the downstream proxy
credential, the Pi session identity the proxy's affinity selector reads
(`session_id`, `x-client-request-id`, and `prompt_cache_key`), and the
`x-codex-beta-features` value the proxy forwards upstream. The proxy picks the
account and injects its own Codex authorization, account id, originator, and
user agent, so the extension never derives a ChatGPT account id from the proxy
key and never pins an account.

## How compaction works

On Pi compaction events for supported models, the extension:

1. Generates a **portable Pi text summary** (full-branch summary with fallback to Pi's built-in compaction helper)
2. Streams a normal Responses request with a trailing `compaction_trigger` and requires exactly one `compaction` output item
3. Stores the validated opaque replacement history in `CompactionEntry.details.remoteCompaction`
4. Persists remote compaction usage metadata when the backend returns it

The first remote compaction request is built from Pi's compaction-aware active context: the latest Pi summary plus its kept and trailing messages. It does not replay raw messages already replaced by an earlier local compaction. After a remote artifact exists, the existing persisted replacement-history continuation path remains authoritative.

The compaction request mirrors the shape of surrounding normal requests (reasoning effort, text settings, tool definitions) rather than using endpoint defaults.

## Safety

The extension clears live continuation state on: session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, and shutdown.

Remote compaction history is only replayed for compatible models. Cross-model turns are filtered from reconstructed replay history to prevent contamination after resume or tree navigation.

### Remote compaction eligibility gate

A failed remote compaction is a contained fallback, never a licence to keep
hitting a backend that is not answering. The extension tracks consecutive
remote-compaction failures per model for the lifetime of the Pi process:

- a **route-level** status (`404`, `405`, `410`, `501`) disables remote
  compaction for that model immediately, on the first occurrence
- any other failure is tolerated until two consecutive failures
- an aborted compaction does not count
- a success resets the counter

While remote compaction is disabled the extension still produces Pi's portable
text summary, so `/compact` keeps working; it just stops issuing the remote
call. Pi announces the transition once. Persisted replacement history is never
touched by a failed attempt, so an existing artifact keeps replaying. Restarting
Pi re-enables the attempt.

## Data handling

Users should be aware:

- For direct `openai/*` models, the extension sets `store: true` on requests, meaning OpenAI retains conversation data server-side
- Conversation context is sent to OpenAI's Responses compaction protocol
- Returned opaque compaction artifacts are stored in Pi's local session JSONL
- These artifacts are provider-native and not human-readable

## Configuration

Config is read from:

- `$PI_CODING_AGENT_DIR/openai-server-compaction.json` (global; defaults to `~/.pi/agent`, with Pi's own `~` expansion)
- `.pi/openai-server-compaction.json` (project-local, takes precedence **except for `cliProxyTargets`, which is global-only**)

```json
{
  "enabled": true,
  "includeAzure": false,
  "thresholdRatio": 0.7,
  "compactThreshold": 0,
  "usePreviousResponseId": true,
  "notify": false
}
```

### Separate Pi identity for a larger main-session window

The context window belongs in Pi's `models.json`, not in this extension. To
keep a worker identity at its existing window while selecting a larger window
in the main session, define a separate **Pi provider**, retaining the same
upstream model id and static CLIProxy transport/auth reference. For example,
keep `cliproxy/gpt-6-astra` at 272000 and add
`cliproxy-main-400k/gpt-6-astra` with `contextWindow: 400000`. Copy only that
model into the additional provider; preserve its output limit, capabilities,
compatibility settings and credential reference. Never invent an upstream
model id such as `gpt-6-astra-400k`.

Opt this additional identity into CLIProxy compaction v2 in the **global**
extension configuration:

```json
{
  "cliProxyTargets": [
    {
      "provider": "cliproxy-main-400k",
      "api": "openai-responses",
      "modelId": "gpt-6-astra",
      "baseUrl": "http://127.0.0.1:8317/v1"
    }
  ]
}
```

- Default is `[]`; the original literal `cliproxy` behavior is unchanged.
- Entries have exactly those four fields, compared byte-for-byte. No wildcard,
  host inference, project permission, or environment override grants access.
  Provider names use lowercase letters, digits, `_` and `-` and must not name
  an existing OpenAI/Codex/Azure/CLIProxy identity. Model ids must be nonempty
  and contain no whitespace, `*`, `?` or `:`.
- The static HTTP(S) base must be a canonical URL ending in `/v1`, with no
  userinfo, query, fragment, whitespace or patterns. Redirects during remote
  compaction are refused. Invalid entries produce a configuration error;
  they are never partially accepted or interpreted as broader permission.
- Authentication is resolved for the selected identity only. There is no
  fallback to another provider's key. A resolved auth base differing from the
  approved base, or provider-scoped auth environment, refuses remote
  compaction and leaves Pi's default compactor available. Dynamic/OAuth
  transports and arbitrary compatible providers are not supported by this opt-in.
- Normal requests and replay keep Pi's Responses transport; the opt-in does
  not enable custom WebSockets, `store:true`, or `previous_response_id`.
  Headers changed by another extension's normal-request hooks are not
  automatically inherited by the remote fetch.
- Artifacts remain keyed by `provider:api:id`. Switching to the additional
  identity uses portable context until that identity compacts; it does not
  migrate old blobs or recover already summarized history. Base URLs are not
  part of that legacy key: **do not repoint an existing identity to a different
  backend**. Use a new identity/session instead.

Select the additional identity explicitly with `/model`, without saving a new
startup default. Keep worker selection explicit on the original provider/id.
Any supervisor that follows the main identity must be pinned to the original
identity **before** selecting the larger one. Do not change its reasoning
level as part of the window change.

For reversible activation, filter out an already installed old extension before
loading this checkout; never load both. Pi supports a project package override
with the same `source`, `"autoload": false`, and
`"extensions": ["-src/index.ts"]`, plus a separate local-path package pointing
at the validated checkout. An empty array in an `autoload:false` delta does
**not** disable the inherited extension; use the exact negative path. The project must be trusted. Use
`/reload` only in the intended main session and verify the loaded resource list;
leave shared installations and running workers untouched. For an isolated
one-shot test use `--no-extensions -e /path/to/checkout/src/index.ts` instead.

Rollback: remove the additional target permission and select the original
identity, reducing context safely first if it exceeds the old window. Restore
only supervision/resource overrides introduced for the experiment. Never edit
session JSONL/blobs, and never roll the protocol back to compact-v1. A 400000
catalog window is configuration, not server-capacity evidence; with Pi's
16384-token reserve its automatic threshold is above 383616 tokens.

Environment overrides (none grants additional CLIProxy targets):

| Variable                                           | Effect                                                      |
|----------------------------------------------------|-------------------------------------------------------------|
| `PI_OPENAI_SERVER_COMPACTION_ENABLED`              | Enable/disable the extension                                |
| `PI_OPENAI_SERVER_COMPACTION_AZURE`                | Include Azure OpenAI models                                 |
| `PI_OPENAI_SERVER_COMPACTION_THRESHOLD`            | Explicit compact threshold (tokens)                         |
| `PI_OPENAI_SERVER_COMPACTION_RATIO`                | Compact threshold as ratio of context window (default: 0.7) |
| `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID` | Enable/disable `previous_response_id`                       |
| `PI_OPENAI_SERVER_COMPACTION_NOTIFY`               | Show UI notifications when features activate                |

## Troubleshooting

If something goes wrong:

1. **Quick disable:** set `PI_OPENAI_SERVER_COMPACTION_ENABLED=0` or add `"enabled": false` to config
2. **Bypass entirely:** run Pi with `--no-extensions`
3. **Reload:** run `/reload` in Pi to re-initialize extensions
4. **Uninstall:** `pi remove pi-openai-server-compaction`
5. **Inspect:** check your session JSONL for `compaction` entries with `details.remoteCompaction` to see if remote compaction was recorded

## Testing

Focused validation (typecheck, offline smoke, package contents, dependency audit):

```bash
npm test && npm pack --dry-run && npm audit
```

Live end-to-end test (requires working Pi + OpenAI auth):

```bash
npm run test:live
```

Override the test model:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:live
```

The offline `scripts/cli-proxy-targets.mjs` suite uses real Pi 0.85.1 catalogs,
auth resolution, Responses serialization, SDK lifecycle and JSONL persistence;
only HTTP responses/artifacts are synthetic. It proves no upstream recall.
The opt-in live fixture `tests/live/cli-proxy-target-canary.mjs` requires explicit
`--canary` authorization and a clean committed head. `--capacity` additionally
requires a passing canary result on that exact head; it sends one tokenized
~300k synthetic input, not a 400k-boundary or large-compaction test. It is not
part of `npm test` and must only be used with operator authorization for the
existing CLIProxy credential reference.

## Limitations

- Pi's local JSONL/tree model remains authoritative
- Opaque remote compaction artifacts are only reused for compatible OpenAI Responses turns
- Switching to a different provider/model falls back to Pi's text-summary portability path
- Compaction usage/cost is captured in details but not yet folded into Pi's `get_session_stats()` (requires Pi core changes)

## Repo layout

| File                                       | Purpose                                                           |
|--------------------------------------------|-------------------------------------------------------------------|
| `src/index.ts`                             | Extension wiring, compaction hook, lifecycle handling             |
| `src/remote-compaction.ts`                 | Responses compaction and replacement-history handling             |
| `src/openai-ws-stream.ts`                  | WebSocket continuation path                                       |
| `src/openai-ws-connection.ts`              | WebSocket connection manager                                      |
| `src/openai.ts`                            | Model detection and payload patching                              |
| `src/custom-stream.ts`                     | Provider override entrypoint                                      |
| `src/config.ts`                            | Configuration loading                                             |
| `src/state.ts`                             | Ephemeral per-session runtime state                               |
| `src/stream-message-shared.ts`             | Shared assistant message builders                                 |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test                                       |
| `scripts/smoke.mjs`                        | Offline smoke test with peer-package bootstrapping                |
| `benchmarks/product-defaults/`             | Current default-vs-default benchmark, retained evidence, and report |
| `benchmarks/native-vs-text/`               | Earlier matched-cap benchmark, retained with a correction          |
| `ARCHITECTURE.md`                          | Design and control-flow documentation                             |
| `TESTPLAN.md`                              | Manual and automated test plan                                    |
| `CHANGELOG.md`                             | Version history                                                   |

## License

MIT. See `LICENSE.md`.
