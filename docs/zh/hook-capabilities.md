# Hook 能力说明

## 已确认（官方文档）

来源：https://cursor.com/docs/hooks 、https://cursor.com/docs/reference/plugins

- Cursor 原生插件可通过 `hooks/hooks.json` 分发 Hooks；**不能**注册 Webview
- 公共字段：`conversation_id`、`generation_id`、`model` / `model_id` / `model_params`、`workspace_roots`、`transcript_path`
- 事件：`sessionStart/End`、`beforeSubmitPrompt`、`pre/postToolUse`、`postToolUseFailure`、`afterAgentResponse`、`afterAgentThought`、`stop`、`subagentStart/Stop`、`preCompact`、Shell/MCP/Read/Edit 专用事件
- 工具耗时：`duration`（ms）；会话/子代理：`duration_ms`
- `preCompact` 提供上下文窗口用量，**不是**账单 token
- 本采集器对权限类 Hook 恒返回 allow / continue，**不注入**上下文或修改工具输入

## 已确认但文档未完整（社区 / Cursor 员工说明）

来源：https://forum.cursor.com/t/how-to-obtain-token-usage-per-request/168317 、Langfuse Cursor 插件 README

- `stop` / `afterAgentResponse` 可带 turn 级 token 四字段
- 以 **stop** 为权威源；与 afterAgentResponse 数值相同，不可相加
- 父 Agent 本轮，不含 subagent
- 旧版 Cursor 可能缺失这些字段

## 待本机真实联调核实

以下需在真实 Cursor 中跑一次只读任务后核对（见 `verification.md`）：

1. 各事件实际 payload 与双发（通用 tool + Shell/MCP）情况
2. usage 字段是否稳定出现在 stop
3. `transcript_path` 是否非空及文件内容是否含 usage（预期通常不含）
4. 多根工作区 `workspace_roots` 行为

无法联调时，开发与测试使用 `fixtures/` 中**明确标注 simulated** 的数据。

## 不可用 / 不做

- 不通过私有数据库、认证截获或非公开网络接口补字段
- 不读取 Admin API（需云与密钥）
- 不采集思考正文作为统计依赖（默认隐私模式剥离）
