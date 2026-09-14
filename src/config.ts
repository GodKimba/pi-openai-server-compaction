/**
 * Configuration loading for the extension.
 *
 * Reads global/project JSON config files plus environment overrides and exposes
 * a normalized, fully-populated runtime config object.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type JsonRecord = Record<string, unknown>;

export type CliProxyTarget = {
  provider: string;
  api: "openai-responses";
  modelId: string;
  baseUrl: string;
};

export type ExtensionConfig = {
  cliProxyTargets?: CliProxyTarget[];
  enabled?: boolean;
  includeAzure?: boolean;
  compactThreshold?: number;
  thresholdRatio?: number;
  notify?: boolean;
  usePreviousResponseId?: boolean;
};

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact static bases only; never normalize an opt-in into broader permission. */
export function isCliProxyTargetBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//.test(value) || /[\s*?#\\\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password && url.pathname.endsWith("/v1") &&
      url.href === value;
  } catch {
    return false;
  }
}

export function parseCliProxyTargets(value: unknown): CliProxyTarget[] {
  if (value === undefined) return [];
  const invalid = () => new Error(
    "Invalid global cliProxyTargets: expected exact provider/api/modelId/baseUrl entries with openai-responses and a static HTTP(S) /v1 base (no credentials, query, fragment, or patterns).",
  );
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "api,baseUrl,modelId,provider" ||
      typeof entry.provider !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(entry.provider) ||
      ["openai", "openai-codex", "azure-openai", "azure-openai-responses", "cliproxy"].includes(entry.provider) ||
      entry.api !== "openai-responses" || typeof entry.modelId !== "string" ||
      !entry.modelId || /[\s*?:]/.test(entry.modelId) || !isCliProxyTargetBaseUrl(entry.baseUrl)) throw invalid();
    return { provider: entry.provider, api: entry.api, modelId: entry.modelId, baseUrl: entry.baseUrl };
  });
}

function readJsonFile(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function loadConfig(cwd: string): Required<ExtensionConfig> {
  const globalPath = join(getAgentDir(), "openai-server-compaction.json");
  const projectPath = join(cwd, ".pi", "openai-server-compaction.json");
  const globalCfg = readJsonFile(globalPath) ?? {};
  const projectCfg = readJsonFile(projectPath) ?? {};
  const merged = { ...globalCfg, ...projectCfg };

  return {
    // Project configuration must never grant or replace transport permission.
    cliProxyTargets: parseCliProxyTargets(globalCfg.cliProxyTargets),
    enabled:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED) ??
      toBoolean(merged.enabled) ??
      true,
    includeAzure:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_AZURE) ??
      toBoolean(merged.includeAzure) ??
      false,
    compactThreshold:
      toPositiveNumber(process.env.PI_OPENAI_SERVER_COMPACTION_THRESHOLD) ??
      toPositiveNumber(merged.compactThreshold) ??
      0,
    thresholdRatio:
      toPositiveNumber(process.env.PI_OPENAI_SERVER_COMPACTION_RATIO) ??
      toPositiveNumber(merged.thresholdRatio) ??
      0.7,
    notify:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_NOTIFY) ??
      toBoolean(merged.notify) ??
      false,
    usePreviousResponseId:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID) ??
      toBoolean(merged.usePreviousResponseId) ??
      true,
  };
}

export function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toPositiveNumber(value);
  return numeric ? Math.floor(numeric) : undefined;
}
