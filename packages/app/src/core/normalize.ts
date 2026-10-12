import { eventId } from "./ids.js";
import { filterPayload } from "./privacy.js";
import type {
  HookRawPayload,
  MeasurementQuality,
  TokenUsage,
  TraceEvent,
  UsageScope,
  UsageSource,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const TOOL_EVENT_FAMILY: Record<string, string> = {
  preToolUse: "tool_pre",
  beforeShellExecution: "tool_pre",
  beforeMCPExecution: "tool_pre",
  beforeReadFile: "tool_pre",
  postToolUse: "tool_post",
  afterShellExecution: "tool_post",
  afterMCPExecution: "tool_post",
  afterFileEdit: "tool_post",
  postToolUseFailure: "tool_fail",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractUsage(payload: HookRawPayload): {
  usage: TokenUsage | null;
  usageScope: UsageScope | null;
  usageSource: UsageSource;
  measurementQuality: MeasurementQuality;
} {
  const eventName = str(payload.hook_event_name);

  // Only treat stop as authoritative turn usage (never afterAgentResponse for aggregation)
  if (eventName === "stop") {
    const input = num(payload.input_tokens);
    const output = num(payload.output_tokens);
    const cacheRead = num(payload.cache_read_tokens);
    const cacheWrite = num(payload.cache_write_tokens);
    if (input == null && output == null && cacheRead == null && cacheWrite == null) {
      return {
        usage: null,
        usageScope: "turn",
        usageSource: "missing",
        measurementQuality: "missing",
      };
    }
    return {
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      },
      usageScope: "turn",
      usageSource: "platform",
      measurementQuality: "exact",
    };
  }

  if (eventName === "afterAgentResponse") {
    // Record presence for diagnostics but mark as duplicate-of-turn (not for summing)
    const input = num(payload.input_tokens);
    const output = num(payload.output_tokens);
    if (input == null && output == null) {
      return {
        usage: null,
        usageScope: null,
        usageSource: "missing",
        measurementQuality: "missing",
      };
    }
    return {
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: num(payload.cache_read_tokens),
        cacheWriteTokens: num(payload.cache_write_tokens),
      },
      usageScope: "turn",
      usageSource: "platform",
      measurementQuality: "partial", // duplicate of stop; do not sum
    };
  }

  if (eventName === "preCompact") {
    return {
      usage: null,
      usageScope: null,
      usageSource: "missing",
      measurementQuality: "missing",
    };
  }

  return {
    usage: null,
    usageScope: null,
    usageSource: "missing",
    measurementQuality: "missing",
  };
}

function durationMs(payload: HookRawPayload): number | null {
  const d = num(payload.duration);
  if (d != null) return d;
  return num(payload.duration_ms);
}

function toolName(payload: HookRawPayload): string | null {
  return (
    str(payload.tool_name) ??
    str(payload.command) ??
    (str(payload.subagent_type) ? `Task:${payload.subagent_type}` : null)
  );
}

function statusOf(payload: HookRawPayload): string | null {
  return (
    str(payload.status) ??
    str(payload.failure_type) ??
    str(payload.reason) ??
    str(payload.final_status)
  );
}

export function buildDedupeKey(payload: HookRawPayload): string | null {
  const eventName = str(payload.hook_event_name) ?? "unknown";
  const family = TOOL_EVENT_FAMILY[eventName] ?? eventName;
  const session = str(payload.conversation_id) ?? str(payload.session_id) ?? "";
  const toolId =
    str(payload.tool_use_id) ??
    str(payload.tool_call_id) ??
    str(payload.subagent_id) ??
    "";
  const turn = str(payload.generation_id) ?? "";
  if (!session && !toolId && !turn) return null;
  return `${session}|${turn}|${family}|${toolId}|${eventName === "stop" || eventName === "afterAgentResponse" ? eventName : family}`;
}

export function normalizeEvent(
  payload: HookRawPayload,
  opts: { captureDetail: boolean; receivedAt?: string },
): TraceEvent {
  const receivedAt = opts.receivedAt ?? new Date().toISOString();
  const { safe, detail, strippedKeys } = filterPayload(payload, {
    captureDetail: opts.captureDetail,
  });
  const usageInfo = extractUsage(payload);
  const eventType = str(payload.hook_event_name) ?? "unknown";

  const sessionId = str(payload.conversation_id) ?? str(payload.session_id);
  const parentAgentId = str(payload.parent_conversation_id);
  const agentId =
    str(payload.subagent_id) ??
    (parentAgentId ? sessionId : sessionId);

  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: eventId(),
    sessionId,
    turnId: str(payload.generation_id),
    agentId,
    parentAgentId,
    toolCallId: str(payload.tool_use_id) ?? str(payload.tool_call_id),
    eventType,
    eventTime: null, // Cursor hooks do not provide event timestamps today
    receivedAt,
    model: str(payload.model) ?? str(payload.model_id) ?? str(payload.subagent_model),
    toolName: toolName(payload),
    status: statusOf(payload),
    durationMs: durationMs(payload),
    usage: usageInfo.usage,
    usageScope: usageInfo.usageScope,
    usageSource: usageInfo.usageSource,
    measurementQuality: usageInfo.measurementQuality,
    dedupeKey: buildDedupeKey(payload),
    rawSummary: {
      ...safe,
      _strippedKeys: strippedKeys,
      cursor_version: str(payload.cursor_version),
      transcript_path_present: Boolean(str(payload.transcript_path)),
      workspace_roots_count: Array.isArray(payload.workspace_roots)
        ? payload.workspace_roots.length
        : 0,
      context_tokens: num(payload.context_tokens),
      context_usage_percent: num(payload.context_usage_percent),
      context_window_size: num(payload.context_window_size),
    },
    detail,
  };
}

export function eventFamily(eventType: string): string {
  return TOOL_EVENT_FAMILY[eventType] ?? eventType;
}

/** Prefer the more complete of two duplicate tool events. */
export function preferEvent(a: TraceEvent, b: TraceEvent): TraceEvent {
  const score = (e: TraceEvent) => {
    let s = 0;
    if (e.durationMs != null) s += 2;
    if (e.toolName) s += 1;
    if (e.status) s += 1;
    if (e.rawSummary.tool_output_present || e.rawSummary.output_present) s += 2;
    if (e.eventType.startsWith("after") || e.eventType.startsWith("post")) s += 1;
    return s;
  };
  return score(a) >= score(b) ? a : b;
}
