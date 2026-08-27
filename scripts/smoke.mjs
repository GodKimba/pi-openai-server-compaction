import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots() {
  const roots = new Set();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName) {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName) {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const {
  getAgentDir,
  SessionManager,
  sessionEntryToContextMessages,
} = await import("@earendil-works/pi-coding-agent");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = "~/.pi-agent-dir-smoke";
assert.equal(getAgentDir(), join(homedir(), ".pi-agent-dir-smoke"));
if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const remoteCompactionModule = await import(
  pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href
);
const {
  activeContextMessagesToResponseItems,
  buildCodexWebSocketHeaders,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionDetails,
  isAbortedRemoteCompactionFailure,
  isRouteLevelRemoteCompactionFailure,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  RemoteCompactionError,
  remoteCompactionV2EndpointUrl,
} = remoteCompactionModule;
const {
  applyRemoteHistoryPayloadPatch,
  isCliProxyResponsesModel,
  supportsRemoteCompactionModel,
} = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
const {
  clearRemoteCompactionGates,
  getRemoteCompactionGate,
  isRemoteCompactionAllowed,
  recordRemoteCompactionFailure,
  recordRemoteCompactionSuccess,
} = await import(pathToFileURL(join(repoRoot, "src", "state.ts")).href);
const {
  selectInputItemsForContinuation,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);

// The legacy compact-v1 selection is the regression this package must never
// reintroduce: CLIProxyAPI still routes POST /v1/responses/compact, but the
// Codex upstream behind it now answers 404, which cools every credential in the
// pool and makes later ordinary turns fail with auth_unavailable.
for (const removedExport of [
  "remoteCompactionV1EndpointUrl",
  "buildRemoteCompactionV1Headers",
  "buildRemoteCompactionV1RequestBody",
  "parseRemoteCompactionV1Response",
]) {
  assert.equal(
    removedExport in remoteCompactionModule,
    false,
    `${removedExport} must stay removed so compact v1 cannot be reselected`,
  );
}
// Match a `/compact` path segment that terminates a string or template literal,
// which is how such a URL would actually be built. Prose in comments is fine.
const compactEndpointLiteral = /\/compact(?:["'`]|\$\{)/;
for (const sourceFile of [
  "config.ts",
  "custom-stream.ts",
  "index.ts",
  "openai-ws-connection.ts",
  "openai-ws-stream.ts",
  "openai.ts",
  "remote-compaction.ts",
  "state.ts",
  "stream-message-shared.ts",
]) {
  assert.doesNotMatch(
    readFileSync(join(repoRoot, "src", sourceFile), "utf8"),
    compactEndpointLiteral,
    `src/${sourceFile} must not construct the legacy /responses/compact endpoint`,
  );
}

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.ok(reconstructed, "expected reconstructed remote compaction state");
const reconstructedJson = JSON.stringify(reconstructed.explicitHistory);
assert.match(reconstructedJson, /KEEP_ME_ONE/);
assert.match(reconstructedJson, /KEEP_REPLY_ONE/);
assert.match(reconstructedJson, /KEEP_ME_TWO/);
assert.match(reconstructedJson, /KEEP_REPLY_TWO/);
assert.doesNotMatch(reconstructedJson, /DROP_ME/);
assert.doesNotMatch(reconstructedJson, /DROP_REPLY/);

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }),
  "https://api.openai.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }),
  "https://chatgpt.com/backend-api/codex/responses",
);

const cliProxyModel = {
  provider: "cliproxy",
  api: "openai-responses",
  id: "gpt-5.6-sol",
  baseUrl: "http://127.0.0.1:8317/v1",
};
assert.equal(isCliProxyResponsesModel(cliProxyModel), true);
assert.equal(supportsRemoteCompactionModel(cliProxyModel), true);
assert.equal(isCliProxyResponsesModel({ ...cliProxyModel, provider: "openai" }), false);
assert.equal(isCliProxyResponsesModel({ ...cliProxyModel, api: "openai-codex-responses" }), false);
assert.equal(isCliProxyResponsesModel({ ...cliProxyModel, baseUrl: "file:///tmp/proxy" }), false);
assert.equal(isCliProxyResponsesModel({ ...cliProxyModel, baseUrl: "" }), false);
assert.equal(isCliProxyResponsesModel({ ...cliProxyModel, id: "cliproxy-looking-name", provider: "other" }), false);
// CLIProxy compaction now uses the ordinary Responses endpoint, never /compact.
assert.equal(
  remoteCompactionV2EndpointUrl(cliProxyModel),
  "http://127.0.0.1:8317/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({ ...cliProxyModel, baseUrl: "http://127.0.0.1:8317" }),
  "http://127.0.0.1:8317/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({ ...cliProxyModel, baseUrl: "http://127.0.0.1:8317/v1/responses" }),
  "http://127.0.0.1:8317/v1/responses",
);

