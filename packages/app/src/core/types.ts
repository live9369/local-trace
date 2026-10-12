export const SCHEMA_VERSION = 1 as const;
export const PLUGIN_ID = "cursor-local-trace";
export const UNCATEGORIZED_CASE_ID = "case_uncategorized";

/** Freeform run label kept for storage/compat; UI no longer treats special values. */
export type Variant = string;
export type RunStatus =
  | "awaiting_session"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";
export type EvalStatus = "pass" | "fail" | "unevaluated";
export type UsageScope = "request" | "turn" | "session" | "unknown";
export type UsageSource = "platform" | "estimated" | "missing";
export type MeasurementQuality = "exact" | "partial" | "unknown" | "missing";
export type VersionStatus = "draft" | "frozen";

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface TraceEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  eventId: string;
  sessionId: string | null;
  turnId: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  toolCallId: string | null;
  eventType: string;
  eventTime: string | null;
  receivedAt: string;
  model: string | null;
  toolName: string | null;
  status: string | null;
  durationMs: number | null;
  usage: TokenUsage | null;
  usageScope: UsageScope | null;
  usageSource: UsageSource;
  measurementQuality: MeasurementQuality;
  dedupeKey: string | null;
  rawSummary: Record<string, unknown>;
  /** Present only when detailed capture is enabled */
  detail?: Record<string, unknown>;
}

export interface CaseRecord {
  caseId: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  system?: boolean;
}

export interface VersionRecord {
  versionId: string;
  caseId: string;
  versionNumber: number;
  versionLabel: string;
  parentVersionId: string | null;
  status: VersionStatus;
  acceptanceCriteria: string;
  changeNote: string;
  contentHash: string;
  createdAt: string;
  frozenAt: string | null;
}

export interface RunConfigSnapshot {
  model: string | null;
  modelId: string | null;
  modelParams: Array<{ id: string; value: string }> | null;
  variant: Variant;
  skills: string[] | "unknown";
  gitCommit: string | null;
  gitDirty: boolean | null;
  source: "hook" | "manual" | "mixed";
}

export interface RunRecord {
  runId: string;
  caseId: string;
  versionId: string;
  variant: Variant;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  sessionId: string | null;
  conversationIds: string[];
  config: RunConfigSnapshot;
  evaluation: EvalStatus;
  notes: string;
  tags: string[];
  measurementCapabilities: string[];
  missingFields: string[];
  reassignmentHistory: Array<{
    at: string;
    fromCaseId: string;
    toCaseId: string;
    fromVersionId: string;
    toVersionId: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface TraceConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  projectRoot: string;
  createdAt: string;
  captureDetail: boolean;
  retentionDays: number | null;
  serverPort: number;
  locale: "zh-CN";
}

export interface RunSummary {
  runId: string;
  wallClockMs: number | null;
  toolCallCount: number;
  failureCount: number;
  turnCount: number;
  usage: TokenUsage | null;
  usageScope: UsageScope | null;
  usageSource: UsageSource;
  measurementQuality: MeasurementQuality;
  toolDurationSumMs: number;
  parallelAwareNote: string;
  rebuiltAt: string;
}

export type HookRawPayload = Record<string, unknown>;
