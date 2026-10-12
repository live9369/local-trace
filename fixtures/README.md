# Fixtures（模拟数据）

这些 JSONL 为**明确标注的模拟事件**，用于开发与测试，**不能**冒充真实 CodeGraph 优化结果或真实 Cursor 联调数据。

字段形态参考官方 Hooks 文档与 Cursor 论坛对 `stop` token 字段的说明。

摄入方式：

```bash
clt init --project /path/to/project
clt ingest-fixture fixtures/simulated-baseline-turn.jsonl --project /path/to/project
```
