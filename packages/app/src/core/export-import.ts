import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CaseStore, rebuildIndexFor } from "./cases.js";
import {
  ensureDir,
  listDirs,
  pathExists,
  readJson,
  removePath,
  writeJsonAtomic,
} from "./fsutil.js";
import { caseDir, exportsDir } from "./paths.js";
import type { CaseRecord } from "./types.js";

export interface ExportManifest {
  format: "cursor-local-trace-case-v1";
  exportedAt: string;
  caseId: string;
  simulated?: boolean;
}

export function exportCase(
  projectRoot: string,
  caseId: string,
): { path: string; manifest: ExportManifest } {
  const store = new CaseStore(projectRoot);
  const c = store.getCase(caseId);
  if (!c) throw new Error("案例不存在");

  const outDir = join(exportsDir(projectRoot), `${caseId}-${Date.now()}`);
  ensureDir(outDir);
  cpSync(caseDir(projectRoot, caseId), join(outDir, "case"), {
    recursive: true,
  });
  const manifest: ExportManifest = {
    format: "cursor-local-trace-case-v1",
    exportedAt: new Date().toISOString(),
    caseId,
  };
  writeJsonAtomic(join(outDir, "manifest.json"), manifest);

  const lines = [
    "runId,versionId,variant,status,evaluation,wallClockMs,inputTokens,outputTokens,toolCalls,failures,usageSource",
  ];
  for (const v of store.listVersions(caseId)) {
    for (const r of store.listRuns(caseId, v.versionId)) {
      const summary = readJson<{
        wallClockMs: number | null;
        usage: {
          inputTokens: number | null;
          outputTokens: number | null;
        } | null;
        toolCallCount: number;
        failureCount: number;
        usageSource: string;
      }>(`${store.runPath(r)}/summary.json`);
      lines.push(
        [
          r.runId,
          r.versionId,
          r.variant,
          r.status,
          r.evaluation,
          summary?.wallClockMs ?? "",
          summary?.usage?.inputTokens ?? "",
          summary?.usage?.outputTokens ?? "",
          summary?.toolCallCount ?? "",
          summary?.failureCount ?? "",
          summary?.usageSource ?? "missing",
        ].join(","),
      );
    }
  }
  writeFileSync(join(outDir, "runs.csv"), lines.join("\n") + "\n", "utf8");

  return { path: outDir, manifest };
}

export interface ImportResult {
  ok: boolean;
  conflict?: boolean;
  caseId?: string;
  message: string;
}

/**
 * Import a case export directory. Refuses to overwrite on ID conflict
 * unless forceRename is set (assigns new case id).
 */
export function importCase(
  projectRoot: string,
  exportPath: string,
  opts?: { forceRename?: boolean },
): ImportResult {
  const manifest = readJson<ExportManifest>(join(exportPath, "manifest.json"));
  if (!manifest || manifest.format !== "cursor-local-trace-case-v1") {
    return { ok: false, message: "无效的导出清单" };
  }
  const srcCase = join(exportPath, "case");
  if (!pathExists(srcCase)) {
    return { ok: false, message: "缺少 case 目录" };
  }
  const caseJson = readJson<CaseRecord>(join(srcCase, "case.json"));
  if (!caseJson) return { ok: false, message: "缺少 case.json" };

  const store = new CaseStore(projectRoot);
  const existing = store.getCase(caseJson.caseId);
  if (existing && !opts?.forceRename) {
    return {
      ok: false,
      conflict: true,
      caseId: caseJson.caseId,
      message: `案例 ID 冲突: ${caseJson.caseId}；请使用 --force-rename 或先删除`,
    };
  }

  let targetId = caseJson.caseId;
  if (existing && opts?.forceRename) {
    const created = store.createCase({
      name: `${caseJson.name} (导入)`,
      description: caseJson.description,
      tags: caseJson.tags,
    });
    targetId = created.caseId;
    // Copy versions/runs under new id — simplified: copy tree then rewrite case.json
    removePath(caseDir(projectRoot, targetId));
    cpSync(srcCase, caseDir(projectRoot, targetId), { recursive: true });
    caseJson.caseId = targetId;
    caseJson.name = `${caseJson.name} (导入)`;
    writeJsonAtomic(join(caseDir(projectRoot, targetId), "case.json"), caseJson);
  } else {
    if (pathExists(caseDir(projectRoot, targetId))) {
      return {
        ok: false,
        conflict: true,
        caseId: targetId,
        message: "目标目录已存在",
      };
    }
    cpSync(srcCase, caseDir(projectRoot, targetId), { recursive: true });
  }

  rebuildIndexFor(projectRoot);
  return { ok: true, caseId: targetId, message: "导入成功" };
}

export function listExports(projectRoot: string): string[] {
  return listDirs(exportsDir(projectRoot)).map((d) =>
    join(exportsDir(projectRoot), d),
  );
}
