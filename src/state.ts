/**
 * In-memory per-session runtime state.
 *
 * This data is intentionally ephemeral. Persisted remote compaction artifacts
 * live in Pi session entries; this module only caches the currently active
 * continuation and reconstructed replay state for the running process.
 */
import { REMOTE_COMPACTION_FAILURE_LIMIT } from "./remote-compaction.ts";
import type {
  RemoteCompactionSessionState,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./remote-compaction.ts";

export type ContinuationState = {
  responseId: string;
  modelKey: string;
  updatedAt: number;
  contextLength?: number;
};

export type ResponsesRequestShapeState = {
  updatedAt: number;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
};

export type RemoteCompactionGateState = {
  consecutiveFailures: number;
  disabled: boolean;
  reason?: string;
};

const continuationBySessionId = new Map<string, ContinuationState>();
const remoteCompactionBySessionId = new Map<string, RemoteCompactionSessionState>();
const requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();

/**
 * Remote-compaction eligibility is tracked per model key rather than per
 * session: a backend whose compaction endpoint just proved unusable stays
 * unusable for later sessions, forks, and tree navigations in this process.
 */
const remoteCompactionGateByModelKey = new Map<string, RemoteCompactionGateState>();

export function getContinuationState(sessionId: string): ContinuationState | undefined {
  return continuationBySessionId.get(sessionId);
}

export function setContinuationState(sessionId: string, state: ContinuationState): void {
  continuationBySessionId.set(sessionId, state);
}

export function clearContinuationState(sessionId: string | undefined): void {
  if (!sessionId) return;
  continuationBySessionId.delete(sessionId);
}

export function getRemoteCompactionState(
  sessionId: string,
): RemoteCompactionSessionState | undefined {
  return remoteCompactionBySessionId.get(sessionId);
}

export function setRemoteCompactionState(
  sessionId: string,
  state: RemoteCompactionSessionState,
): void {
  remoteCompactionBySessionId.set(sessionId, state);
}

export function clearRemoteCompactionState(sessionId: string | undefined): void {
  if (!sessionId) return;
  remoteCompactionBySessionId.delete(sessionId);
}

export function getResponsesRequestShapeState(
  sessionId: string,
): ResponsesRequestShapeState | undefined {
  return requestShapeBySessionId.get(sessionId);
}

export function setResponsesRequestShapeState(
  sessionId: string,
  state: ResponsesRequestShapeState,
): void {
  requestShapeBySessionId.set(sessionId, state);
}

export function clearResponsesRequestShapeState(sessionId: string | undefined): void {
  if (!sessionId) return;
  requestShapeBySessionId.delete(sessionId);
}

export function getRemoteCompactionGate(modelKey: string): RemoteCompactionGateState | undefined {
  return remoteCompactionGateByModelKey.get(modelKey);
}

export function isRemoteCompactionAllowed(modelKey: string): boolean {
  return remoteCompactionGateByModelKey.get(modelKey)?.disabled !== true;
}

/**
 * Records a failed remote compaction attempt and returns the resulting gate.
 * `routeLevel` failures disable the backend immediately; anything else is
 * tolerated until `REMOTE_COMPACTION_FAILURE_LIMIT` consecutive failures.
 * Returns `justDisabled` so callers can notify exactly once.
 */
export function recordRemoteCompactionFailure(params: {
  modelKey: string;
  routeLevel: boolean;
  reason: string;
}): RemoteCompactionGateState & { justDisabled: boolean } {
  const previous = remoteCompactionGateByModelKey.get(params.modelKey);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const disabled =
    previous?.disabled === true ||
    params.routeLevel ||
    consecutiveFailures >= REMOTE_COMPACTION_FAILURE_LIMIT;
  const next: RemoteCompactionGateState = {
    consecutiveFailures,
    disabled,
    ...(disabled ? { reason: previous?.reason ?? params.reason } : {}),
  };
  remoteCompactionGateByModelKey.set(params.modelKey, next);
  return { ...next, justDisabled: disabled && previous?.disabled !== true };
}

export function recordRemoteCompactionSuccess(modelKey: string): void {
  remoteCompactionGateByModelKey.delete(modelKey);
}

export function clearRemoteCompactionGates(): void {
  remoteCompactionGateByModelKey.clear();
}

export function clearAllContinuationState(): void {
  continuationBySessionId.clear();
  remoteCompactionBySessionId.clear();
  requestShapeBySessionId.clear();
}
