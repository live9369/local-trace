import {
  ensureDir,
  listDirs,
  listFiles,
  readJson,
  readJsonl,
  readText,
  removePath,
  writeJsonAtomic,
  writeTextAtomic,
} from "./fsutil.js";
import { contentHash } from "./hash.js";
import {
  caseId as newCaseId,
  runId as newRunId,
  versionId,
  versionLabel,
} from "./ids.js";
import { openIndex, type TraceIndex } from "./index-db.js";
import {
  caseJsonPath,
  casesDir,
  runDir,
  versionDir,
  versionsDir,
} from "./paths.js";
import { initProject } from "./project.js";
import type {
  CaseRecord,
  EvalStatus,
  RunConfigSnapshot,
  RunRecord,
  RunStatus,
  TraceEvent,
  Variant,
  VersionRecord,
} from "./types.js";
import { UNCATEGORIZED_CASE_ID } from "./types.js";

function now(): string {
  return new Date().toISOString();
}

export class CaseStore {
  constructor(public projectRoot: string) {
    initProject(projectRoot);
  }

  withIndex<T>(fn: (idx: TraceIndex) => T): T {
    const idx = openIndex(this.projectRoot);
    try {
      return fn(idx);
    } finally {
      idx.close();
    }
  }

  createCase(input: {
    name: string;
    description?: string;
    tags?: string[];
  }): CaseRecord {
    const id = newCaseId();
    const t = now();
    const record: CaseRecord = {
      caseId: id,
      name: input.name,
      description: input.description ?? "",
      archived: false,
      createdAt: t,
      updatedAt: t,
      tags: input.tags ?? [],
    };
    writeJsonAtomic(caseJsonPath(this.projectRoot, id), record);
    this.withIndex((idx) => idx.upsertCase(record));
    return record;
  }

  updateCase(
    caseId: string,
    patch: Partial<
      Pick<CaseRecord, "name" | "description" | "archived" | "tags">
    >,
  ): CaseRecord {
    const existing = this.getCase(caseId);
    if (!existing) throw new Error(`案例不存在: ${caseId}`);
    const updated: CaseRecord = {
      ...existing,
      ...patch,
      caseId: existing.caseId,
      createdAt: existing.createdAt,
      updatedAt: now(),
    };
    writeJsonAtomic(caseJsonPath(this.projectRoot, caseId), updated);
    this.withIndex((idx) => idx.upsertCase(updated));
    return updated;
  }

  getCase(caseId: string): CaseRecord | null {
    return readJson<CaseRecord>(caseJsonPath(this.projectRoot, caseId));
  }

