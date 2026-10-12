import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/** esbuild strips node: from some builtins; node:sqlite must keep the prefix. */
function fixNodeSqlite(outDir: string): void {
  for (const name of readdirSync(outDir)) {
    if (!name.endsWith(".mjs")) continue;
    const p = join(outDir, name);
    const src = readFileSync(p, "utf8");
    const next = src
      .replaceAll('from "sqlite"', 'from "node:sqlite"')
      .replaceAll("from 'sqlite'", "from 'node:sqlite'");
    if (next !== src) writeFileSync(p, next);
  }
}

export default defineConfig({
  entry: {
    hook: "src/hook/index.ts",
    cli: "src/cli/index.ts",
    server: "src/server/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  outExtension() {
    return { js: ".mjs" };
  },
  async onSuccess() {
    fixNodeSqlite("dist");
  },
});
