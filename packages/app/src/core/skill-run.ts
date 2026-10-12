import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSummary,
  writeSummary,
} from "./aggregate.js";
import { bindSessionToRun } from "./bind.js";
import { CaseStore } from "./cases.js";
import { ensureDir, readJson, removePath, writeJsonAtomic } from "./fsutil.js";
import { openIndex } from "./index-db.js";
import {
  activeSkillRunPath,
  lastSessionPath,
  logsDir,
  runtimeDir,
} from "./paths.js";
import { initProject, loadConfig } from "./project.js";
import type { RunRecord } from "./types.js";

export interface LastSession {
  sessionId: string;
  updatedAt: string;
  turnId?: string | null;
}

export interface ActiveSkillRun {
  runId: string;
  caseId: string;
  versionId: string;
  sessionId: string | null;
  startedAt: string;
  source: "skill";
  name: string;
}

export function rememberSession(
  projectRoot: string,
  sessionId: string,
  turnId?: string | null,
): void {
  ensureDir(runtimeDir(projectRoot));
  writeJsonAtomic(lastSessionPath(projectRoot), {
    sessionId,
    turnId: turnId ?? null,
    updatedAt: new Date().toISOString(),
  } satisfies LastSession);
}

export function readLastSession(projectRoot: string): LastSession | null {
  return readJson<LastSession>(lastSessionPath(projectRoot));
}

/** Infer session from last-session file, recent hook log, or transcript path env. */
export function detectSessionId(projectRoot: string): string | null {
  const last = readLastSession(projectRoot);
  if (last?.sessionId) return last.sessionId;

  const recent = join(logsDir(projectRoot), "hook-recent.jsonl");
  if (existsSync(recent)) {
    const lines = readFileSync(recent, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]!) as { sessionId?: string | null };
        if (row.sessionId) return row.sessionId;
      } catch {
        // skip
      }
    }
  }

  const tp =
    process.env.CURSOR_TRANSCRIPT_PATH || process.env.CURSOR_AGENT_TRANSCRIPT_PATH;
  if (tp) {
    // .../agent-transcripts/<conversation_id>/...
    const m = tp.match(/agent-transcripts[/\\]([^/\\]+)/);
    if (m?.[1]) return m[1];
  }

  return null;
}

export function readActiveSkillRun(
  projectRoot: string,
): ActiveSkillRun | null {
  return readJson<ActiveSkillRun>(activeSkillRunPath(projectRoot));
}

function dashboardBase(projectRoot: string): string {
  const cfg = loadConfig(projectRoot);
  const port = cfg?.serverPort ?? 7437;
  const runtime = readJson<{ url?: string; port?: number }>(
    join(runtimeDir(projectRoot), "server.json"),
  );
  if (runtime?.url) return runtime.url.replace(/\/$/, "");
  return `http://127.0.0.1:${runtime?.port ?? port}`;
}

export function runDetailUrl(
  projectRoot: string,
  caseId: string,
  runId: string,
): string {
  return `${dashboardBase(projectRoot)}/#/cases/${encodeURIComponent(caseId)}/runs/${encodeURIComponent(runId)}`;
}

export interface BeginSkillRunInput {
  projectRoot: string;
  name?: string;
  prompt?: string;
  caseId?: string;
  versionId?: string;
  sessionId?: string | null;
}

export interface BeginSkillRunResult {
  run: RunRecord;
  caseId: string;
  versionId: string;
  sessionId: string | null;
  url: string;
  bound: boolean;
  message: string;
}

export function beginSkillRun(input: BeginSkillRunInput): BeginSkillRunResult {
  const projectRoot = input.projectRoot;
  initProject(projectRoot);
  const store = new CaseStore(projectRoot);
  const name =
    input.name?.trim() ||
    `Skill Trace ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  let caseId = input.caseId;
  let versionId = input.versionId;

  if (!caseId) {
    const c = store.createCase({
      name,
      description: "由 local-trace skill 创建",
      tags: ["skill"],
    });
    caseId = c.caseId;
  }

  if (!versionId) {
    const prompt =
      input.prompt?.trim() ||
      `（Skill 触发观测）\n任务：${name}\n\n未单独保存案例提示词时，以实际会话为准；看板会标注未验证一致性。`;
    const v = store.createVersion({
      caseId,
      prompt,
      acceptanceCriteria: "",
      changeNote: "skill begin",
    });
    versionId = v.versionId;
  }

  // End previous active skill run if still open
  const prev = readActiveSkillRun(projectRoot);
  if (prev) {
    try {
      const old = store.getRun(prev.runId);
      if (old && (old.status === "running" || old.status === "awaiting_session")) {
        store.updateRunMeta(old.runId, { status: "interrupted" });
      }
    } catch {
      // ignore
    }
  }

  const run = store.prepareRun({
    caseId,
    versionId,
    notes: "skill-triggered",
    tags: ["skill"],
    config: {
      source: "manual",
      skills: ["local-trace"],
    },
  });

  const sessionId = input.sessionId || detectSessionId(projectRoot);
  let bound = false;
  let live = run;

  if (sessionId) {
    live = bindSessionToRun(projectRoot, sessionId, run.runId);
    bound = true;
  }

  const active: ActiveSkillRun = {
    runId: live.runId,
    caseId,
    versionId,
    sessionId: sessionId,
    startedAt: new Date().toISOString(),
    source: "skill",
    name,
  };
  writeJsonAtomic(activeSkillRunPath(projectRoot), active);

  const url = runDetailUrl(projectRoot, caseId, live.runId);
  return {
    run: live,
    caseId,
    versionId,
    sessionId,
    url,
    bound,
    message: bound
      ? `已绑定当前会话并开始采集 → ${url}`
      : `尚未检测到 sessionId；已进入 awaiting，下一会话将自动绑定 → ${url}`,
  };
}

export interface EndSkillRunResult {
  run: RunRecord | null;
  url: string | null;
  summary: ReturnType<typeof buildSummary> | null;
  message: string;
}

export function endSkillRun(projectRoot: string): EndSkillRunResult {
  initProject(projectRoot);
  const active = readActiveSkillRun(projectRoot);
  if (!active) {
    return {
      run: null,
      url: null,
      summary: null,
      message: "没有进行中的 skill 运行（.trace/runtime/active-skill-run.json 不存在）",
    };
  }

  const store = new CaseStore(projectRoot);
  const run = store.updateRunMeta(active.runId, { status: "completed" });

  const idx = openIndex(projectRoot);
  let summary = null;
  try {
    const events = idx.listEvents(active.runId);
    summary = buildSummary(
      active.runId,
      events,
      run.startedAt,
      run.endedAt,
    );
    const path = store.runPath(run);
    if (path) writeSummary(`${path}/summary.json`, summary);
  } finally {
    idx.close();
  }

  removePath(activeSkillRunPath(projectRoot));
  const url = runDetailUrl(projectRoot, active.caseId, active.runId);

  return {
    run,
    url,
    summary,
    message: `Skill 运行已结束 → ${url}`,
  };
}

export function skillRunStatus(projectRoot: string): {
  active: ActiveSkillRun | null;
  run: RunRecord | null;
  url: string | null;
  lastSession: LastSession | null;
} {
  initProject(projectRoot);
  const active = readActiveSkillRun(projectRoot);
  const store = new CaseStore(projectRoot);
  const run = active ? store.getRun(active.runId) : null;
  return {
    active,
    run,
    url: active
      ? runDetailUrl(projectRoot, active.caseId, active.runId)
      : null,
    lastSession: readLastSession(projectRoot),
  };
}
