# 转写与助手窗口生命周期回归

关闭窗口只移除观察界面；已提交的后台任务继续执行。助手的“取消”仍调用显式取消接口，不能把断开事件流当成取消。现有转写接口没有取消操作，本次不增加取消语义。

## 下载并使用

- 转写弹窗直接提交一项后台转写任务，不再等弹窗内模型下载组件回调后才创建任务
- `download_model` 默认 `false`；只有用户点击“下载并使用”才传 `true`。普通请求缺少模型仍返回 409
- 模型下载许可随 `AnalysisJob` 持久化，旧资料库增量补列且旧任务保持 `false`，不重建资料库或扩大旧任务权限
- 后台优先读取平台字幕，确需本地识别时，在同一任务中准备已获许可的模型。安装使用已有锁和完整性检查
- 重复提交复用进行中的任务；下载失败保留原字幕，用户可重新提交。完成后刷新字幕与模型安装状态

## 核心回归

| 场景 | 预期 |
| --- | --- |
| 关闭 / 重开正在执行的助手 | 断开观察后恢复相同任务，不调用取消接口 |
| 尚未接受提交便重开 | 等待原提交完成再恢复历史，阻止重复提交，保留错误反馈 |
| 切视频 / 切会话 / 新建对话 | 迟到响应、事件和完成回调不覆盖新上下文 |
| 重连事件流 | 旧连接和重复序号不再重复追加文本 |
| 延迟加载默认思考设置 | 不打断已有任务 |
| 转写模型准备时离开页面 | 后台继续准备模型并转写，任务中心保留状态 |
| 长时间轮询 | 每次定时器结束移除监听器，仅保留当前等待项 |
| 慢后台 / 切换素材索引 | 同一观察器不堆叠请求，旧素材响应不污染当前状态 |
| 缺模型但未许可下载 | 维持 409，不隐式下载大型模型 |
| 旧库迁移与重开 | 保留历史数据，下载许可往返保存一致 |

## 执行

```sh
pnpm --filter @openvideo/web exec vitest run --project=unit \
  src/components/use_agent_panel.test.tsx \
  src/app/task_manager.test.tsx \
  src/shared/poll_transcription_job.test.ts \
  src/features/workbench/TranscriptionDialog.test.tsx \
  src/shared/api.test.ts

uv run --directory apps/backend pytest \
  tests/test_api_analysis.py tests/test_analysis_initialization.py \
  tests/test_library.py tests/test_analysis.py tests/test_analysis_integrity.py
```

这些测试使用延迟 Promise、伪时钟、API 替身和模型安装器替身，不发送付费模型请求或下载真实模型。不能据此声称真实转录精度、浏览器布局或指定视频的端到端验收已经通过。
