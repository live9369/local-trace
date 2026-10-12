# Cursor Local Trace

以 **Skill `local-trace`** 触发、Hooks 埋点、项目 `.trace/` 存储、浏览器看板查看。

中文说明：[docs/zh/README.md](docs/zh/README.md)

```bash
npm install && npm run build
node packages/app/dist/cli.mjs install --project "$(pwd)" --user-hooks
# Reload Window 后，在 Agent 中使用 skill「local-trace」
```

Skill 流程：`clt run begin` → 做任务 → `clt run end` → 打开运行 URL。
