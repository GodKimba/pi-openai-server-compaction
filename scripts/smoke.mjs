import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

const {
  activeContextMessagesToResponseItems,
  buildCodexWebSocketHeaders,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionV1Headers,
  buildRemoteCompactionV1RequestBody,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionDetails,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV1Response,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV1EndpointUrl,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  applyRemoteHistoryPayloadPatch,
  isCliProxyResponsesModel,
  supportsRemoteCompactionModel,
} = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
const {
  selectInputItemsForContinuation,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);

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
assert.equal(
  remoteCompactionV1EndpointUrl(cliProxyModel),
  "http://127.0.0.1:8317/v1/responses/compact",
);

const v1RequestBody = buildRemoteCompactionV1RequestBody({
  model: cliProxyModel,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.deepEqual(Object.keys(v1RequestBody).sort(), [
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "tools",
]);
assert.equal(JSON.stringify(v1RequestBody).includes("compaction_trigger"), false);
for (const field of ["stream", "store", "include", "tool_choice", "prompt_cache_key"]) {
  assert.equal(field in v1RequestBody, false, `v1 request must omit ${field}`);
}

const v1Headers = buildRemoteCompactionV1Headers({
  apiKey: "proxy-key",
  sessionId: "pi-session-123",
  headers: {
    authorization: "Bearer proxy-override",
    "x-remove-me": null,
    "x-proxy-header": "yes",
  },
});
assert.equal(v1Headers.authorization, "Bearer proxy-override");
assert.equal(v1Headers.session_id, "pi-session-123");
assert.equal(v1Headers.accept, "application/json");
assert.equal(v1Headers["content-type"], "application/json");
assert.equal("x-remove-me" in v1Headers, false);
assert.equal(v1Headers["x-proxy-header"], "yes");
assert.equal(
  "authorization" in buildRemoteCompactionV1Headers({
    apiKey: "proxy-key",
    headers: { authorization: null },
  }),
  false,
);

const v1Output = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "replacement" }] },
  { type: "compaction_summary", encrypted_content: "OPAQUE" },
];
assert.deepEqual(parseRemoteCompactionV1Response({ output: v1Output }).output, v1Output);
assert.throws(
  () => parseRemoteCompactionV1Response({ output: [{ type: "message", role: "user", content: [] }] }),
  /exactly one opaque compaction artifact/,
);
assert.throws(
  () => parseRemoteCompactionV1Response({ output: [
    { type: "compaction", encrypted_content: "ONE" },
    { type: "compaction_summary", encrypted_content: "TWO" },
  ] }),
  /got 2/,
);
assert.deepEqual(
  applyRemoteHistoryPayloadPatch({
    payload: { model: "gpt-5.6-sol", messages: ["old"], previous_response_id: "resp_old" },
    explicitHistory: v1Output,
  }),
  { model: "gpt-5.6-sol", input: v1Output },
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
const activeContextSession = SessionManager.inMemory(repoRoot);
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

let capturedV1RequestBody;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  capturedV1RequestBody = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({
    output: [{ type: "compaction_summary", encrypted_content: "SYNTHETIC_NONEMPTY_ARTIFACT" }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
let successfulV1Result;
try {
  successfulV1Result = await callRemoteCompactionEndpoint({
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
assert.deepEqual(capturedV1RequestBody.input, firstRemoteInput);
assert.equal(occurrences(JSON.stringify(capturedV1RequestBody.input), "ACTIVE_LOCAL_SUMMARY"), 1);
assert.equal(occurrences(JSON.stringify(capturedV1RequestBody.input), "SUPERSEDED_RAW_HISTORY"), 0);
const successfulArtifacts = successfulV1Result.output.filter(
  (item) =>
    (item.type === "compaction" || item.type === "compaction_summary") &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0,
);
assert.equal(successfulArtifacts.length, 1);

const persistedV1Details = buildRemoteCompactionDetails(cliProxyModel, successfulV1Result.output);
assert.equal(persistedV1Details.implementation, "responses_compact_v1");
activeContextSession.appendCompaction("PORTABLE_REMOTE_SUMMARY", firstKeptEntryId, 500, {
  remoteCompaction: persistedV1Details,
}, true);
activeContextSession.appendMessage({ role: "user", content: "AFTER_RELOAD_USER", timestamp: Date.now() });
activeContextSession.appendMessage(assistantMessage("AFTER_RELOAD_REPLY"));
const resumedV1State = reconstructRemoteCompactionStateFromBranch({
  branchEntries: activeContextSession.getBranch(),
});
assert.ok(resumedV1State, "expected persisted v1 state to reconstruct after resume");
assert.equal(
  resumedV1State.explicitHistory.filter(
    (item) => item.type === "compaction" || item.type === "compaction_summary",
  ).length,
  1,
);
const resumedV1Json = JSON.stringify(resumedV1State.explicitHistory);
assert.equal(occurrences(resumedV1Json, "AFTER_RELOAD_USER"), 1);
assert.equal(occurrences(resumedV1Json, "AFTER_RELOAD_REPLY"), 1);
assert.equal(occurrences(resumedV1Json, "SUPERSEDED_RAW_HISTORY"), 0);

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

const v1Details = buildRemoteCompactionDetails(cliProxyModel, v1Output);
assert.equal(v1Details.version, 1);
assert.equal(v1Details.provider, "openai-responses-compact");
assert.equal(v1Details.implementation, "responses_compact_v1");
assert.deepEqual(v1Details.replacementHistory, v1Output);

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