  listCases(includeArchived = false): CaseRecord[] {
    const ids = listDirs(casesDir(this.projectRoot));
    const out: CaseRecord[] = [];
    for (const id of ids) {
      const c = this.getCase(id);
      if (!c) continue;
      if (!includeArchived && c.archived) continue;
      out.push(c);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  deleteCase(caseId: string): void {
    if (caseId === UNCATEGORIZED_CASE_ID) {
      throw new Error("不能删除系统未分类案例");
    }
    removePath(`${casesDir(this.projectRoot)}/${caseId}`);
    this.withIndex((idx) => idx.markDeleted(caseId, "case"));
    rebuildIndexFor(this.projectRoot);
  }

  createVersion(input: {
    caseId: string;
    prompt: string;
    acceptanceCriteria?: string;
    changeNote?: string;
    parentVersionId?: string | null;
  }): VersionRecord {
    const c = this.getCase(input.caseId);
    if (!c) throw new Error(`案例不存在: ${input.caseId}`);

    const existing = this.listVersions(input.caseId);
    const nextNum =
      existing.length === 0
        ? 1
        : Math.max(...existing.map((v) => v.versionNumber)) + 1;
    const label = versionLabel(nextNum);
    const vid = versionId();
    const prompt = input.prompt;
    const acceptanceCriteria = input.acceptanceCriteria ?? "";
    const record: VersionRecord = {
      versionId: vid,
      caseId: input.caseId,
      versionNumber: nextNum,
      versionLabel: label,
      parentVersionId:
        input.parentVersionId ?? existing.at(-1)?.versionId ?? null,
      status: "draft",
      acceptanceCriteria,
      changeNote: input.changeNote ?? "",
      contentHash: contentHash({ prompt, acceptanceCriteria }),
      createdAt: now(),
      frozenAt: null,
    };

    const dir = versionDir(this.projectRoot, input.caseId, label);
    ensureDir(dir);
    writeJsonAtomic(`${dir}/version.json`, record);
    writeTextAtomic(`${dir}/prompt.md`, prompt);
    ensureDir(`${dir}/runs`);
    this.withIndex((idx) => idx.upsertVersion(record));
    this.touchCase(input.caseId);
    return record;
  }

  getVersion(caseId: string, versionLabelOrId: string): VersionRecord | null {
    const versions = this.listVersions(caseId);
    return (
      versions.find(
        (v) =>
          v.versionLabel === versionLabelOrId ||
          v.versionId === versionLabelOrId,
      ) ?? null
    );
  }

  getPrompt(caseId: string, vLabel: string): string {
    return (
      readText(`${versionDir(this.projectRoot, caseId, vLabel)}/prompt.md`) ??
      ""
    );
  }

  listVersions(caseId: string): VersionRecord[] {
    const labels = listDirs(versionsDir(this.projectRoot, caseId));
    const out: VersionRecord[] = [];
    for (const label of labels) {
      const v = readJson<VersionRecord>(
        `${versionDir(this.projectRoot, caseId, label)}/version.json`,
      );
      if (v) out.push(v);
    }
    return out.sort((a, b) => a.versionNumber - b.versionNumber);
  }

  updateDraftVersion(
    caseId: string,
    versionIdValue: string,
    patch: {
      prompt?: string;
      acceptanceCriteria?: string;
      changeNote?: string;
    },
  ): VersionRecord {
    const v = this.getVersion(caseId, versionIdValue);
    if (!v) throw new Error("版本不存在");
    if (v.status === "frozen") {
      throw new Error("已冻结版本不可编辑；请创建新版本");
    }
    const prompt =
      patch.prompt !== undefined
        ? patch.prompt
        : this.getPrompt(caseId, v.versionLabel);
    const acceptanceCriteria =
      patch.acceptanceCriteria !== undefined
        ? patch.acceptanceCriteria
        : v.acceptanceCriteria;
    const updated: VersionRecord = {
      ...v,
      acceptanceCriteria,
      changeNote: patch.changeNote ?? v.changeNote,
      contentHash: contentHash({ prompt, acceptanceCriteria }),
    };
    const dir = versionDir(this.projectRoot, caseId, v.versionLabel);
    writeJsonAtomic(`${dir}/version.json`, updated);
    if (patch.prompt !== undefined) writeTextAtomic(`${dir}/prompt.md`, prompt);
    this.withIndex((idx) => idx.upsertVersion(updated));
    return updated;
  }

  freezeVersion(caseId: string, versionIdValue: string): VersionRecord {
    const v = this.getVersion(caseId, versionIdValue);
    if (!v) throw new Error("版本不存在");
    if (v.status === "frozen") return v;
    const updated: VersionRecord = {
      ...v,
      status: "frozen",
      frozenAt: now(),
    };
    writeJsonAtomic(
      `${versionDir(this.projectRoot, caseId, v.versionLabel)}/version.json`,
      updated,
    );
    this.withIndex((idx) => idx.upsertVersion(updated));
    return updated;
  }

  forkVersion(
    caseId: string,
    fromVersionId: string,
    changeNote?: string,
  ): VersionRecord {
    const from = this.getVersion(caseId, fromVersionId);
    if (!from) throw new Error("源版本不存在");
    const prompt = this.getPrompt(caseId, from.versionLabel);
    return this.createVersion({
      caseId,
      prompt,
      acceptanceCriteria: from.acceptanceCriteria,
      changeNote: changeNote ?? `基于 ${from.versionLabel}`,
      parentVersionId: from.versionId,
    });
  }

  prepareRun(input: {
    caseId: string;
    versionId: string;
    /** Optional freeform label; defaults to "default". */
    variant?: Variant;
    config?: Partial<RunConfigSnapshot>;
    tags?: string[];
    notes?: string;
  }): RunRecord {
    const v = this.getVersion(input.caseId, input.versionId);
    if (!v) throw new Error("版本不存在");

    if (v.status === "draft") {
      this.freezeVersion(input.caseId, v.versionId);
    }

    const rid = newRunId();
    const t = now();
    const variant = input.variant?.trim() || input.config?.variant?.trim() || "default";
    const record: RunRecord = {
      runId: rid,
      caseId: input.caseId,
      versionId: v.versionId,
      variant,
      status: "awaiting_session",
      startedAt: null,
      endedAt: null,
      sessionId: null,
      conversationIds: [],
      config: {
        model: input.config?.model ?? null,
        modelId: input.config?.modelId ?? null,
        modelParams: input.config?.modelParams ?? null,
        variant,
        skills: input.config?.skills ?? "unknown",
        gitCommit: input.config?.gitCommit ?? null,
        gitDirty: input.config?.gitDirty ?? null,
        source: input.config?.source ?? "manual",
      },
      evaluation: "unevaluated",
      notes: input.notes ?? "",
      tags: input.tags ?? [],
      measurementCapabilities: [],
      missingFields: [],
      reassignmentHistory: [],
      createdAt: t,
      updatedAt: t,
    };

    const dir = runDir(this.projectRoot, input.caseId, v.versionLabel, rid);
    ensureDir(`${dir}/events`);
    writeJsonAtomic(`${dir}/run.json`, record);
    this.withIndex((idx) => idx.upsertRun(record));
    this.touchCase(input.caseId);
    return record;
  }

  getRun(runId: string): RunRecord | null {
    return this.withIndex((idx) => idx.getRun(runId));
  }

  runPath(run: RunRecord): string | null {
    const v = this.withIndex((idx) => idx.getVersion(run.versionId));
    if (!v) {
      // fallback scan versions
      for (const ver of this.listVersions(run.caseId)) {
        if (ver.versionId === run.versionId) {
          return runDir(
            this.projectRoot,
            run.caseId,
            ver.versionLabel,
            run.runId,
          );
        }
      }
      return null;
    }
    return runDir(this.projectRoot, run.caseId, v.versionLabel, run.runId);
  }

  saveRun(run: RunRecord): void {
    const path = this.runPath(run);
    if (!path) throw new Error("无法定位运行目录");
    run.updatedAt = now();
    writeJsonAtomic(`${path}/run.json`, run);
    this.withIndex((idx) => idx.upsertRun(run));
  }

  updateRunMeta(
    runId: string,
    patch: {
      evaluation?: EvalStatus;
      notes?: string;
      tags?: string[];
      status?: RunStatus;
    },
  ): RunRecord {
    const run = this.getRun(runId);
    if (!run) throw new Error("运行不存在");
    if (patch.evaluation !== undefined) run.evaluation = patch.evaluation;
    if (patch.notes !== undefined) run.notes = patch.notes;
    if (patch.tags !== undefined) run.tags = patch.tags;
    if (patch.status !== undefined) {
      run.status = patch.status;
      if (
        (patch.status === "completed" ||
          patch.status === "interrupted" ||
          patch.status === "failed") &&
        !run.endedAt
      ) {
        run.endedAt = now();
      }
    }
    this.saveRun(run);
    return run;
  }

  listRuns(caseId: string, versionId?: string): RunRecord[] {
    return this.withIndex((idx) => idx.listRuns(caseId, versionId));
  }

  deleteRun(runId: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    const path = this.runPath(run);
    if (path) removePath(path);
    this.withIndex((idx) => idx.markDeleted(runId, "run"));
    rebuildIndexFor(this.projectRoot);
  }

  touchCase(caseId: string): void {
    const c = this.getCase(caseId);
    if (!c) return;
    c.updatedAt = now();
    writeJsonAtomic(caseJsonPath(this.projectRoot, caseId), c);
    this.withIndex((idx) => idx.upsertCase(c));
  }

  rebuildIndex(): void {
    rebuildIndexFor(this.projectRoot);
  }
}

export function rebuildIndexFor(projectRoot: string): void {
  const store = new CaseStore(projectRoot);
  const idx = openIndex(projectRoot);
  try {
    idx.clearAll();
    for (const c of store.listCases(true)) {
      if (idx.isDeleted(c.caseId)) continue;
      idx.upsertCase(c);
      for (const v of store.listVersions(c.caseId)) {
        if (idx.isDeleted(v.versionId)) continue;
        idx.upsertVersion(v);
        const runsPath = `${versionDir(projectRoot, c.caseId, v.versionLabel)}/runs`;
        for (const rid of listDirs(runsPath)) {
          if (idx.isDeleted(rid)) continue;
          const run = readJson<RunRecord>(`${runsPath}/${rid}/run.json`);
          if (!run) continue;
          idx.upsertRun(run);
          for (const f of listFiles(`${runsPath}/${rid}/events`, ".jsonl")) {
            for (const row of readJsonl(`${runsPath}/${rid}/events/${f}`)) {
              const ev = row as TraceEvent;
              if (ev?.eventId) idx.insertEvent(run.runId, ev);
            }
          }
        }
      }
    }
  } finally {
    idx.close();
  }
}
