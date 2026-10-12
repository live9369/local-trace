import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ID } from "./types.js";

export function globalRoot(): string {
  return join(homedir(), ".cursor", "local-trace");
}

export function globalDiagnosticsDir(): string {
  return join(globalRoot(), "diagnostics");
}

export function globalRuntimeDir(): string {
  return join(globalRoot(), "runtime");
}

export function pluginLocalDir(): string {
  return join(homedir(), ".cursor", "plugins", "local", PLUGIN_ID);
}

export function userHooksPath(): string {
  return join(homedir(), ".cursor", "hooks.json");
}

export function traceDir(projectRoot: string): string {
  return join(projectRoot, ".trace");
}

export function traceConfigPath(projectRoot: string): string {
  return join(traceDir(projectRoot), "config.json");
}

export function indexDbPath(projectRoot: string): string {
  return join(traceDir(projectRoot), "index.sqlite");
}

export function casesDir(projectRoot: string): string {
  return join(traceDir(projectRoot), "cases");
}

export function caseDir(projectRoot: string, caseId: string): string {
  return join(casesDir(projectRoot), caseId);
}

export function caseJsonPath(projectRoot: string, caseId: string): string {
  return join(caseDir(projectRoot, caseId), "case.json");
}

export function versionsDir(projectRoot: string, caseId: string): string {
  return join(caseDir(projectRoot, caseId), "versions");
}

export function versionDir(
  projectRoot: string,
  caseId: string,
  versionLabel: string,
): string {
  return join(versionsDir(projectRoot, caseId), versionLabel);
}

export function runDir(
  projectRoot: string,
  caseId: string,
  versionLabel: string,
  runId: string,
): string {
  return join(versionDir(projectRoot, caseId, versionLabel), "runs", runId);
}

export function runtimeDir(projectRoot: string): string {
  return join(traceDir(projectRoot), "runtime");
}

export function logsDir(projectRoot: string): string {
  return join(traceDir(projectRoot), "logs");
}

export function exportsDir(projectRoot: string): string {
  return join(traceDir(projectRoot), "exports");
}

export function sessionMapPath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), "session-map.json");
}

export function lastSessionPath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), "last-session.json");
}

export function activeSkillRunPath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), "active-skill-run.json");
}