const cliProxyRequestBody = buildRemoteCompactionRequestBody({
  model: cliProxyModel,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  sessionId: "pi-session-123",
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.deepEqual(cliProxyRequestBody.input.at(-1), { type: "compaction_trigger" });
assert.equal(cliProxyRequestBody.stream, true);
assert.equal(cliProxyRequestBody.store, false);
assert.equal(cliProxyRequestBody.prompt_cache_key, "pi-session-123");

// The proxy selects the upstream account and injects its real Codex identity,
// so the extension must not synthesize one from the loopback proxy credential.
const cliProxyHeaders = buildRemoteCompactionHeaders({
  model: cliProxyModel,
  apiKey: "proxy-key",
  sessionId: "pi-session-123",
  headers: {
    authorization: "Bearer proxy-override",
    "x-remove-me": null,
    "x-proxy-header": "yes",
  },
});
assert.equal(cliProxyHeaders.authorization, "Bearer proxy-override");
assert.equal(cliProxyHeaders.session_id, "pi-session-123");
assert.equal(cliProxyHeaders["x-client-request-id"], "pi-session-123");
assert.equal(cliProxyHeaders.accept, "text/event-stream");
assert.equal(cliProxyHeaders["content-type"], "application/json");
assert.equal(cliProxyHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal("x-remove-me" in cliProxyHeaders, false);
assert.equal(cliProxyHeaders["x-proxy-header"], "yes");
for (const forbidden of [
  "chatgpt-account-id",
  "originator",
  "user-agent",
  "x-codex-installation-id",
  "x-codex-window-id",
]) {
  assert.equal(forbidden in cliProxyHeaders, false, `cliproxy headers must omit ${forbidden}`);
}
assert.equal(
  "authorization" in buildRemoteCompactionHeaders({
    model: cliProxyModel,
    apiKey: "proxy-key",
    headers: { authorization: null },
  }),
  false,
);

// Persisted compact-v1 artifacts from sessions recorded before this change stay
// readable and replayable; only the outbound protocol selection changed.
const legacyV1Output = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "replacement" }] },
  { type: "compaction_summary", encrypted_content: "OPAQUE" },
];
const legacyV1Details = extractRemoteCompactionDetails({
  remoteCompaction: {
    version: 1,
    provider: "openai-responses-compact",
    implementation: "responses_compact_v1",
    modelKey: "cliproxy:openai-responses:gpt-5.6-sol",
    replacementHistory: legacyV1Output,
  },
});
assert.ok(legacyV1Details, "persisted compact-v1 details must remain readable");
assert.equal(legacyV1Details.version, 1);
assert.deepEqual(legacyV1Details.replacementHistory, legacyV1Output);
assert.deepEqual(
  applyRemoteHistoryPayloadPatch({
    payload: { model: "gpt-5.6-sol", messages: ["old"], previous_response_id: "resp_old" },
    explicitHistory: legacyV1Output,
  }),
  { model: "gpt-5.6-sol", input: legacyV1Output },
);

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistantMessage = (text) => ({
  role: "assistant",
  provider: "cliproxy",
  api: "openai-responses",
  model: "gpt-5.6-sol",
  content: [{ type: "text", text }],
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: Date.now(),
});
const persistedSessionDir = mkdtempSync(join(repoRoot, ".smoke-session-"));
const cleanupPersistedSession = () => rmSync(persistedSessionDir, { recursive: true, force: true });
process.once("exit", cleanupPersistedSession);
const activeContextSession = SessionManager.create(repoRoot, persistedSessionDir);
activeContextSession.appendMessage({ role: "user", content: "SUPERSEDED_RAW_HISTORY", timestamp: Date.now() });
activeContextSession.appendMessage(assistantMessage("SUPERSEDED_RAW_REPLY"));
const firstKeptEntryId = activeContextSession.appendMessage({
  role: "user",
  content: "KEPT_HISTORY",
  timestamp: Date.now(),
});
activeContextSession.appendMessage(assistantMessage("KEPT_REPLY"));
activeContextSession.appendCompaction("ACTIVE_LOCAL_SUMMARY", firstKeptEntryId, 1000);
activeContextSession.appendMessage({ role: "user", content: "CURRENT_HISTORY", timestamp: Date.now() });
activeContextSession.appendMessage(assistantMessage("CURRENT_REPLY"));

