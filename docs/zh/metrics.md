# 指标口径

## Token

| 规则 | 说明 |
|---|---|
| 来源 | 仅采纳 Hook `stop` 上的平台字段：`input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` |
| 范围 | **整轮（turn）**，不是逐步请求 |
| 去重 | 同一 `generation_id` 上 `afterAgentResponse` 可能带相同数值，**禁止与 stop 相加** |
| 包含关系 | `input_tokens` 通常包含 cache 读写；展示原始字段，不把 cache 再加进合计 |
| 子 Agent | Hooks **不提供** subagent token；界面显示「未提供」 |
| 缺失 | 字段缺失为 `null` /「未提供」，**从不用 0 代替** |
| 步骤 | 不把 turn token 均摊到工具步骤 |
| 费用 | 默认不计算，避免当成 Cursor 账单 |

## 时间

| 类型 | 含义 |
|---|---|
| 墙钟 | run/turn 起止（ISO 时间差）或事件接收时间跨度 |
| 工具 duration | 平台 `duration` / `duration_ms`（毫秒） |
| 并行 | 时间线可重叠。墙钟是 run 起止或事件跨度，**不**把工具 duration 相加，也**不**再算区间并集 |
| 思考时间 | **不**用「总耗时 − 工具耗时」推导 |

## 对比

看板在案例列表勾选 2–4 个已有案例后分屏。每列用该案例最近一条 `completed` run；没有则用最近一条并标明。

- 各列展示墙钟、input token、工具次数、失败次数、评价
- 差值相对勾选的第一列（该列数值 − 第一列）。token 或墙钟任一侧缺失时，这一项显示「不可比」
- 不计算节省率。不同案例的提示词本来就可以不同，分屏直接显示各自 prompt
