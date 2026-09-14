// Offline integration: real Pi catalog, auth resolution, SDK lifecycle, JSONL,
// and Responses serializer. Only HTTP responses are mocked; opaque data below
// is synthetic and proves neither upstream compaction nor recall.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { loadConfig, parseAstraTarget } from "../src/config.ts";
import { isCliProxyResponsesModel, supportsRemoteCompactionModel, modelKey, supportsPreviousResponseId } from "../src/openai.ts";
import { remoteCompactionV2EndpointUrl } from "../src/remote-compaction.ts";

const root = mkdtempSync(resolve(".targets-test-"));
// Model catalog publication can finish after SDK session disposal.
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
const cwd = join(root, "cwd");
mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(join(cwd, ".pi"));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let session;
const target = { provider: "cliproxy-main-400k", api: "openai-responses", modelId: "gpt-6-astra", baseUrl: "http://127.0.0.1:8317/v1" };
const writeConfig = (astraTarget = target, extra = {}) => writeFileSync(join(agentDir, "openai-server-compaction.json"), JSON.stringify({ astraTarget, ...extra }));
try {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.PI_OFFLINE = "1";
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_OPENAI_SERVER_COMPACTION_")) delete process.env[key];
  assert.equal(loadConfig(cwd).astraTarget, null);
  const model = { id: target.modelId, name: "Synthetic Astra", reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const transport = { api: target.api, baseUrl: target.baseUrl, apiKey: "synthetic-original-key" };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    cliproxy: { ...transport, models: [model] },
    [target.provider]: { ...transport, apiKey: "synthetic-alias-key", models: [{ ...model, contextWindow: 400000 }] },
  } }));
  const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  const main = runtime.getModel(target.provider, model.id);
  const original = runtime.getModel("cliproxy", model.id);
  assert.equal(main.contextWindow, 400000);
  assert.equal(original.contextWindow, 272000);
  const workerRuntime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  assert.equal(workerRuntime.getModel("cliproxy", model.id).contextWindow, 272000);
  assert.equal(workerRuntime.getModel(main.provider, model.id).contextWindow, 400000, "follow-main is NOT an isolated supervision selection");
  assert.equal(isCliProxyResponsesModel(main), false);
  writeConfig();
  let cfg = loadConfig(cwd);
  assert.equal(isCliProxyResponsesModel(main, cfg), true);
  assert.equal(isCliProxyResponsesModel(original, cfg), true);
  assert.equal(supportsPreviousResponseId(main, cfg), false);
  assert.notEqual(modelKey(main), modelKey(original));
  assert.equal(modelKey(main), modelKey({ ...main, contextWindow: 272000 }));
  for (const change of [
    { provider: "cliproxy-main-400k-extra" }, { provider: "CLIPROXY-MAIN-400K" },
    { id: "gpt-6-astra-400k" }, { api: "openai-completions" },
    { baseUrl: "http://localhost:8317/v1" }, { baseUrl: target.baseUrl + "/" },
    { baseUrl: "https://127.0.0.1:8317/v1" }, { baseUrl: "http://127.0.0.1:8318/v1" },
    { baseUrl: target.baseUrl + "?x=1" }, { baseUrl: target.baseUrl + "#fragment" },
    { baseUrl: "http://user@127.0.0.1:8317/v1" },
  ]) {
    assert.equal(isCliProxyResponsesModel({ ...main, ...change }, cfg), false);
    assert.equal(supportsRemoteCompactionModel({ ...main, ...change }, cfg), false);
  }
  for (const invalid of [{}, "*", [], [target], [target, target], { ...target, extra: true }, { ...target, provider: "*" }, { ...target, provider: "other-main" }, { ...target, modelId: "gpt-*" }, { ...target, modelId: "gpt-5" }, { ...target, api: "openai-codex-responses" }, ...["file:///v1", target.baseUrl + "?", target.baseUrl + "#", "http://a:b@host/v1", "http://host/path", "http://host/*/v1", " http://host/v1", "http://host:80/v1"].map(baseUrl => ({ ...target, baseUrl }))]) assert.throws(() => parseAstraTarget(invalid), /Invalid global astraTarget/);
  writeFileSync(join(cwd, ".pi/openai-server-compaction.json"), JSON.stringify({ astraTarget: { ...target, provider: "project-allowed" } }));
  assert.deepEqual(loadConfig(cwd).astraTarget, target);
  writeConfig(null, { cliProxyTargets: [target] });
  assert.equal(isCliProxyResponsesModel(main, loadConfig(cwd)), false);
  assert.equal(isCliProxyResponsesModel(original, loadConfig(cwd)), true);
  writeConfig(null);
  assert.equal(isCliProxyResponsesModel(main, loadConfig(cwd)), false);
  writeConfig();
  assert.equal(remoteCompactionV2EndpointUrl(main, cfg), target.baseUrl + "/responses");
  let captured = [];
  let failRemote = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    assert.equal(String(url), target.baseUrl + "/responses");
    assert.equal(body.model, target.modelId);
    const remote = body.input?.some(i => i.type === "compaction_trigger");
    if (remote) assert.equal(init.redirect, "error", "opt-in fetch must not redirect off the approved base");
    captured.push({ body, headers, remote });
    if (remote && failRemote) return new Response("synthetic not found", { status: 404 });
    const item = remote ? { id: "cmp-offline", type: "compaction", encrypted_content: "SYNTHETIC_OPAQUE_NOT_UPSTREAM" } : { id: "msg-offline", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic reply with no recall claim.", annotations: [] }] };
    const response = { id: "resp-offline", object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 3100, output_tokens: 12, total_tokens: 3112 } };
    const events = [ { type: "response.created", response: { ...response, output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response } ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16384 }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const open = async (sm, selected = main) => {
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension], systemPromptOverride: () => "Synthetic fixture only. Reply briefly." });
    await loader.reload();
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(loader.getExtensions().errors.length, 0);
    const result = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: selected, resourceLoader: loader, settingsManager, noTools: "all", thinkingLevel: "medium", sessionManager: sm });
    session = result.session;
    await session.bindExtensions({});
    session.subscribe(event => {
      if (event.type === "extension_error") throw new Error(event.error);
    });
    return session;
  };
  const sm = SessionManager.create(cwd, join(root, "sessions"));
  await open(sm);
  await session.prompt("Synthetic padding. ".repeat(700));
  assert.equal(session.messages.at(-1).stopReason, "stop");
  assert.equal(captured[0].headers.get("authorization"), "Bearer synthetic-alias-key");
  assert.notEqual(captured[0].body.store, true);
  assert.equal(captured[0].body.previous_response_id, undefined);
  await session.prompt("A short synthetic tail. Reply briefly.");
  const result = await session.compact("Summarize briefly.");
  assert.equal(result.details.remoteCompaction.implementation, "responses_compaction_v2");
  assert.equal(result.details.remoteCompaction.modelKey, modelKey(main));
  const remote = captured.find(r => r.remote);
  assert.equal(remote.headers.get("authorization"), "Bearer synthetic-alias-key");
  assert.equal(remote.headers.get("x-codex-beta-features"), "remote_compaction_v2");
  for (const header of ["chatgpt-account-id", "originator", "x-codex-installation-id", "x-codex-window-id"]) assert.equal(remote.headers.get(header), null);
  const file = session.sessionFile;
  const persisted = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(persisted.filter(e => e.type === "compaction" && e.details?.remoteCompaction).length, 1);
  const hasArtifact = request => request.body.input.some(i => i.type === "compaction");
  await session.prompt("Synthetic continuation.");
  assert.equal(hasArtifact(captured.at(-1)), true);
  await session.setModel(original);
  await session.prompt("Original identity synthetic turn.");
  assert.equal(hasArtifact(captured.at(-1)), false);
  assert.equal(captured.at(-1).headers.get("authorization"), "Bearer synthetic-original-key");
  await session.setModel(main);
  await session.prompt("Alias synthetic return.");
  assert.equal(hasArtifact(captured.at(-1)), true);
  session.dispose();
  await open(SessionManager.open(file));
  await session.prompt("Synthetic resumed continuation.");
  assert.equal(hasArtifact(captured.at(-1)), true);
  assert.equal(JSON.stringify(captured.at(-1).body).includes("Original identity synthetic turn."), false);
  writeConfig(null);
  await session.prompt("Permission removed.");
  assert.equal(hasArtifact(captured.at(-1)), false);
  writeConfig(target, { enabled: false });
  await session.prompt("Extension disabled.");
  assert.equal(hasArtifact(captured.at(-1)), false);
  writeConfig();
  // Hook-boundary negatives explicitly mock only resolved auth, not catalogs.
  const handlers = new Map();
  extension({ registerProvider() {}, on: (name, handler) => handlers.set(name, handler), getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "medium" });
  let authCalls = 0;
  const ctx = { cwd, model: main, hasUI: false, modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: "synthetic-alias-key", baseUrl: "http://other.invalid/v1" }; } } };
  const count = captured.length;
  assert.equal(await handlers.get("session_before_compact")({}, ctx), undefined);
  assert.equal(captured.length, count);
  writeConfig(null);
  assert.equal(await handlers.get("session_before_compact")({}, ctx), undefined);
  assert.equal(authCalls, 1, "removed permission must not resolve auth");
  writeConfig(target, { enabled: false });
  assert.equal(await handlers.get("session_before_compact")({}, ctx), undefined);
  assert.equal(authCalls, 1, "disabled extension must not resolve auth");
  writeConfig();
  for (const auth of [{ ok: false, error: "synthetic missing key" }, { ok: true }, { ok: true, apiKey: "synthetic-alias-key", env: { HTTP_PROXY: "http://unapproved.invalid" } }]) {
    ctx.modelRegistry.getApiKeyAndHeaders = async selected => {
      assert.equal(selected.provider, target.provider);
      return auth;
    };
    assert.equal(await handlers.get("session_before_compact")({}, ctx), undefined);
    assert.equal(captured.length, count, "auth refusal must not issue remote or portable fetch");
  }
  writeConfig({ ...target, api: "invalid" });
  assert.throws(() => loadConfig(cwd), /Invalid global astraTarget/);
  writeConfig();
  failRemote = true;
  const beforeFailures = captured.filter(r => r.remote).length;
  await session.compact();
  await session.prompt("Synthetic turn after failed remote compaction.");
  await session.compact();
  assert.equal(captured.filter(r => r.remote).length, beforeFailures + 1, "404 disables subsequent remote attempts");
  session.dispose();
  session = undefined;
  // Real resource consumer regression for reversible project filtering. The
  // old package is a sentinel fixture, never the installed production copy.
  const oldPackage = join(root, "old-package");
  mkdirSync(oldPackage);
  writeFileSync(join(oldPackage, "package.json"), JSON.stringify({ name: "synthetic-old-extension", pi: { extensions: ["index.ts"] } }));
  writeFileSync(join(oldPackage, "index.ts"), "export default function () { throw new Error('OLD_EXTENSION_MUST_NOT_LOAD'); }\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [oldPackage] }));
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [
    { source: oldPackage, autoload: false, extensions: ["-index.ts"] },
    { source: resolve(".") },
  ] }));
  const filteredSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const filteredLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: filteredSettings, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await filteredLoader.reload();
  assert.deepEqual(filteredLoader.getExtensions().errors, []);
  assert.equal(filteredLoader.getExtensions().extensions.length, 1);
  assert.equal(filteredLoader.getExtensions().extensions[0].path, resolve("src/index.ts"));
  console.log("PASS offline: real Pi 0.85.1 catalogs, serializer, SDK compaction/persistence/resume/model round-trip and resource filtering; exact global-only Astra target, auth and 404 negatives. HTTP/artifact mocked, not upstream recall.");
} finally {
  session?.dispose();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
}
