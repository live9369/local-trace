import { appendJsonl, ensureDir, writeJsonAtomic } from "./fsutil.js";
import { writerId } from "./ids.js";
import { openIndex } from "./index-db.js";
import { normalizeEvent } from "./normalize.js";
import { logsDir } from "./paths.js";
import {
  initProject,
  loadConfig,
  resolveProjectRoot,
  writeDiagnostic,
} from "./project.js";
import { resolveRunForSession } from "./bind.js";
import { CaseStore } from "./cases.js";
import { buildSummary, writeSummary } from "./aggregate.js";
import { rememberSession } from "./skill-run.js";
import type { HookRawPayload, TraceEvent } from "./types.js";

const WRITER_ID = writerId();

export interface IngestResult {
  ok: boolean;
  persisted: boolean;
  runId?: string;
  projectRoot?: string;
  reason?: string;
  event?: TraceEvent;
}

function sessionFromPayload(payload: HookRawPayload): string | null {
  const a = payload.conversation_id;
  const b = payload.session_id;
  if (typeof a === "string" && a) return a;
  if (typeof b === "string" && b) return b;
  return null;
}

export function ingestHookPayload(payload: HookRawPayload): IngestResult {
  const resolved = resolveProjectRoot({
    workspaceRoots: payload.workspace_roots,
    cursorProjectDir: process.env.CURSOR_PROJECT_DIR ?? null,
  });

  if (!resolved.projectRoot) {
    writeDiagnostic({
      type: "project_resolve_failed",
      reason: resolved.reason,
      candidates: resolved.candidates,
      hook: payload.hook_event_name,
    });
    return {
      ok: true,
      persisted: false,
      reason: resolved.reason,
    };
  }

  const projectRoot = resolved.projectRoot;
  let config = loadConfig(projectRoot);
  if (!config) config = initProject(projectRoot);

  const event = normalizeEvent(payload, {
    captureDetail: config.captureDetail,
  });

  const sessionId = sessionFromPayload(payload);
  const eventName =
    typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : "unknown";

  if (sessionId) {
    try {
      rememberSession(projectRoot, sessionId, event.turnId);
    } catch {
      // ignore
    }
  }

  // Probe log (lightweight, always)
  try {
    ensureDir(logsDir(projectRoot));
    appendJsonl(`${logsDir(projectRoot)}/hook-recent.jsonl`, {
      at: event.receivedAt,
      eventType: event.eventType,
      sessionId,
      turnId: event.turnId,
      hasUsage: event.usage != null,
      usageSource: event.usageSource,
    });
  } catch {
    // ignore
  }

  if (!sessionId && eventName !== "workspaceOpen") {
    writeDiagnostic({
      type: "missing_session",
      hook: eventName,
      projectRoot,
    });
    return { ok: true, persisted: false, reason: "missing_session", projectRoot };
  }

  let runId: string | undefined;

  if (sessionId) {
    const decision = resolveRunForSession(projectRoot, sessionId);
    if (decision.action === "skip") {
      writeDiagnostic({
        type: "bind_skip",
        reason: decision.reason,
        sessionId,
        projectRoot,
      });
      // Still try to attach if we later get an explicit bind — for now drop
      return {
        ok: true,
        persisted: false,
        reason: decision.reason,
        projectRoot,
      };
    }
    runId = decision.run.runId;

    // Update config snapshot from hooks when unknown
    if (
      decision.run.config.model == null &&
      typeof payload.model === "string"
    ) {
      const store = new CaseStore(projectRoot);
      const run = store.getRun(runId);
      if (run) {
        run.config.model = payload.model as string;
        run.config.modelId =
          typeof payload.model_id === "string" ? payload.model_id : run.config.modelId;
        run.config.modelParams = Array.isArray(payload.model_params)
          ? (payload.model_params as Array<{ id: string; value: string }>)
          : run.config.modelParams;
        run.config.source =
          run.config.source === "manual" ? "mixed" : run.config.source;
        store.saveRun(run);
      }
    }

    if (eventName === "sessionEnd") {
      const store = new CaseStore(projectRoot);
      const run = store.getRun(runId);
      if (run && run.status === "running") {
        const reason =
          typeof payload.reason === "string" ? payload.reason : "completed";
        run.status =
          reason === "error"
            ? "failed"
            : reason === "aborted" || reason === "user_close"
              ? "interrupted"
              : "completed";
        run.endedAt = new Date().toISOString();
        store.saveRun(run);
      }
    }
  }

  if (!runId) {
    return { ok: true, persisted: false, reason: "no_run", projectRoot };
  }

  const store = new CaseStore(projectRoot);
  const run = store.getRun(runId);
  if (!run) {
    return { ok: true, persisted: false, reason: "run_missing", projectRoot };
  }
  const runPath = store.runPath(run);
  if (!runPath) {
    return { ok: true, persisted: false, reason: "run_path_missing", projectRoot };
  }

  ensureDir(`${runPath}/events`);
  const shard = `${runPath}/events/${WRITER_ID}.jsonl`;
  appendJsonl(shard, event);

  const idx = openIndex(projectRoot);
  try {
    const inserted = idx.insertEvent(runId, event);
    if (!inserted && event.dedupeKey) {
      // duplicate — already on disk from another writer? still ok
    }

    // Track capabilities
    const caps = new Set(run.measurementCapabilities);
    const missing = new Set(run.missingFields);
    if (event.usageSource === "platform" && event.usage) {
      caps.add("turn_tokens_platform");
      missing.delete("turn_tokens");
    } else if (event.eventType === "stop") {
      missing.add("turn_tokens");
    }
    if (event.durationMs != null) caps.add("tool_duration_ms");
    if (event.rawSummary.transcript_path_present) caps.add("transcript_path");
    run.measurementCapabilities = [...caps];
    run.missingFields = [...missing];
    store.saveRun(run);

    // Lightweight summary refresh on stop/sessionEnd only
    if (event.eventType === "stop" || event.eventType === "sessionEnd") {
      const events = idx.listEvents(runId);
      const summary = buildSummary(
        runId,
        events,
        run.startedAt,
        run.endedAt,
      );
      writeSummary(`${runPath}/summary.json`, summary);
    }
  } finally {
    idx.close();
  }

  return {
    ok: true,
    persisted: true,
    runId,
    projectRoot,
    event,
  };
}

/** Hook stdout response: never modify agent behavior. */
export function hookResponseFor(payload: HookRawPayload): Record<string, unknown> {
  const name =
    typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : "";

  switch (name) {
    case "preToolUse":
    case "beforeShellExecution":
    case "beforeMCPExecution":
    case "beforeReadFile":
    case "beforeTabFileRead":
    case "subagentStart":
      return { permission: "allow" };
    case "beforeSubmitPrompt":
      return { continue: true };
    default:
      return {};
  }
}
