---
name: local-trace
description: >-
  Starts and ends a Cursor Local Trace run around the user's current Agent task,
  then returns the dashboard run URL. Use when the user asks to trace, observe,
  record this Agent turn, open a local-trace report/看板, or mention local-trace
  — including when that request is combined with another task.
---

# Local Trace（观测触发）

本 skill **不是文档**：一旦适用，必须用 CLI **包住**用户任务（begin → 做事 → end），并给出看板链接。

## 硬规则

1. **第一条 shell 必须是** `clt run begin`（在任何 Read/Grep/编辑之前）。
2. **最后一条相关 shell 必须是** `clt run end`；把输出的运行详情 URL **原样**发给用户。
3. 禁止只读本文件/README 当「项目说明」却不执行 begin/end。
4. 禁止伪造 token；缺失则写「未提供」。数据只在项目 `.trace/`，不上云。
5. 本工具只负责观测；不限制也不偏好任何 MCP/探索方式。A/B 在看板案例列表勾选 2–4 个案例后分屏对比。

## 命令模板

```bash
CLT="$HOME/.cursor/local-trace/bin/clt"
[ -x "$CLT" ] || CLT="node $HOME/.cursor/plugins/local/cursor-local-trace/dist/cli.mjs"
PROJECT="<workspace-root-absolute-path>"

# 1) 开始（先于一切任务工具）
$CLT run begin --project "$PROJECT" \
  --name "<简短任务名>" \
  --prompt "<用户原话或摘要>"

# 可选：打开看板进程
$CLT start --project "$PROJECT" 2>/dev/null || true

# 2) ……在这里完成用户真正的任务……

# 3) 结束（任务完成后立刻）
$CLT run end --project "$PROJECT"
```

- 对比 2–4 个已有案例：各开对话各跑一轮（begin→做→end），再在看板案例列表勾选后点 **A/B**。
- begin 若提示未绑定 session：仍继续任务，提醒 Reload Hooks；**仍然要 end**。

## 对用户回复

- 贴上 `run end` 打印的详情 URL（默认看板 `http://127.0.0.1:7437`）。
- 一句话概括：工具次数、墙钟、token（无则「未提供」）。

## 排查

```bash
$CLT run status --project "$PROJECT"
$CLT doctor --project "$PROJECT"
```
