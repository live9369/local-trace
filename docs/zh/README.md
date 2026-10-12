# Cursor Local Trace — 中文使用说明

本地观测 Cursor Agent：以 **Skill `local-trace` 为主触发器**，Hooks 自动埋点，数据在项目 `.trace/`，浏览器看板查看步骤、耗时与平台 token。

## 要求

- macOS（优先）+ Cursor IDE Agent
- Node.js ≥ 22（`clt install` 会钉死绝对路径）
- 不需要云账号、API Key、Docker

## 安装

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # 若需要
cd /path/to/local-trace
npm install && npm run build
node packages/app/dist/cli.mjs install --project "$(pwd)" --user-hooks
```

然后 **Developer: Reload Window**。插件含 Hooks + Skill `local-trace`。

## 推荐用法：Skill 触发

1. 在 Cursor Agent 中启用 / 提及 skill **`local-trace`**（或说明「用 local-trace 观测本次任务」）。
2. Agent 会先执行：

   ```bash
   clt run begin --project <项目根> --name "任务名" --prompt "..."
   ```

3. 再执行你的真实任务（Hooks 自动写入 `.trace/`）。
4. 任务结束执行：

   ```bash
   clt run end --project <项目根>
   ```

5. 打开输出的看板链接查看本次 trace。

要对比 2–4 个已有案例：各开对话各观测一轮，再在看板案例列表勾选后点 **A/B** 分屏看。

### 手动 CLI（与 Skill 等价）

```bash
clt run begin --project "$PWD" --name "demo"
clt start --project "$PWD"          # 可选，打开看板
# … 在 Cursor 中跑 Agent …
clt run end --project "$PWD"
clt run status --project "$PWD"
```

## 看板

```bash
clt start --project /path/to/project
# http://127.0.0.1:7437
```

也可不用看板，仅用 Skill 输出的单次运行 URL。

## 诊断 / 卸载

```bash
clt doctor --project /path/to/project
clt uninstall   # 默认保留 .trace/ 数据
```

## 更多

- [数据结构](./data-model.md)
- [指标口径](./metrics.md)
- [Hook 能力](./hook-capabilities.md)
- [验证结果](./verification.md)
