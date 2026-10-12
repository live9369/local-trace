import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildIndexFor } from "../core/cases.js";
import { exportCase, importCase } from "../core/export-import.js";
import { listFiles, readJson } from "../core/fsutil.js";
import {
  globalDiagnosticsDir,
  globalRoot,
  globalRuntimeDir,
  pluginLocalDir,
  runtimeDir,
  userHooksPath,
} from "../core/paths.js";
import { initProject, loadConfig } from "../core/project.js";
import { installPlugin, uninstallPlugin } from "./install.js";
import { ingestHookPayload } from "../core/ingest.js";
import {
  beginSkillRun,
  endSkillRun,
  skillRunStatus,
} from "../core/skill-run.js";

function help(): void {
  console.log(`Cursor Local Trace (clt)

用法:
  clt install [--project <path>] [--user-hooks]
  clt doctor [--project <path>]
  clt start [--project <path>] [--port <n>]
  clt stop [--project <path>]
  clt run begin --project <path> [--name <名>] [--prompt <文本>]
                 [--session <id>] [--case <id>] [--version <id>]
  clt run end --project <path>
  clt run status --project <path>
  clt export --case <caseId> [--project <path>]
  clt import <exportDir> [--project <path>] [--force-rename]
  clt rebuild-index [--project <path>]
  clt uninstall
  clt ingest-fixture <file.jsonl> [--project <path>]
  clt pack-plugin

主入口：Cursor Skill「local-trace」→ run begin → 做事 → run end。
看板案例列表可勾选 2–4 个案例做 A/B 分屏对比。数据仅保存在项目 .trace/；不上传云端。
`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

function runCommand(args: string[], projectRoot: string): void {
  const sub = args.find((a) => a === "begin" || a === "end" || a === "status");
  if (sub === "begin") {
    const result = beginSkillRun({
      projectRoot,
      name: flag(args, "--name"),
      prompt: flag(args, "--prompt"),
      caseId: flag(args, "--case"),
      versionId: flag(args, "--version"),
      sessionId: flag(args, "--session") ?? null,
    });
    console.log(result.message);
    console.log(
      JSON.stringify(
        {
          runId: result.run.runId,
          caseId: result.caseId,
          versionId: result.versionId,
          sessionId: result.sessionId,
          bound: result.bound,
          url: result.url,
          status: result.run.status,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (sub === "end") {
    const result = endSkillRun(projectRoot);
    console.log(result.message);
    if (result.summary) {
      console.log(
        JSON.stringify(
          {
            runId: result.run?.runId,
            url: result.url,
            wallClockMs: result.summary.wallClockMs,
            toolCallCount: result.summary.toolCallCount,
            failureCount: result.summary.failureCount,
            inputTokens: result.summary.usage?.inputTokens ?? null,
            outputTokens: result.summary.usage?.outputTokens ?? null,
            usageSource: result.summary.usageSource,
          },
          null,
          2,
        ),
      );
    }
    if (!result.run) process.exit(1);
    return;
  }
  if (sub === "status") {
    const s = skillRunStatus(projectRoot);
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  throw new Error("用法: clt run begin|end|status");
}

function projectArg(args: string[]): string {
  const i = args.indexOf("--project");
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  return process.cwd();
}

function doctor(projectRoot: string): void {
  const node = process.version;
  const install = readJson<{
    pluginDir: string;
    nodePath: string;
    installedAt: string;
  }>(join(globalRoot(), "install.json"));
  const pluginDir = pluginLocalDir();
  const cfg = loadConfig(projectRoot) ?? initProject(projectRoot);

  console.log("=== Cursor Local Trace Doctor ===");
  console.log(`Node: ${node} (${process.execPath})`);
  console.log(`安装记录: ${install ? "有" : "无"}`);
  if (install) {
    console.log(`  插件目录: ${install.pluginDir}`);
    console.log(`  钉死 Node: ${install.nodePath}`);
    console.log(`  安装时间: ${install.installedAt}`);
  }
  console.log(`插件目录存在: ${existsSync(pluginDir)}`);
  console.log(`hooks.json: ${existsSync(join(pluginDir, "hooks/hooks.json"))}`);
  console.log(`用户 hooks: ${existsSync(userHooksPath())} (${userHooksPath()})`);
  console.log(`项目根: ${projectRoot}`);
  console.log(`captureDetail: ${cfg.captureDetail}`);
  console.log(`serverPort: ${cfg.serverPort}`);

  const recent = join(projectRoot, ".trace/logs/hook-recent.jsonl");
  if (existsSync(recent)) {
    const lines = readFileSync(recent, "utf8").trim().split("\n").slice(-5);
    console.log(`最近事件 (${lines.length}):`);
    for (const l of lines) console.log(`  ${l}`);
  } else {
    console.log("最近事件: 无（尚未收到 Hook）");
  }

  const diagDir = globalDiagnosticsDir();
  if (existsSync(diagDir)) {
    const files = listFiles(diagDir, ".jsonl").slice(-2);
    console.log(`诊断日志: ${files.length ? files.join(", ") : "无"}`);
  }

  console.log("\n能力说明: turn token 仅来自 stop 的平台字段；子 Agent token 未提供。");
  console.log("真实 Cursor 联调状态见 docs/zh/verification.md");
}

function startServer(projectRoot: string, port?: number): void {
  initProject(projectRoot);

  // Reuse healthy existing server
  const existing = readJson<{ pid: number; url: string; projectRoot?: string }>(
    join(runtimeDir(projectRoot), "server.json"),
  );
  if (existing?.pid && existing.projectRoot === projectRoot) {
    try {
      process.kill(existing.pid, 0);
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          `fetch(${JSON.stringify(existing.url + "/api/health")}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
        ],
        { timeout: 2000 },
      );
      if (probe.status === 0) {
        console.log(existing.url);
        console.log(`(已在运行 PID ${existing.pid})`);
        return;
      }
    } catch {
      // stale pid — start fresh
    }
  }

  const serverJs = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
  const env = { ...process.env };
  if (port) env.CLT_PORT = String(port);

  // Fully detach: piped stdio can kill the child when the CLI exits
  const child = spawn(process.execPath, [serverJs, projectRoot], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 4000;
  const wait = (): void => {
    const state = readJson<{ url: string; pid: number }>(
      join(runtimeDir(projectRoot), "server.json"),
    );
    if (state?.url && state.pid === child.pid) {
      console.log(state.url);
      return;
    }
    if (Date.now() > deadline) {
      console.log(
        state?.url ??
          `服务启动超时；请检查: node ${serverJs} ${projectRoot}`,
      );
      process.exitCode = state?.url ? 0 : 1;
      return;
    }
    setTimeout(wait, 150);
  };
  wait();
}

function stopServer(projectRoot: string): void {
  const paths = [
    join(runtimeDir(projectRoot), "server.json"),
    join(globalRuntimeDir(), "server.json"),
  ];
  for (const p of paths) {
    const state = readJson<{ pid: number; projectRoot?: string }>(p);
    if (!state?.pid) continue;
    if (state.projectRoot && state.projectRoot !== projectRoot) continue;
    try {
      process.kill(state.pid, "SIGTERM");
      console.log(`已停止 PID ${state.pid}`);
      writeFileSync(p, JSON.stringify({ ...state, stoppedAt: new Date().toISOString() }, null, 2));
      return;
    } catch {
      console.log(`进程 ${state.pid} 不存在或已退出`);
    }
  }
  console.log("未找到本插件服务进程");
}

function ingestFixture(file: string, projectRoot: string): void {
  initProject(projectRoot);
  const text = readFileSync(file, "utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const payload = JSON.parse(t);
    // Ensure workspace root points at project
    if (!payload.workspace_roots) {
      payload.workspace_roots = [projectRoot];
    }
    const r = ingestHookPayload(payload);
    if (r.persisted) n++;
  }
  console.log(`已摄入 ${n} 条事件 → ${projectRoot}/.trace`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }

  const projectRoot = projectArg(rest);

  switch (cmd) {
    case "install": {
      const useUserHooks = rest.includes("--user-hooks");
      const result = installPlugin({
        projectRoot,
        useUserHooksFallback: useUserHooks,
      });
      console.log("安装完成");
      console.log(`  插件: ${result.pluginDir}`);
      console.log(`  Node: ${result.nodePath}`);
      console.log(`  CLI:  ${join(globalRoot(), "bin/clt")}`);
      console.log("请重启 Cursor 或执行 Developer: Reload Window");
      if (!useUserHooks) {
        console.log(
          "提示: 若插件 Hooks 未加载，可再执行: clt install --user-hooks",
        );
      }
      break;
    }
    case "doctor":
      doctor(projectRoot);
      break;
    case "start": {
      const pi = rest.indexOf("--port");
      const port = pi >= 0 ? Number(rest[pi + 1]) : undefined;
      startServer(projectRoot, port);
      break;
    }
    case "stop":
      stopServer(projectRoot);
      break;
    case "export": {
      const ci = rest.indexOf("--case");
      if (ci < 0 || !rest[ci + 1]) throw new Error("需要 --case <caseId>");
      const out = exportCase(projectRoot, rest[ci + 1]!);
      console.log(out.path);
      break;
    }
    case "import": {
      const dir = rest.find((a) => !a.startsWith("--") && a !== projectRoot);
      if (!dir) throw new Error("需要导出目录路径");
      const r = importCase(projectRoot, dir, {
        forceRename: rest.includes("--force-rename"),
      });
      console.log(r.message);
      if (!r.ok) process.exit(1);
      break;
    }
    case "rebuild-index":
      rebuildIndexFor(projectRoot);
      console.log("索引已重建");
      break;
    case "uninstall":
      uninstallPlugin();
      console.log("已卸载插件注册；项目 .trace/ 数据默认保留");
      break;
    case "ingest-fixture": {
      const file = rest.find((a) => a.endsWith(".jsonl") || a.endsWith(".json"));
      if (!file) throw new Error("需要 fixture 文件");
      ingestFixture(file, projectRoot);
      break;
    }
    case "pack-plugin": {
      const r = installPlugin({ projectRoot });
      console.log(`已打包安装到 ${r.pluginDir}`);
      break;
    }
    case "init":
      initProject(projectRoot);
      console.log(`已初始化 ${projectRoot}/.trace`);
      break;
    case "run":
      runCommand(rest, projectRoot);
      break;
    default:
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
