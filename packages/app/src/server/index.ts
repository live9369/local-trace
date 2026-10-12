import { writeFileSync } from "node:fs";
import { createTraceServer } from "./api.js";
import { initProject, loadConfig } from "../core/project.js";
import { ensureDir } from "../core/fsutil.js";
import { runtimeDir, globalRuntimeDir } from "../core/paths.js";

function main(): void {
  const projectRoot = process.argv[2] ?? process.cwd();
  const cfg = initProject(projectRoot);
  const port = Number(process.env.CLT_PORT ?? cfg.serverPort ?? 7437);
  const server = createTraceServer(projectRoot);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用。可先执行: clt stop --project ${projectRoot}`);
      process.exit(1);
    }
    console.error(err.message);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    ensureDir(runtimeDir(projectRoot));
    ensureDir(globalRuntimeDir());
    const state = {
      pid: process.pid,
      port,
      url,
      projectRoot,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(
      `${runtimeDir(projectRoot)}/server.json`,
      JSON.stringify(state, null, 2),
    );
    writeFileSync(
      `${globalRuntimeDir()}/server.json`,
      JSON.stringify(state, null, 2),
    );
    console.log(url);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
