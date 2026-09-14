// Explicit, synthetic SDK fixture. Never loaded by npm test. No tools, resource
// discovery, credential dumps, retries, proxy changes, or production writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import extension from "../../src/index.ts";

const mode = process.argv[2];
if (!["--canary", "--capacity"].includes(mode)) throw new Error("Explicit --canary or --capacity authorization required");
execFileSync("git", ["diff", "--quiet", "HEAD"]);
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = mkdtempSync(resolve(".private-target-live-"));
const agentDir = join(root, "agent");
const cwd = join(root, "cwd");
mkdirSync(agentDir); mkdirSync(cwd);
const report = { head, mode, tokenizer: "o200k_base (local encoding, not a certified Astra tokenizer)", requests: [], checks: {}, verdict: "FAIL" };
const reportPath = resolve(mode === "--canary" ? ".target-canary-result.json" : ".target-capacity-result.json");
const savedEnv = { ...process.env };
const nativeFetch = globalThis.fetch;
const abort = new AbortController();
let failed = false;
let session;
let marker;
let checkingRecall = false;
let allowedBase;
let expectedAuth;
const fail = () => { failed = true; abort.abort(); };
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
try {
  // Read the model catalog only; retain the existing command REFERENCE. Never
  // open auth.json, shell.zsh, account files, or print this object/command/key.
  const source = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models.json"), "utf8")).providers.cliproxy;
  assert.equal(source.api, "openai-responses");
  assert.equal(source.baseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(typeof source.apiKey, "string");
  assert.ok(source.apiKey.startsWith("!"));
  assert.ok(!source.apiKey.includes("shell.zsh"));
  const sourceModel = source.models.find(m => m.id === "gpt-6-astra");
  assert.equal(sourceModel.contextWindow, 272000);
  assert.equal(sourceModel.api ?? source.api, "openai-responses");
  const provider = "cliproxy-main-400k";
  allowedBase = source.baseUrl;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    cliproxy: { ...source, models: [sourceModel] },
    [provider]: { ...source, models: [{ ...sourceModel, contextWindow: 400000 }] },
  } }), { mode: 0o600 });
  writeFileSync(join(agentDir, "openai-server-compaction.json"), JSON.stringify({ astraTarget: { provider, api: source.api, modelId: sourceModel.id, baseUrl: source.baseUrl } }), { mode: 0o600 });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_OPENAI_SERVER_COMPACTION_")) delete process.env[key];
  globalThis.fetch = async (url, init) => {
    if (failed) throw new Error("Fixture stopped after first error");
    try {
      assert.equal(String(url), allowedBase + "/responses");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "gpt-6-astra");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), expectedAuth);
      const remote = body.input?.some(item => item.type === "compaction_trigger");
      const opaque = body.input?.filter(item => item.type === "compaction") ?? [];
      if (mode === "--capacity") assert.equal(remote, false);
      if (remote) {
        assert.equal(report.requests.filter(r => r.remote).length, 0);
        assert.ok(headers.get("x-codex-beta-features")?.split(",").includes("remote_compaction_v2"));
      }
      if (checkingRecall) {
        assert.equal(opaque.length, 1);
        assert.equal(JSON.stringify(body.input.filter(item => item.type !== "compaction")).includes(marker), false);
        report.checks.recallPayloadOmitsPlaintextMarker = true;
      }
      const record = { path: "/v1/responses", remote: Boolean(remote), opaqueItems: opaque.length };
      report.requests.push(record);
      const response = await nativeFetch(url, { ...init, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(600000), ...(init.signal ? [init.signal] : [])]) });
      record.status = response.status;
      if (!response.ok) fail();
      return response;
    } catch {
      fail();
      throw new Error("Live fixture request failed; details intentionally redacted");
    }
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  const main = runtime.getModel(provider, sourceModel.id);
  const original = runtime.getModel("cliproxy", sourceModel.id);
  assert.equal(main.contextWindow, 400000);
  assert.equal(original.contextWindow, 272000);
  // Resolve only the selected test identity through Pi; keep its value in RAM.
  const resolved = await new ModelRegistry(runtime).getApiKeyAndHeaders(main);
  assert.ok(resolved.apiKey);
  expectedAuth = `Bearer ${resolved.apiKey}`;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16384 }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const open = async sm => {
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension], systemPromptOverride: () => "This is an authorized synthetic memory fixture, not a coding task. Use no tools. Follow the requested output format and be concise." });
    await loader.reload();
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(loader.getExtensions().errors.length, 0);
    report.checks.onlyDevelopmentExtensionLoaded = true;
    session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: main, thinkingLevel: "medium", noTools: "all", resourceLoader: loader, settingsManager, sessionManager: sm })).session;
    await session.bindExtensions({});
    session.subscribe(event => {
      if (event.type === "extension_error" || (event.type === "message_end" && event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason))) fail();
    });
  };
  const prompt = async text => {
    assert.equal(failed, false);
    await session.prompt(text);
    assert.equal(failed, false);
    const message = session.messages.at(-1);
    assert.equal(message.stopReason, "stop");
    report.lastUsage = message.usage;
    return message.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
  };
  const sm = SessionManager.create(cwd, join(root, "sessions"));
  await open(sm);
  if (mode === "--capacity") {
    const canary = JSON.parse(readFileSync(resolve(".target-canary-result.json"), "utf8"));
    assert.equal(canary.verdict, "PASS");
    assert.equal(canary.head, head, "capacity requires a passing canary on this exact head");
    const text = "Synthetic capacity filler: amber birch cobalt delta.\n".repeat(30000) + "\nReply with exactly OK. Do not summarize the filler.";
    report.inputTokens = encode(text).length;
    assert.ok(report.inputTokens > 290000 && report.inputTokens < 320000);
    assert.equal(await prompt(text), "OK");
    const usage = report.lastUsage;
    report.checks.above272k = usage.input + usage.cacheRead + usage.cacheWrite > 272000;
    assert.equal(report.checks.above272k, true);
    report.checks.exact400k = false;
    report.checks.largeCompaction = false;
  } else {
    const filler = "Synthetic neutral padding about amber birch cobalt delta.\n".repeat(260);
    report.inputTokens = encode(filler).length;
    assert.ok(report.inputTokens >= 2000 && report.inputTokens <= 5000);
    const reply = await prompt("Invent a random fictional codename of exactly three uppercase words separated by hyphens. Reply ONLY with that codename. This will be the hidden marker for a later memory check.\n" + filler);
    assert.match(reply, /^[A-Z]+-[A-Z]+-[A-Z]+$/);
    marker = reply;
    report.checks.normalCall = true;
    await prompt("Acknowledged. This is a separate neutral tail turn. Reply only OK and do not repeat the earlier codename.");
    const result = await session.compact("Do not include the earlier invented codename or any of its words. Describe only that a synthetic memory test is ongoing. Keep the summary short.");
    assert.equal(failed, false);
    const details = result.details?.remoteCompaction;
    assert.equal(details?.implementation, "responses_compaction_v2");
    assert.equal(details.replacementHistory.filter(i => i.type === "compaction" && i.encrypted_content?.length).length, 1);
    assert.equal(result.summary.includes(marker), false);
    assert.equal(JSON.stringify(details.replacementHistory.filter(i => i.type !== "compaction")).includes(marker), false);
    const persisted = readFileSync(session.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    const compaction = persisted.find(e => e.type === "compaction" && e.details?.remoteCompaction);
    assert.ok(compaction);
    report.checks.artifactPersisted = true;
    report.checks.portableSummaryOmitsMarker = true;
    const recall = async () => {
      checkingRecall = true;
      try { assert.equal(await prompt("What was the earlier invented codename? Reply ONLY with that codename."), marker); }
      finally { checkingRecall = false; }
    };
    await recall();
    report.checks.sameProcessRecall = true;
    // Use Pi's public navigation/model APIs, never rewrite JSONL or artifacts.
    // Returning to the checkpoint removes the prior recall answer as a shortcut.
    await session.navigateTree(compaction.id, { summarize: false });
    await session.setModel(original);
    await prompt("Neutral original-identity turn. Reply only OK.");
    assert.equal(report.requests.at(-1).opaqueItems, 0);
    await session.setModel(main);
    await recall();
    report.checks.identityRoundTripRecall = true;
    await session.navigateTree(compaction.id, { summarize: false });
    await session.setModel(original);
    await session.setModel(main); // persists selected identity on the checkpoint branch
    const file = session.sessionFile;
    session.dispose();
    await open(SessionManager.open(file));
    await recall();
    report.checks.resumedRecall = true;
  }
  assert.equal(failed, false);
  report.verdict = "PASS";
} catch {
  fail();
  report.error = "First error stopped fixture; no retry. Raw provider errors and payloads intentionally not logged.";
  process.exitCode = 1;
} finally {
  session?.dispose();
  globalThis.fetch = nativeFetch;
  expectedAuth = undefined;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ verdict: report.verdict, head, reportPath, requests: report.requests.length }));
}
