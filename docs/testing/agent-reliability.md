# 助手可靠性回归

先跑执行器、上下文、路由和 API 测试，再使用真实模型复测。测试不能只断言“返回了文本”，还要检查 SDK 落盘状态、下一轮能否读取历史，以及实际产物状态。

```powershell
./apps/backend/.venv/Scripts/python.exe -m pytest apps/backend/tests/test_agno_executor.py apps/backend/tests/test_agno_session_context.py apps/backend/tests/test_agent_intent_router.py apps/backend/tests/test_api_agents.py -q

$env:PYTHONPATH = "apps/backend/src"
$env:PYTHONUTF8 = "1"
./apps/backend/.venv/Scripts/python.exe apps/backend/scripts/evaluate_agent_conversation.py --output .artifacts/agent-check --rounds 24 --neural
```

真实评测使用当前配置的首个在线模型，以及配置中的模型角色；`--neural` 使用已安装的检索模型，不指定时使用关键词检索。输出目录必须不存在，避免覆盖之前的日志。

评测创建临时资料库，结束后清理。标记的审批、拒绝与撤销只发生在临时资料库；应用配置按项目规则保存在系统用户配置目录。

| 检查 | 通过条件 |
|---|---|
| 连续对话 | 请求完成或进入待审批，没有路由失败 |
| 工作流 | 普通问题必须直接完成，仅明确要求提案的场景进入待审批 |
| 历史 | 正常结束保留完成状态，重新打开上下文后仍可读取 |
| 记忆 | 多轮后仍能回答首轮指定的口令 |
| 检索范围 | 视频追问执行证据检索，聊天记忆只读取对话原文 |
| 提案 | 生成实际产物，审批后写入，撤销后恢复原状 |
| 取消与重试 | 重复请求不新建任务，取消后可以重新执行 |
| 循环边界 | 超限能够停止，终态后观察窗口内没有新增事件 |

`conversation.jsonl` 保存逐轮回答、工具事件及运行耗时，不记录 `reasoning.delta` 事件；`timings.csv` 保存每轮端到端和检索累计耗时；`summary.json` 保存检查结果。任一检查失败时脚本返回非零退出码。

早期对话使用 Agno 的 `read_chat_history` 内置能力按需读取，不自行实现记忆检索算法。工具执行次数交给 SDK 限制；额外的模型请求边界用于终止 SDK 跳过超限工具后仍继续请求模型的情况。

工具上限是整轮总预算。写入任务为必需提交保留调用机会，只做一次受限恢复；问答在取得必需资料后触及上限，可再进行一次关闭全部工具的回答。缺少必需结果的写入任务仍判为失败，不用普通文本代替提案。

默认使用 12 个场景循环 24 轮。固定素材只有文本证据，没有视频文件，因此不覆盖实际看帧、插图或转录模型。正确答案是否完整、引用是否真正支持结论和文字是否简洁，仍需查看对话日志，不把运行完成率当成任务质量评分。