const firstRemoteInput = normalizeResponseItemsForPrompt(
  activeContextMessagesToResponseItems(
    activeContextSession.buildContextEntries().flatMap(sessionEntryToContextMessages),
  ),
  cliProxyModel,
);
const firstRemoteInputJson = JSON.stringify(firstRemoteInput);
const occurrences = (text, marker) => text.split(marker).length - 1;
assert.equal(occurrences(firstRemoteInputJson, "ACTIVE_LOCAL_SUMMARY"), 1);
assert.equal(occurrences(firstRemoteInputJson, "KEPT_HISTORY"), 1);
assert.equal(occurrences(firstRemoteInputJson, "KEPT_REPLY"), 1);
assert.equal(occurrences(firstRemoteInputJson, "CURRENT_HISTORY"), 1);
assert.equal(occurrences(firstRemoteInputJson, "CURRENT_REPLY"), 1);
assert.equal(occurrences(firstRemoteInputJson, "SUPERSEDED_RAW_HISTORY"), 0);
assert.equal(occurrences(firstRemoteInputJson, "SUPERSEDED_RAW_REPLY"), 0);

const sseEvent = (payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
const compactionV2Sse = [
  sseEvent({ type: "response.created", response: { id: "resp_synthetic" } }),
  sseEvent({
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "SYNTHETIC_NONEMPTY_ARTIFACT" },
  }),
  sseEvent({
    type: "response.completed",
    response: { usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } },
  }),
  "data: [DONE]\n\n",
].join("");

let capturedCliProxyUrl;
let capturedCliProxyRequestBody;
let capturedCliProxyHeaders;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  capturedCliProxyUrl = String(input);
  capturedCliProxyHeaders = init?.headers;
  capturedCliProxyRequestBody = JSON.parse(String(init?.body));
  return new Response(compactionV2Sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};
