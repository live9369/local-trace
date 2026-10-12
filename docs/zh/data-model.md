# 数据结构

## 项目目录 `.trace/`

```text
.trace/
  config.json          # 项目配置（隐私开关、端口等）
  index.sqlite         # 可重建查询索引
  cases/<case-id>/
    case.json
    versions/vNNNN/
      version.json
      prompt.md         # 用户明确保存的案例提示词
      runs/<run-id>/
        run.json
        events/<writer-id>.jsonl
        summary.json
  exports/
  logs/
  runtime/
```

## 身份与层级

| 层 | 含义 |
|---|---|
| Case | 稳定测试问题；重命名不改 caseId |
| Version | 任务定义快照；首次运行时冻结；改 prompt/标准则新版本 |
| Run | 某版本的一次执行。案例列表勾选 2–4 个案例后，每列取该案例最近一条已完成 run |

系统案例 `case_uncategorized` 收纳未绑定会话。

## 事实源与索引

- JSON / JSONL 为事实源；用户评价与备注只写在 `run.json` / `case.json`
- SQLite 可 `clt rebuild-index` 重建；`deleted_ids` 防止删除后复活
- 事件按进程分片追加；容忍残缺尾行

## 导出

`clt export --case <id>` 生成目录含 `manifest.json`、`case/`、`runs.csv`。导入时 ID 冲突不静默覆盖。
