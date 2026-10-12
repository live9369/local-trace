# 验证结果与已知限制

## 自动化测试

在仓库根目录执行：

```bash
npm test
```

**结果（本交付）**：9 项通过，0 失败。

覆盖：

1. 重复事件去重；缺失 usage 不显示为 0  
2. 整轮 usage 不冒充步骤  
3. 版本冻结 / 新版本 / 历史归属  
4. 索引重建保留人工评价  
5. 默认隐私不保存敏感正文  
6. Fixture 端到端：建案例 → 采集 → 导出  
7. Skill `begin` / `end` 绑定当前会话  
8. 案例对比取最近一条已完成 run；拒绝未分类和非法数量  

另已冒烟：`clt install` / `doctor` / `start`（`/api/health` 200）/ `stop`。

## Fixture 说明

`fixtures/*.jsonl` 为**模拟数据**，用于开发验证，**不能**当作真实 CodeGraph 优化效果。

## 真实 Cursor 联调

**状态：未在本交付环境完成真实 Cursor Agent 联调。**

原因：实现与测试在无 Cursor GUI Hook 注入的环境下完成。请在本机按下列步骤冒烟：

1. `npm run build && node packages/app/dist/cli.mjs install --project <项目> --user-hooks`
2. Reload Window
3. `clt start --project <项目>`
4. `clt run begin --project <项目> --name smoke`，在 Cursor 发起一次只读 Agent 任务，然后 `clt run end --project <项目>`
5. 若已有 2–4 个案例：在案例列表勾选后点 A/B
6. `clt doctor --project <项目>` 确认最近事件
7. 看板打开运行详情，核对 token 是否出现、工具时间线是否合理

将脱敏后的 `stop` payload（去掉正文）可附到本文件「联调记录」小节。

### 联调记录

（空 — 待用户本机填写）

## 已知限制

- 原生插件无侧栏 Webview；看板为本地浏览器
- 子 Agent token、reasoning tokens 不可用
- 默认不验证实际用户输入与版本 prompt 一致
- 多 awaiting 运行时不自动绑定，会话进未分类
- macOS GUI 下 Node PATH：依赖 install 钉死的绝对路径
