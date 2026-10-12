import { buildSummary } from "./aggregate.js";
import { CaseStore } from "./cases.js";
import { openIndex } from "./index-db.js";
import type { RunRecord, RunSummary } from "./types.js";
import { UNCATEGORIZED_CASE_ID } from "./types.js";

export type PickedRun = "completed" | "latest" | "none";

export interface CompareDeltas {
  inputTokens: number | null;
  wallClockMs: number | null;
  toolCallCount: number | null;
  failureCount: number | null;
}

export interface CompareColumn {
  caseId: string;
  name: string;
  versionId: string | null;
  versionLabel: string | null;
  prompt: string;
  picked: PickedRun;
  run: RunRecord | null;
  summary: RunSummary | null;
  /** Null on the first column. Later columns are relative to the first. */
  deltas: CompareDeltas | null;
}

/** Latest completed run; otherwise the most recently updated run. */
export function pickRepresentativeRun(runs: RunRecord[]): {
  run: RunRecord | null;
  picked: PickedRun;
} {
  const completed = runs.find((r) => r.status === "completed");
  if (completed) return { run: completed, picked: "completed" };
  if (runs[0]) return { run: runs[0], picked: "latest" };
  return { run: null, picked: "none" };
}

function numDelta(
  base: number | null | undefined,
  value: number | null | undefined,
): number | null {
  if (base == null || value == null) return null;
  return value - base;
}

function deltasAgainst(
  base: RunSummary | null,
  value: RunSummary | null,
): CompareDeltas | null {
  if (!base || !value) return null;
  return {
    inputTokens: numDelta(base.usage?.inputTokens, value.usage?.inputTokens),
    wallClockMs: numDelta(base.wallClockMs, value.wallClockMs),
    toolCallCount: numDelta(base.toolCallCount, value.toolCallCount),
    failureCount: numDelta(base.failureCount, value.failureCount),
  };
}

/** Compare 2–4 existing cases. Order of caseIds is the column order. */
export function compareCases(
  projectRoot: string,
  caseIds: string[],
): CompareColumn[] {
  const ids: string[] = [];
  for (const raw of caseIds) {
    const id = raw.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length < 2 || ids.length > 4) {
    throw new Error("需要 2–4 个案例");
  }
  if (ids.includes(UNCATEGORIZED_CASE_ID)) {
    throw new Error("未分类不能参与对比");
  }

  const store = new CaseStore(projectRoot);
  const idx = openIndex(projectRoot);
  try {
    const columns: CompareColumn[] = [];
    for (const caseId of ids) {
      const record = store.getCase(caseId);
      if (!record) throw new Error(`案例不存在: ${caseId}`);
      const { run, picked } = pickRepresentativeRun(idx.listRuns(caseId));
      const version = run ? store.getVersion(caseId, run.versionId) : null;
      const summary = run
        ? buildSummary(
            run.runId,
            idx.listEvents(run.runId),
            run.startedAt,
            run.endedAt,
          )
        : null;
      columns.push({
        caseId,
        name: record.name,
        versionId: version?.versionId ?? null,
        versionLabel: version?.versionLabel ?? null,
        prompt: version ? store.getPrompt(caseId, version.versionLabel) : "",
        picked,
        run,
        summary,
        deltas: null,
      });
    }
    const base = columns[0]?.summary ?? null;
    for (let i = 1; i < columns.length; i++) {
      columns[i]!.deltas = deltasAgainst(base, columns[i]!.summary);
    }
    return columns;
  } finally {
    idx.close();
  }
}
