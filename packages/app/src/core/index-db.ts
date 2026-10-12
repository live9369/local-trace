import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./fsutil.js";
import { dirname } from "node:path";
import { indexDbPath } from "./paths.js";
import type {
  CaseRecord,
  RunRecord,
  TraceEvent,
  VersionRecord,
} from "./types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  version_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  version_label TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL,
  UNIQUE(case_id, version_number)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  evaluation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  event_type TEXT NOT NULL,
  dedupe_key TEXT,
  received_at TEXT NOT NULL,
  tool_name TEXT,
  duration_ms REAL,
  usage_json TEXT,
  usage_scope TEXT,
  usage_source TEXT,
  measurement_quality TEXT,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deleted_ids (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
  ON events(run_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_case_version ON runs(case_id, version_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, received_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
`;

export class TraceIndex {
  private db: DatabaseSync;

  constructor(private projectRoot: string) {
    const path = indexDbPath(projectRoot);
    ensureDir(dirname(path));
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1')",
      )
      .run();
  }

  close(): void {
    this.db.close();
  }

  isDeleted(id: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM deleted_ids WHERE id = ?")
      .get(id) as { ok: number } | undefined;
    return Boolean(row);
  }

  markDeleted(id: string, kind: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO deleted_ids(id, kind, deleted_at) VALUES(?, ?, ?)",
      )
      .run(id, kind, new Date().toISOString());
  }

  upsertCase(c: CaseRecord): void {
    if (this.isDeleted(c.caseId)) return;
    this.db
      .prepare(
        `INSERT INTO cases(case_id, name, archived, updated_at, json)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET
           name=excluded.name, archived=excluded.archived,
           updated_at=excluded.updated_at, json=excluded.json`,
      )
      .run(
        c.caseId,
        c.name,
        c.archived ? 1 : 0,
        c.updatedAt,
        JSON.stringify(c),
      );
  }

  upsertVersion(v: VersionRecord): void {
    if (this.isDeleted(v.versionId)) return;
    this.db
      .prepare(
        `INSERT INTO versions(version_id, case_id, version_number, version_label, status, content_hash, created_at, json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(version_id) DO UPDATE SET
           status=excluded.status, content_hash=excluded.content_hash, json=excluded.json`,
      )
      .run(
        v.versionId,
        v.caseId,
        v.versionNumber,
        v.versionLabel,
        v.status,
        v.contentHash,
        v.createdAt,
        JSON.stringify(v),
      );
  }

  upsertRun(r: RunRecord): void {
    if (this.isDeleted(r.runId)) return;
    this.db
      .prepare(
        `INSERT INTO runs(run_id, case_id, version_id, variant, status, session_id, started_at, ended_at, evaluation, updated_at, json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           case_id=excluded.case_id, version_id=excluded.version_id,
           variant=excluded.variant, status=excluded.status,
           session_id=excluded.session_id, started_at=excluded.started_at,
           ended_at=excluded.ended_at, evaluation=excluded.evaluation,
           updated_at=excluded.updated_at, json=excluded.json`,
      )
      .run(
        r.runId,
        r.caseId,
        r.versionId,
        r.variant,
        r.status,
        r.sessionId,
        r.startedAt,
        r.endedAt,
        r.evaluation,
        r.updatedAt,
        JSON.stringify(r),
      );
  }

  /** Insert event; returns false if dedupe hit or deleted run. */
  insertEvent(runId: string, e: TraceEvent): boolean {
    if (this.isDeleted(runId) || this.isDeleted(e.eventId)) return false;
    if (e.dedupeKey) {
      const existing = this.db
        .prepare(
          "SELECT event_id FROM events WHERE run_id = ? AND dedupe_key = ?",
        )
        .get(runId, e.dedupeKey) as { event_id: string } | undefined;
      if (existing) return false;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO events(
            event_id, run_id, session_id, turn_id, event_type, dedupe_key,
            received_at, tool_name, duration_ms, usage_json, usage_scope,
            usage_source, measurement_quality, json
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          e.eventId,
          runId,
          e.sessionId,
          e.turnId,
          e.eventType,
          e.dedupeKey,
          e.receivedAt,
          e.toolName,
          e.durationMs,
          e.usage ? JSON.stringify(e.usage) : null,
          e.usageScope,
          e.usageSource,
          e.measurementQuality,
          JSON.stringify(e),
        );
      return true;
    } catch {
      return false;
    }
  }

  listCases(includeArchived = false): CaseRecord[] {
    const rows = this.db
      .prepare(
        includeArchived
          ? "SELECT json FROM cases ORDER BY updated_at DESC"
          : "SELECT json FROM cases WHERE archived = 0 ORDER BY updated_at DESC",
      )
      .all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as CaseRecord);
  }

  getCase(caseId: string): CaseRecord | null {
    const row = this.db
      .prepare("SELECT json FROM cases WHERE case_id = ?")
      .get(caseId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CaseRecord) : null;
  }

  listVersions(caseId: string): VersionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT json FROM versions WHERE case_id = ? ORDER BY version_number ASC",
      )
      .all(caseId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as VersionRecord);
  }

  getVersion(versionId: string): VersionRecord | null {
    const row = this.db
      .prepare("SELECT json FROM versions WHERE version_id = ?")
      .get(versionId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as VersionRecord) : null;
  }

  listRuns(caseId: string, versionId?: string): RunRecord[] {
    const rows = (
      versionId
        ? this.db
            .prepare(
              "SELECT json FROM runs WHERE case_id = ? AND version_id = ? ORDER BY updated_at DESC",
            )
            .all(caseId, versionId)
        : this.db
            .prepare(
              "SELECT json FROM runs WHERE case_id = ? ORDER BY updated_at DESC",
            )
            .all(caseId)
    ) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as RunRecord);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT json FROM runs WHERE run_id = ?")
      .get(runId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as RunRecord) : null;
  }

  findRunBySession(sessionId: string): RunRecord | null {
    const row = this.db
      .prepare(
        "SELECT json FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(sessionId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as RunRecord) : null;
  }

  listAwaitingRuns(): RunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT json FROM runs WHERE status = 'awaiting_session' ORDER BY updated_at ASC",
      )
      .all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as RunRecord);
  }

  listEvents(runId: string): TraceEvent[] {
    const rows = this.db
      .prepare(
        "SELECT json FROM events WHERE run_id = ? ORDER BY received_at ASC",
      )
      .all(runId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as TraceEvent);
  }

  caseStats(caseId: string): {
    versionCount: number;
    runCount: number;
    lastRunAt: string | null;
    lastStatus: string | null;
  } {
    const v = this.db
      .prepare("SELECT COUNT(*) AS c FROM versions WHERE case_id = ?")
      .get(caseId) as { c: number };
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM runs WHERE case_id = ?")
      .get(caseId) as { c: number };
    const last = this.db
      .prepare(
        "SELECT status, updated_at FROM runs WHERE case_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(caseId) as { status: string; updated_at: string } | undefined;
    return {
      versionCount: v.c,
      runCount: r.c,
      lastRunAt: last?.updated_at ?? null,
      lastStatus: last?.status ?? null,
    };
  }

  clearAll(): void {
    this.db.exec(
      "DELETE FROM events; DELETE FROM runs; DELETE FROM versions; DELETE FROM cases;",
    );
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function openIndex(projectRoot: string): TraceIndex {
  return new TraceIndex(projectRoot);
}
