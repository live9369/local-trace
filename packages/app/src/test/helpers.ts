import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../core/project.js";

export function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "clt-test-"));
  initProject(dir);
  return dir;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
