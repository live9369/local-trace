import { CaseStore } from "./cases.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { openIndex } from "./index-db.js";
import { sessionMapPath } from "./paths.js";
import type { RunRecord, VersionRecord } from "./types.js";
import { UNCATEGORIZED_CASE_ID } from "./types.js";

export type BindDecision =
  | { action: "bind"; run: RunRecord }
  | { action: "uncategorized"; run: RunRecord }
  | { action: "existing"; run: RunRecord }
  | { action: "skip"; reason: string };

function now(): string {
  return new Date().toISOString();
}

interface SessionMap {
  sessions: Record<
    string,
    { runId: string; caseId: string; boundAt: string }
  >;
}

function loadSessionMap(projectRoot: string): SessionMap {
  return readJson<SessionMap>(sessionMapPath(projectRoot)) ?? { sessions: {} };
}

function saveSessionMap(projectRoot: string, map: SessionMap): void {
  writeJsonAtomic(sessionMapPath(projectRoot), map);
}

export function ensureUncategorizedVersion(store: CaseStore): VersionRecord {
  const versions = store.listVersions(UNCATEGORIZED_CASE_ID);
  if (versions.length > 0) return versions[versions.length - 1]!;
  return store.createVersion({
    caseId: UNCATEGORIZED_CASE_ID,
    prompt: "（未分类会话 — 无用户保存的案例提示词）",
    acceptanceCriteria: "",
    changeNote: "系统自动创建",
  });
}

/**
 * Resolve which run should receive events for a session.
 * Session map is authoritative (skill rebind). Auto-bind only when
 * exactly one awaiting run exists.
 */
export function resolveRunForSession(
  projectRoot: string,
  sessionId: string,
  opts?: { createUncategorized?: boolean },
): BindDecision {
  const store = new CaseStore(projectRoot);
  const idx = openIndex(projectRoot);
  try {
    const map = loadSessionMap(projectRoot);
    if (map.sessions[sessionId]) {
      const run = idx.getRun(map.sessions[sessionId]!.runId);
      if (run) return { action: "existing", run };
    }

    const existing = idx.findRunBySession(sessionId);
    if (
      existing &&
      (existing.status === "running" || existing.status === "awaiting_session")
    ) {
      return { action: "existing", run: existing };
    }

    const awaiting = idx.listAwaitingRuns();
    if (awaiting.length === 1) {
      const run = awaiting[0]!;
      return {
        action: "bind",
        run: attachSession(store, projectRoot, run, sessionId, map),
      };
    }

    if (awaiting.length > 1 && opts?.createUncategorized === false) {
      return { action: "skip", reason: "multiple_awaiting_runs" };
    }

    if (opts?.createUncategorized === false) {
      return { action: "skip", reason: "no_awaiting_run" };
    }

    const ver = ensureUncategorizedVersion(store);
    const run = store.prepareRun({
      caseId: UNCATEGORIZED_CASE_ID,
      versionId: ver.versionId,
      notes: "自动归入未分类",
      tags: ["uncategorized"],
    });
    return {
      action: "uncategorized",
      run: attachSession(store, projectRoot, run, sessionId, map),
    };
  } finally {
    idx.close();
  }
}

function attachSession(
  store: CaseStore,
  projectRoot: string,
  run: RunRecord,
  sessionId: string,
  map: SessionMap,
): RunRecord {
  run.sessionId = sessionId;
  run.status = "running";
  run.startedAt = run.startedAt ?? now();
  if (!run.conversationIds.includes(sessionId)) {
    run.conversationIds.push(sessionId);
  }
  store.saveRun(run);
  map.sessions[sessionId] = {
    runId: run.runId,
    caseId: run.caseId,
    boundAt: now(),
  };
  saveSessionMap(projectRoot, map);
  return run;
}

/** Detach session from other runs, then bind to target (skill rebind). */
export function bindSessionToRun(
  projectRoot: string,
  sessionId: string,
  runId: string,
): RunRecord {
  const store = new CaseStore(projectRoot);
  const run = store.getRun(runId);
  if (!run) throw new Error("运行不存在");

  const idx = openIndex(projectRoot);
  try {
    for (let i = 0; i < 8; i++) {
      const other = idx.findRunBySession(sessionId);
      if (!other || other.runId === runId) break;
      if (other.status === "running" || other.status === "awaiting_session") {
        other.status = "interrupted";
        other.endedAt = other.endedAt ?? now();
      }
      other.sessionId = null;
      store.saveRun(other);
    }
  } finally {
    idx.close();
  }

  const map = loadSessionMap(projectRoot);
  return attachSession(store, projectRoot, run, sessionId, map);
}
