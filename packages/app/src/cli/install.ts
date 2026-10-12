import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { pluginLocalDir, userHooksPath, globalRoot } from "../core/paths.js";
import { ensureDir } from "../core/fsutil.js";
import { initProject } from "../core/project.js";
import { PLUGIN_ID } from "../core/types.js";

function distDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Repo root when running from packages/app/dist; null when running from installed plugin. */
function repoRootOrNull(): string | null {
  const here = distDir();
  const candidate = join(here, "../../..");
  if (existsSync(join(candidate, "plugin/hooks/hooks.json"))) return candidate;
  return null;
}

function resolveNodePath(): string {
  try {
    const out = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    // fall through
  }
  return process.execPath;
}

export function installPlugin(opts: {
  projectRoot?: string;
  useUserHooksFallback?: boolean;
}): {
  pluginDir: string;
  nodePath: string;
  projectRoot?: string;
} {
  const nodePath = resolveNodePath();
  const dest = pluginLocalDir();
  mkdirSync(dest, { recursive: true });

  const repo = repoRootOrNull();
  const runningFrom = distDir();
  if (repo) {
    const src = join(repo, "plugin");
    cpSync(src, dest, { recursive: true });
    const dist = join(repo, "packages/app/dist");
    if (!existsSync(join(dist, "hook.mjs"))) {
      throw new Error("缺少构建产物 dist/hook.mjs，请先运行 npm run build");
    }
    cpSync(dist, join(dest, "dist"), { recursive: true });
  } else {
    // Re-install from already-bundled plugin dist
    if (!existsSync(join(runningFrom, "hook.mjs"))) {
      throw new Error("无法定位 hook.mjs；请从仓库执行 npm run build && clt install");
    }
    ensureDir(join(dest, "hooks"));
    writeFileSync(
      join(dest, "hooks/hooks.json"),
      JSON.stringify(defaultHooksJson(), null, 2) + "\n",
    );
    if (!existsSync(join(dest, ".cursor-plugin/plugin.json"))) {
      mkdirSync(join(dest, ".cursor-plugin"), { recursive: true });
      writeFileSync(
        join(dest, ".cursor-plugin/plugin.json"),
        JSON.stringify(
          {
            name: PLUGIN_ID,
            version: "0.1.0",
            description: "Local Cursor Agent trace",
            hooks: "./hooks/hooks.json",
          },
          null,
          2,
        ),
      );
    }
    cpSync(runningFrom, join(dest, "dist"), { recursive: true });
  }

  const hooksPath = join(dest, "hooks/hooks.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
    version: number;
    hooks: Record<string, Array<{ command: string; timeout?: number }>>;
  };
  const command = `${nodePath} "${join(dest, "dist/hook.mjs")}"`;
  for (const list of Object.values(hooks.hooks)) {
    for (const h of list) {
      h.command = command;
    }
  }
  writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");

  ensureDir(globalRoot());
  writeFileSync(
    join(globalRoot(), "install.json"),
    JSON.stringify(
      {
        pluginId: PLUGIN_ID,
        pluginDir: dest,
        nodePath,
        installedAt: new Date().toISOString(),
        version: "0.1.0",
      },
      null,
      2,
    ) + "\n",
  );

  const binDir = join(globalRoot(), "bin");
  ensureDir(binDir);
  const cltPath = join(binDir, "clt");
  const wrapper = `#!/bin/sh
exec ${JSON.stringify(nodePath)} ${JSON.stringify(join(dest, "dist/cli.mjs"))} "$@"
`;
  writeFileSync(cltPath, wrapper, "utf8");
  chmodSync(cltPath, 0o755);

  if (opts.useUserHooksFallback) {
    mergeUserHooks(command);
  }

  if (opts.projectRoot) {
    initProject(opts.projectRoot);
  }

  return { pluginDir: dest, nodePath, projectRoot: opts.projectRoot };
}

function mergeUserHooks(command: string): void {
  const path = userHooksPath();
  ensureDir(dirname(path));
  if (existsSync(path)) {
    const bak = `${path}.bak-local-trace-${Date.now()}`;
    writeFileSync(bak, readFileSync(path));
  }
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as {
        version?: number;
        hooks?: Record<string, Array<{ command: string; timeout?: number }>>;
      })
    : { version: 1, hooks: {} };

  existing.version = existing.version ?? 1;
  existing.hooks = existing.hooks ?? {};

  const events = [
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "subagentStart",
    "subagentStop",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "beforeReadFile",
    "afterFileEdit",
    "afterAgentResponse",
    "afterAgentThought",
    "preCompact",
    "stop",
  ];

  for (const ev of events) {
    const list = existing.hooks[ev] ?? [];
    const cleaned = list.filter(
      (h) =>
        !h.command.includes("cursor-local-trace") &&
        !h.command.includes("local-trace/dist/hook"),
    );
    cleaned.push({
      command,
      timeout: ["stop", "sessionEnd", "beforeSubmitPrompt"].includes(ev)
        ? 60
        : 10,
    });
    existing.hooks[ev] = cleaned;
  }
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
}

function defaultHooksJson(): {
  version: number;
  hooks: Record<string, Array<{ command: string; timeout?: number }>>;
} {
  const events: Array<[string, number]> = [
    ["sessionStart", 10],
    ["sessionEnd", 60],
    ["beforeSubmitPrompt", 60],
    ["preToolUse", 10],
    ["postToolUse", 10],
    ["postToolUseFailure", 10],
    ["subagentStart", 10],
    ["subagentStop", 10],
    ["beforeShellExecution", 10],
    ["afterShellExecution", 10],
    ["beforeMCPExecution", 10],
    ["afterMCPExecution", 10],
    ["beforeReadFile", 10],
    ["afterFileEdit", 10],
    ["afterAgentResponse", 10],
    ["afterAgentThought", 10],
    ["preCompact", 10],
    ["stop", 60],
  ];
  const hooks: Record<string, Array<{ command: string; timeout?: number }>> = {};
  for (const [name, timeout] of events) {
    hooks[name] = [
      {
        command: 'node "${CURSOR_PLUGIN_ROOT}/dist/hook.mjs"',
        timeout,
      },
    ];
  }
  return { version: 1, hooks };
}

export function uninstallPlugin(): void {
  const dest = pluginLocalDir();
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  const path = userHooksPath();
  if (existsSync(path)) {
    const bak = `${path}.bak-local-trace-uninstall-${Date.now()}`;
    writeFileSync(bak, readFileSync(path));
    const existing = JSON.parse(readFileSync(path, "utf8")) as {
      hooks?: Record<string, Array<{ command: string }>>;
    };
    if (existing.hooks) {
      for (const [ev, list] of Object.entries(existing.hooks)) {
        existing.hooks[ev] = list.filter(
          (h) =>
            !h.command.includes("cursor-local-trace") &&
            !h.command.includes("local-trace/dist/hook"),
        );
      }
    }
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  }
}
