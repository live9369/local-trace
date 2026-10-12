import type {
  RunSummary,
  TokenUsage,
  TraceEvent,
  UsageScope,
  UsageSource,
  MeasurementQuality,
} from "./types.js";
import { writeJsonAtomic } from "./fsutil.js";

export interface TimelineStep {
  id: string;
  turnId: string | null;
  kind: "tool" | "turn_usage" | "thought" | "response" | "session" | "other";
  name: string;
  status: string | null;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  usage: TokenUsage | null;
  usageScope: UsageScope | null;
  usageIsTurnLevel: boolean;
  event: TraceEvent;
  parallelGroup?: string;
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
}

/** Sum only turn-scoped platform usage from stop events (never afterAgentResponse). */
export function aggregateTurnUsage(events: TraceEvent[]): {
  usage: TokenUsage | null;
  usageScope: UsageScope | null;
  usageSource: UsageSource;
  measurementQuality: MeasurementQuality;
} {
  const stops = events.filter(
    (e) =>
      e.eventType === "stop" &&
      e.usageSource === "platform" &&
      e.usage != null,
  );
  if (stops.length === 0) {
    return {
      usage: null,
      usageScope: "turn",
      usageSource: "missing",
      measurementQuality: "missing",
    };
  }

  // Sum across turns in a multi-turn run; each stop is one turn
  const usage = emptyUsage();
  let any = false;
  for (const s of stops) {
    const u = s.usage!;
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ] as const) {
      if (u[key] != null) {
        usage[key] = (usage[key] ?? 0) + u[key]!;
        any = true;
      }
    }
  }
  return {
    usage: any ? usage : null,
    usageScope: "turn",
    usageSource: "platform",
    measurementQuality: "exact",
  };
}

/** Wall-clock from first to last receivedAt; null if incomplete. */
export function wallClockMs(
  events: TraceEvent[],
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (startedAt && endedAt) {
    const a = Date.parse(startedAt);
    const b = Date.parse(endedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
  }
  if (events.length === 0) return null;
  const times = events.map((e) => Date.parse(e.receivedAt)).filter(Number.isFinite);
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

export function buildSummary(
  runId: string,
  events: TraceEvent[],
  startedAt: string | null,
  endedAt: string | null,
): RunSummary {
  const toolEvents = events.filter(
    (e) =>
      e.eventType === "postToolUse" ||
      e.eventType === "afterShellExecution" ||
      e.eventType === "afterMCPExecution" ||
      e.eventType === "postToolUseFailure",
  );
  // Dedupe by toolCallId for counts
  const seenTools = new Set<string>();
  let toolCallCount = 0;
  let failureCount = 0;
  let toolDurationSumMs = 0;
  for (const e of toolEvents) {
    const key = e.toolCallId ?? e.eventId;
    if (seenTools.has(key)) continue;
    seenTools.add(key);
    toolCallCount++;
    if (e.eventType === "postToolUseFailure") failureCount++;
    if (e.durationMs != null) toolDurationSumMs += e.durationMs;
  }

  const turns = new Set(
    events.map((e) => e.turnId).filter((t): t is string => Boolean(t)),
  );
  const usageAgg = aggregateTurnUsage(events);

  return {
    runId,
    wallClockMs: wallClockMs(events, startedAt, endedAt),
    toolCallCount,
    failureCount,
    turnCount: turns.size,
    usage: usageAgg.usage,
    usageScope: usageAgg.usageScope,
    usageSource: usageAgg.usageSource,
    measurementQuality: usageAgg.measurementQuality,
    toolDurationSumMs,
    parallelAwareNote:
      "工具 duration 之和不等于墙钟耗时；并行工具区间会重叠，不可相加推导思考时间。",
    rebuiltAt: new Date().toISOString(),
  };
}

export function buildTimeline(events: TraceEvent[]): TimelineStep[] {
  const t0 = events.length
    ? Math.min(...events.map((e) => Date.parse(e.receivedAt)))
    : Date.now();

  const steps: TimelineStep[] = [];
  const toolStarts = new Map<string, TraceEvent>();

  for (const e of events) {
    const rel = Date.parse(e.receivedAt) - t0;

    if (
      e.eventType === "preToolUse" ||
      e.eventType === "beforeShellExecution" ||
      e.eventType === "beforeMCPExecution"
    ) {
      if (e.toolCallId) toolStarts.set(e.toolCallId, e);
      continue;
    }

    if (
      e.eventType === "postToolUse" ||
      e.eventType === "afterShellExecution" ||
      e.eventType === "afterMCPExecution" ||
      e.eventType === "postToolUseFailure"
    ) {
      const start = e.toolCallId ? toolStarts.get(e.toolCallId) : undefined;
      const startRel = start
        ? Date.parse(start.receivedAt) - t0
        : e.durationMs != null
          ? rel - e.durationMs
          : rel;
      steps.push({
        id: e.eventId,
        turnId: e.turnId,
        kind: "tool",
        name: e.toolName ?? e.eventType,
        status: e.status ?? (e.eventType.includes("Failure") ? "error" : "ok"),
        startMs: startRel,
        endMs: rel,
        durationMs: e.durationMs,
        usage: null,
        usageScope: null,
        usageIsTurnLevel: false,
        event: e,
        parallelGroup: e.turnId ?? undefined,
      });
      continue;
    }

    if (e.eventType === "stop") {
      steps.push({
        id: e.eventId,
        turnId: e.turnId,
        kind: "turn_usage",
        name: "轮次结束 (turn usage)",
        status: e.status,
        startMs: rel,
        endMs: rel,
        durationMs: null,
        usage: e.usage,
        usageScope: e.usageScope,
        usageIsTurnLevel: true,
        event: e,
      });
      continue;
    }

    if (e.eventType === "afterAgentThought") {
      steps.push({
        id: e.eventId,
        turnId: e.turnId,
        kind: "thought",
        name: "思考块",
        status: null,
        startMs: e.durationMs != null ? rel - e.durationMs : rel,
        endMs: rel,
        durationMs: e.durationMs,
        usage: null,
        usageScope: null,
        usageIsTurnLevel: false,
        event: e,
      });
      continue;
    }

    if (e.eventType === "afterAgentResponse") {
      steps.push({
        id: e.eventId,
        turnId: e.turnId,
        kind: "response",
        name: "助手回复",
        status: null,
        startMs: rel,
        endMs: rel,
        durationMs: null,
        // Do NOT attach turn usage as step usage
        usage: null,
        usageScope: null,
        usageIsTurnLevel: false,
        event: e,
      });
      continue;
    }

    steps.push({
      id: e.eventId,
      turnId: e.turnId,
      kind: "other",
      name: e.eventType,
      status: e.status,
      startMs: rel,
      endMs: rel,
      durationMs: e.durationMs,
      usage: null,
      usageScope: null,
      usageIsTurnLevel: false,
      event: e,
    });
  }

  return steps.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
}

export function writeSummary(path: string, summary: RunSummary): void {
  writeJsonAtomic(path, summary);
}
