# 视觉分析状态回归

内容分析的任务完成状态只代表流程已结束，不代表逐帧理解了整段视频。视觉模型读取的是有限关键帧，字幕、OCR 与视觉结果仍是不同证据来源。

## 数据契约

- `MediaSegment.visual_analysis_status` 区分 `sampled`、`failed`、`no_frames`、`skipped`、`not_requested` 和 `unknown`。
- `sampled` 表示模型对该事件的抽样帧返回了非空描述；不是整段画面的覆盖保证。
- `AnalysisJob.visual_coverage` 记录事件数量与成功描述的采样帧数。事件比例不是时间覆盖率，也不是识别准确率。
- 局部视觉失败仍保留字幕、OCR 和可生成的文本摘要。预览、确认完成及持久化任务中的提示保留失败数量与采样限制。
- 历史产物没有状态记录时保持 `unknown`，不根据已有视觉描述倒推成功状态。
- SQLite 增量补列，不为此次升级重建数据库；旧待确认任务的时间轴摘要保持可验证。

## 重跑行为

显式选择视觉模型时，即使 `force=false`，已有时间轴也不会被当成该模型已完成分析的证据。当前时间轴没有足够的模型来源与输入摘要用于安全复用，因此每次新的视觉分析请求会重新执行；重复调用同一个正在运行的模型与策略仍复用该任务。

素材正在执行另一种任务、模型或策略时返回前置条件错误，避免把后台初始化当成视觉分析结果。

## 自动验证

在配置好开发依赖后运行：

```sh
uv run --directory apps/backend ruff check src tests
uv run --directory apps/backend pytest tests/test_analysis.py tests/test_analysis_pipeline.py tests/test_analysis_integrity.py tests/test_analysis_initialization.py tests/test_library.py tests/test_api_analysis.py tests/test_chapter_generation.py
```

回归覆盖全失败、局部失败、全部采样成功、空响应、无帧、策略跳过、未请求模型、旧数据、服务恢复、确认保存、重复迁移和运行中任务冲突。测试使用模型与媒体工具替身，不需要在线模型请求。

## 当前边界

本轮增加的是后端/API 状态与提示。章节生成界面目前会在完成时清空进度文案，尚未增加持久可见的覆盖提示。关键帧时间戳、完整模型来源缓存、节点连线与参数核对、真实教程基准评测留待后续验证；本轮测试不能证明真实模型已理解 UE 操作过程。
