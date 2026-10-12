import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, normalize, sep } from "node:path";
import {
  ensureDir,
  pathExists,
  readJson,
  writeJsonAtomic,
  appendJsonl,
} from "./fsutil.js";
import {
  globalDiagnosticsDir,
  traceConfigPath,
  traceDir,
  casesDir,
  logsDir,
  runtimeDir,
  exportsDir,
  caseJsonPath,
} from "./paths.js";
import type { CaseRecord, TraceConfig } from "./types.js";
import { SCHEMA_VERSION, UNCATEGORIZED_CASE_ID } from "./types.js";

export interface ResolveResult {
  projectRoot: string | null;
  reason: string;
  candidates: string[];
}

function isSubPath(parent: string, child: string): boolean {
  const p = resolve(parent) + sep;
  const c = resolve(child) + sep;
  return c.startsWith(p) || resolve(parent) === resolve(child);
}

export function resolveProjectRoot(input: {
  workspaceRoots?: unknown;
  cursorProjectDir?: string | null;
  cwd?: string;
}): ResolveResult {
  const roots = Array.isArray(input.workspaceRoots)
    ? (input.workspaceRoots as unknown[])
        .filter((r): r is string => typeof r === "string" && r.length > 0)
        .map((r) => resolve(normalize(r)))
    : [];

  const withTrace = roots.filter((r) => pathExists(traceConfigPath(r)));
  if (withTrace.length === 1) {
    return {
      projectRoot: withTrace[0]!,
      reason: "existing_.trace",
      candidates: roots,
    };
  }
  if (withTrace.length > 1) {
    return {
      projectRoot: null,
      reason: "ambiguous_multiple_trace_roots",
      candidates: withTrace,
    };
  }

  if (roots.length === 1) {
    return {
      projectRoot: roots[0]!,
      reason: "single_workspace_root",
      candidates: roots,
    };
  }

  const cpd = input.cursorProjectDir
    ? resolve(normalize(input.cursorProjectDir))
    : null;
  if (cpd && roots.length > 0) {
    const matches = roots.filter((r) => isSubPath(r, cpd) || r === cpd);
    if (matches.length === 1) {
      return {
        projectRoot: matches[0]!,
        reason: "cursor_project_dir",
        candidates: roots,
      };
    }
  }

  if (roots.length === 0 && cpd && existsSync(cpd)) {
    return {
      projectRoot: cpd,
      reason: "cursor_project_dir_only",
      candidates: [cpd],
    };
  }

  if (roots.length === 0 && input.cwd) {
    const cwd = resolve(input.cwd);
    if (pathExists(traceConfigPath(cwd))) {
      return {
        projectRoot: cwd,
        reason: "cwd_with_trace",
        candidates: [cwd],
      };
    }
  }

  return {
    projectRoot: null,
    reason:
      roots.length > 1
        ? "ambiguous_multi_root_no_trace"
        : "no_resolvable_project_root",
    candidates: roots,
  };
}

export function defaultConfig(projectRoot: string): TraceConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectRoot,
    createdAt: new Date().toISOString(),
    captureDetail: false,
    retentionDays: null,
    serverPort: 7437,
    locale: "zh-CN",
  };
}

function ensureUncategorized(projectRoot: string): void {
  const path = caseJsonPath(projectRoot, UNCATEGORIZED_CASE_ID);
  if (pathExists(path)) return;
  const now = new Date().toISOString();
  const record: CaseRecord = {
    caseId: UNCATEGORIZED_CASE_ID,
    name: "未分类",
    description: "未绑定到明确案例的会话自动归入此处",
    archived: false,
    createdAt: now,
    updatedAt: now,
    tags: ["system"],
    system: true,
  };
  ensureDir(casesDir(projectRoot));
  writeJsonAtomic(path, record);
}

function ensureIgnoreEntries(projectRoot: string): void {
  for (const file of [".gitignore", ".cursorignore"]) {
    const p = `${projectRoot}/${file}`;
    if (!existsSync(p) && file === ".cursorignore") continue;
    try {
      let content = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (
        content
          .split(/\r?\n/)
          .some((l) => l.trim() === ".trace/" || l.trim() === ".trace")
      ) {
        continue;
      }
      if (content.length && !content.endsWith("\n")) content += "\n";
      content += "\n# Cursor Local Trace\n.trace/\n";
      writeFileSync(p, content, "utf8");
    } catch {
      // ignore
    }
  }
}

export function initProject(projectRoot: string): TraceConfig {
  const root = resolve(projectRoot);
  ensureDir(traceDir(root));
  ensureDir(casesDir(root));
  ensureDir(logsDir(root));
  ensureDir(runtimeDir(root));
  ensureDir(exportsDir(root));

  let config = readJson<TraceConfig>(traceConfigPath(root));
  if (!config) {
    config = defaultConfig(root);
    writeJsonAtomic(traceConfigPath(root), config);
  }

  ensureUncategorized(root);
  ensureIgnoreEntries(root);
  return config;
}

export function writeDiagnostic(entry: Record<string, unknown>): void {
  try {
    ensureDir(globalDiagnosticsDir());
    const day = new Date().toISOString().slice(0, 10);
    appendJsonl(`${globalDiagnosticsDir()}/diag-${day}.jsonl`, {
      ...entry,
      at: new Date().toISOString(),
    });
  } catch {
    // never throw from diagnostics
  }
}

export function loadConfig(projectRoot: string): TraceConfig | null {
  return readJson<TraceConfig>(traceConfigPath(projectRoot));
}

export function saveConfig(projectRoot: string, config: TraceConfig): void {
  writeJsonAtomic(traceConfigPath(projectRoot), config);
}