let successfulCliProxyResult;
try {
  successfulCliProxyResult = await callRemoteCompactionEndpoint({
    model: cliProxyModel,
    apiKey: "synthetic-test-key",
    sessionId: "synthetic-session",
    input: firstRemoteInput,
    instructions: "system",
    tools: [],
    parallelToolCalls: true,
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(capturedCliProxyUrl, "http://127.0.0.1:8317/v1/responses");
assert.doesNotMatch(capturedCliProxyUrl, /\/compact$/);
assert.equal(capturedCliProxyHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.deepEqual(capturedCliProxyRequestBody.input.slice(0, -1), firstRemoteInput);
assert.deepEqual(capturedCliProxyRequestBody.input.at(-1), { type: "compaction_trigger" });
assert.equal(occurrences(JSON.stringify(capturedCliProxyRequestBody.input), "ACTIVE_LOCAL_SUMMARY"), 1);
assert.equal(occurrences(JSON.stringify(capturedCliProxyRequestBody.input), "SUPERSEDED_RAW_HISTORY"), 0);
const successfulArtifacts = successfulCliProxyResult.output.filter(
  (item) => item.type === "compaction" && item.encrypted_content.length > 0,
);
assert.equal(successfulArtifacts.length, 1);
assert.equal(successfulCliProxyResult.output.at(-1).type, "compaction");
assert.equal(successfulCliProxyResult.usage?.totalTokens, 16);

const persistedCliProxyDetails = buildRemoteCompactionDetails(
  cliProxyModel,
  successfulCliProxyResult.output,
  successfulCliProxyResult.usage,
);
assert.equal(persistedCliProxyDetails.implementation, "responses_compaction_v2");
assert.equal(persistedCliProxyDetails.version, 2);
activeContextSession.appendCompaction("PORTABLE_REMOTE_SUMMARY", firstKeptEntryId, 500, {
  remoteCompaction: persistedCliProxyDetails,
}, true);
activeContextSession.appendMessage({ role: "user", content: "AFTER_RELOAD_USER", timestamp: Date.now() });
activeContextSession.appendMessage(assistantMessage("AFTER_RELOAD_REPLY"));
const persistedSessionFile = activeContextSession.getSessionFile();
assert.ok(persistedSessionFile, "expected persisted session file");
const resumedSession = SessionManager.open(persistedSessionFile, persistedSessionDir);
const resumedCliProxyState = reconstructRemoteCompactionStateFromBranch({
  branchEntries: resumedSession.getBranch(),
});
assert.ok(resumedCliProxyState, "expected persisted state to reconstruct after resume");
assert.equal(resumedCliProxyState.modelKey, "cliproxy:openai-responses:gpt-5.6-sol");
assert.equal(
  resumedCliProxyState.explicitHistory.filter(
    (item) => item.type === "compaction" || item.type === "compaction_summary",
  ).length,
  1,
);
const resumedCliProxyJson = JSON.stringify(resumedCliProxyState.explicitHistory);
assert.equal(occurrences(resumedCliProxyJson, "AFTER_RELOAD_USER"), 1);
assert.equal(occurrences(resumedCliProxyJson, "AFTER_RELOAD_REPLY"), 1);
assert.equal(occurrences(resumedCliProxyJson, "SUPERSEDED_RAW_HISTORY"), 0);
assert.equal(occurrences(resumedCliProxyJson, "SYNTHETIC_NONEMPTY_ARTIFACT"), 1);

// A 404 from the compaction route must be a one-shot, contained failure: the
// caller learns the status, the gate closes, and persisted history is untouched.
const branchBefore404 = JSON.stringify(resumedSession.getBranch());
let attemptsAgainstBroken404 = 0;
globalThis.fetch = async () => {
  attemptsAgainstBroken404 += 1;
  return new Response(JSON.stringify({ detail: "Not Found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
};
let brokenRouteError;
try {
  await callRemoteCompactionEndpoint({
    model: cliProxyModel,
    apiKey: "synthetic-test-key",
    sessionId: "synthetic-session",
    input: firstRemoteInput,
    instructions: "system",
    tools: [],
    parallelToolCalls: true,
  });
} catch (error) {
  brokenRouteError = error;
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(attemptsAgainstBroken404, 1, "a failing compaction route must not be retried in-place");
assert.ok(brokenRouteError instanceof RemoteCompactionError);
assert.equal(brokenRouteError.status, 404);
assert.equal(isRouteLevelRemoteCompactionFailure(brokenRouteError), true);
assert.equal(
  JSON.stringify(resumedSession.getBranch()),
  branchBefore404,
  "a failed remote compaction must not mutate persisted history",
);
process.removeListener("exit", cleanupPersistedSession);
cleanupPersistedSession();

// Eligibility gate: a route-level failure disables the backend immediately,
// other failures are tolerated up to the consecutive limit, success resets.
clearRemoteCompactionGates();
const gateKey = "cliproxy:openai-responses:gpt-5.6-sol";
assert.equal(isRemoteCompactionAllowed(gateKey), true);
const routeGate = recordRemoteCompactionFailure({
  modelKey: gateKey,
  routeLevel: true,
  reason: "OpenAI remote compaction v2 failed (404): Not Found",
});
assert.equal(routeGate.disabled, true);
assert.equal(routeGate.justDisabled, true);
assert.equal(isRemoteCompactionAllowed(gateKey), false);
assert.match(getRemoteCompactionGate(gateKey).reason, /404/);
assert.equal(
  recordRemoteCompactionFailure({ modelKey: gateKey, routeLevel: true, reason: "again" }).justDisabled,
  false,
  "the gate must only announce itself once",
);
assert.equal(isRemoteCompactionAllowed("openai:openai-responses:gpt-5.6-luna"), true);

clearRemoteCompactionGates();
const transientGate = recordRemoteCompactionFailure({
  modelKey: gateKey,
  routeLevel: false,
  reason: "OpenAI remote compaction v2 failed (503): upstream busy",
});
assert.equal(transientGate.disabled, false);
assert.equal(isRemoteCompactionAllowed(gateKey), true);
recordRemoteCompactionSuccess(gateKey);
assert.equal(getRemoteCompactionGate(gateKey), undefined);
recordRemoteCompactionFailure({ modelKey: gateKey, routeLevel: false, reason: "one" });
assert.equal(
  recordRemoteCompactionFailure({ modelKey: gateKey, routeLevel: false, reason: "two" }).disabled,
  true,
);
assert.equal(isRemoteCompactionAllowed(gateKey), false);
clearRemoteCompactionGates();

const abortError = new Error("The operation was aborted.");
abortError.name = "AbortError";
assert.equal(isAbortedRemoteCompactionFailure(abortError), true);
assert.equal(isAbortedRemoteCompactionFailure(new RemoteCompactionError("boom", 503)), false);
assert.equal(isRouteLevelRemoteCompactionFailure(new RemoteCompactionError("boom", 503)), false);
assert.equal(isRouteLevelRemoteCompactionFailure(new RemoteCompactionError("gone", 410)), true);
assert.equal(isRouteLevelRemoteCompactionFailure(new Error("no status")), false);

// End-to-end wiring: drive the real session_before_compact handler and confirm
// that one 404 stops the extension from issuing any further compaction request
// for that model. This is the behaviour that keeps a single /compact from
// walking a proxied account pool into cooldown.
{
  clearRemoteCompactionGates();
  const handlers = new Map();
  const notices = [];
  const gatedModel = {
    provider: "cliproxy",
    api: "openai-responses",
    id: "gpt-5.6-sol",
    baseUrl: "http://127.0.0.1:8317/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const pi = {
    registerProvider: () => {},
    on: (name, handler) => handlers.set(name, handler),
    getAllTools: () => [],
    getActiveTools: () => [],
    getThinkingLevel: () => "medium",
  };
  extensionFactory(pi);
  const beforeCompact = handlers.get("session_before_compact");
  assert.equal(typeof beforeCompact, "function", "extension must register session_before_compact");

  const ctx = {
    cwd: repoRoot,
    model: gatedModel,
    hasUI: true,
    ui: { notify: (message, level) => notices.push({ message, level }) },
    getSystemPrompt: () => "system",
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-test-key", headers: {} }),
    },
    sessionManager: {
      getSessionId: () => "gate-session",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
  };
  const event = {
    branchEntries: [],
    customInstructions: undefined,
    signal: new AbortController().signal,
    preparation: {
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
      messagesToSummarize: [],
      turnPrefixMessages: [],
    },
  };

  let compactionRequests = 0;
  let otherRequests = 0;
  globalThis.fetch = async (input, init) => {
    const body = String(init?.body ?? "");
    if (body.includes("compaction_trigger")) {
      compactionRequests += 1;
      assert.doesNotMatch(String(input), /\/compact$/);
      return new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    // Portable-summary calls are not under test here; fail them so the handler
    // exercises its no-summary fallback without touching the network.
    otherRequests += 1;
    throw new Error("synthetic offline transport");
  };
  try {
    await beforeCompact(event, ctx);
    assert.equal(compactionRequests, 1, "first compaction should attempt the remote call once");
    assert.equal(isRemoteCompactionAllowed("cliproxy:openai-responses:gpt-5.6-sol"), false);
    assert.equal(notices.length, 1, "closing the gate must be announced exactly once");
    assert.match(notices[0].message, /Remote compaction is now disabled/);

    await beforeCompact(event, ctx);
    assert.equal(compactionRequests, 1, "a closed gate must issue no further compaction request");
    assert.equal(notices.length, 1, "a closed gate must not re-announce itself");
  } finally {
    globalThis.fetch = originalFetch;
    clearRemoteCompactionGates();
  }
  assert.ok(otherRequests >= 0);
}

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: { "x-extra": "yes", "x-remove": null },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal("x-remove" in compactionHeaders, false);
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const websocketHeaders = buildCodexWebSocketHeaders("session-123");
assert.equal(websocketHeaders["x-client-request-id"], "session-123");
assert.equal(websocketHeaders.session_id, "session-123");
assert.equal(websocketHeaders["x-codex-window-id"], "session-123:0");

// Every supported backend now persists the same compaction-v2 marker, so a new
// artifact can never be labelled as produced by the removed compact-v1 route.
const newCliProxyHistory = [{ type: "compaction", encrypted_content: "OPAQUE" }];
for (const model of [
  cliProxyModel,
  { provider: "openai", api: "openai-responses", id: "gpt-5.4-nano" },
  { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
]) {
  const details = buildRemoteCompactionDetails(model, newCliProxyHistory);
  assert.equal(details.version, 2);
  assert.equal(details.provider, "openai-responses-compaction");
  assert.equal(details.implementation, "responses_compaction_v2");
  assert.deepEqual(details.replacementHistory, newCliProxyHistory);
}

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

const incrementalInput = selectInputItemsForContinuation({
  context: {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "old user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new user" }],
      },
    ],
  },
  model: { input: ["text"] },
  session: { lastContextLength: 2 },
  currentModelKey: targetModelKey,
  remoteCompactionState: undefined,
  previousResponseId: "resp_123",
});
assert.deepEqual(incrementalInput, [
  {
    type: "message",
    role: "user",
    content: "new user",
  },
]);

console.log("smoke ok");
