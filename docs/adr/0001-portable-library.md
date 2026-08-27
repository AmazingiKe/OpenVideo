# ADR 0001：便携资料库以业务文件为权威源

- 状态：已接受
- 日期：2026-08-24

## 背景

OpenVideo 资料库需要能够整体移动、人工查看和长期保存。SQLite 适合查询和任务协调，但不应成为用户成果唯一载体，否则数据库损坏或丢失会同时丢失素材元数据、分析成果和总结历史。

## 决策

资料库格式版本为 v2。`assets/{asset_id}` 下的固定业务文件是唯一权威源：

```text
library.json
openvideo.sqlite3
agent_checkpoints.sqlite3
assets/{asset_id}/
├─ meta.json
├─ media/
├─ artifacts/
│  ├─ transcript.json
│  ├─ transcription.json
│  └─ timeline.json
├─ markers.json
└─ summary/
   ├─ manifest.json
   ├─ index.md
   ├─ docs/
   ├─ assets/
   └─ conversations/{conversation_id}.json
```

- `library.json` 仅标识资料库及其格式版本；v1 不迁移并明确拒绝打开。
- `meta.json`、时间轴、标记、总结 manifest、Markdown 与对话文件保存全部用户成果。
- `openvideo.sqlite3` 保存业务文件的可重建查询投影，以及下载、分析和 Agent 任务等可丢弃运行状态。
- `agent_checkpoints.sqlite3` 只保存可丢弃的 Agent checkpoint。
- 业务修改先原子写入权威文件，再在 SQLite 事务中更新投影。投影失败不得回滚已经提交的业务文件。
- 打开资料库时按素材业务文件摘要增量校验。数据库缺失、损坏或 schema 不匹配时在 `temp` 中完整重建后原子替换。
- 单个素材文件损坏只隔离该素材并报告相对路径，不修改损坏文件，也不阻塞其他素材。
- 总结多文件修改以最后写入 `summary/manifest.json` 为提交点；数据库不得反向覆盖 manifest。
- 媒体大文件不参与索引摘要，只校验固定业务文件及其安全相对路径。

## 结果

删除 `openvideo.sqlite3` 后重新打开资料库，素材、转录、时间轴、标记、总结、媒体索引、对话和修改建议均可恢复。下载历史、分析任务、Agent run 与 checkpoint 允许丢失。

该方案不引入 Repository、DAO、事件溯源或文件监听器。外部手工修改在重新打开资料库后被识别。
