import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  openSync,
  closeSync,
  fsyncSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic replace via temp file + rename. */
export function writeJsonAtomic(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function appendJsonl(path: string, obj: unknown): void {
  ensureDir(dirname(path));
  const line = JSON.stringify(obj) + "\n";
  const fd = openSync(path, "a");
  try {
    appendFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // tolerate truncated last line
    }
  }
  return out;
}

export function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function listFiles(path: string, suffix?: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((n) => (suffix ? n.endsWith(suffix) : true))
    .sort();
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function joinPath(...parts: string[]): string {
  return join(...parts);
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function copyFile(src: string, dest: string): void {
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}

export function writeTextAtomic(path: string, text: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
