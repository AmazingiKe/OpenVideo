# 0011 采用独立播放器与帧级拖动预览

## 状态

已接受

## 背景

标记和总结是独立工作区。把它们强行绑定到同一个媒体元素会让页面切换、布局和 Vidstack 生命周期相互干扰；需要共享的是视频时间语义，而不是播放器实例。旧拖动预览依赖固定 `320×180`、五秒间隔的缩略图，且下载流程会在媒体检查阶段同步生成拼板，无法满足可变帧率素材的精确定位，也会阻塞下载完成。

## 决策

- 标记和总结各自持有一个 Vidstack/`video` 实例。播放器只与所属工作区的时间线同步，不跨页面共享播放、暂停、音量、字幕或拖动状态。
- 正式播放继续由浏览器媒体栈完成；拖动期间不修改主播放器时间，松手后只提交一次跳转，并在 `requestVideoFrameCallback` 确认新画面已经提交合成后恢复原播放状态。
- 普通拖动先从分页故事板立即绘制清晰预览；指针停留 140ms 后才由 Mediabunny/WebCodecs Worker 解码原始帧细化画面。逐帧前进和后退仍直接请求真实帧，不经过故事板近似时间。
- Worker 在任意时刻最多保留正在解码的请求和一个最新待处理请求；过期位图在绘制前关闭，不得覆盖较新的指针位置。
- Worker 切换预览尺寸时只重建 Canvas sink，继续复用同一媒体输入和 32MB Range 缓存，避免尺寸自适应导致远端索引重新加载。
- `requestVideoFrameCallback` 报告的媒体时间是每个工作区中播放器、字幕、标记和时间引用的共同时间源，不用固定 FPS 推算可变帧率素材。
- 后端按需在低优先级单线程中生成 5×5 JPEG 分页故事板。单格最大 `640×360` 且不放大小分辨率源；一小时视频按五秒间隔生成 720 格，三小时视频按十秒间隔生成 1080 格，极长视频最多 1200 格。
- 每一页和清单使用 UUIDv7 持久化标识。前端只保留当前页及相邻页，最多缓存三页；页面 URL 使用不可变缓存策略，避免长视频把整张巨型纹理载入内存。
- 自定义 Canvas 预览是唯一的拖动视觉层；不向 Plyr 传入故事板，避免内置预览与 Canvas 争抢同一个播放器区域。
- 字幕偏移按视频保存，只影响播放时的字幕查找，不修改原始转写或标记。

## 性能门槛

每次取帧把模式、耗时、实际帧时间、Range 请求数和读取字节数写入名为 `openvideo.scrub-preview` 的 Performance Timeline。Storybook 的 `Media/Player/PerformanceProbe` 用于交互采样。

拖动预览性能需要持续在以下素材矩阵中验证：

| 素材 | 必验项 |
| --- | --- |
| 1080p H.264 | 首帧与连续拖动延迟、Range 请求 |
| 4K H.264/H.265 | 硬件解码、自动尺寸上限、回退 |
| 60fps、可变帧率 | 相邻帧时间戳、逐帧方向 |
| 长 GOP | 随机远距离拖动延迟 |
| 一到三小时文件 | 分页边界、末页残格、内存上限、持续拖动稳定性 |

性能矩阵未通过时，降低高清细化的 Canvas 预览尺寸；不降低故事板清晰度，也不在正式播放器中启用两套拖动渲染实现。

## 结果

两个工作区保持独立的播放器会话和布局，时间线仅驱动本工作区播放器。拖动画面不改变播放器尺寸，精确时间不再被 50ms 取整。Mediabunny 故障不会影响原生视频播放。

### 2026-09-02 本机验证

测试使用本地 Range 服务、无头 Chrome 与实际浏览器会话。数据为冷跳转和连续快速请求的代表值，不把 Mediabunny 内部逻辑读取误计为 HTTP Range。WebCodecs 使用 `prefer-hardware`，但浏览器没有提供可用于确认最终硬件解码路径的标准信号。

| 素材 | 取帧结果 | 结论 |
| --- | --- | --- |
| 1080p H.264 | 冷取帧 29–188ms；快速请求最终帧 33ms；首次 6 个 Range | 通过 |
| 4K H.264 | 154–719ms；实际浏览器 255–865ms；预览从 `1248×286` 自动降至 `799×183` | 未达到实时高清目标；保留尺寸自适应回退 |
| 4K H.265 | 实际浏览器 290ms；5 个 Range；WebCodecs 可解码 | 兼容通过，延迟待优化 |
| 1080p 60fps | 76–175ms；快速请求最终帧 49ms | 通过 |
| 720p 可变帧率 | 59–104ms；9.100s 请求落在真实 9.083s 帧 | 通过 |
| 1080p 长 GOP | 79–246ms；快速请求最终帧 67ms | 可用，冷跳转待优化 |
| 一小时 H.264 | 14–24ms；快速请求最终帧 6ms；强制回收后 JS 堆无增长 | 通过 |

连续请求只保留最新目标，帧位图会在淘汰或绘制后释放。4K H.264 的瓶颈主要位于源帧解码；降低输出画布尺寸能控制画布和位图成本，但不能降低 WebCodecs 对 4K 源帧的解码成本。因此 `scrub-proxy.mp4` 生成链路、接口与字段保持删除，普通拖动改用分页故事板承担首屏反馈，WebCodecs 只负责停留后的高清细化。只接受清单引用的 UUIDv7 页面，历史派生缓存不会参与拖动预览。

### 2026-09-04 长视频拖动调整

4K 和长 GOP 素材的源帧解码延迟不适合作为每个指针事件的首屏反馈，因此拖动路径改为“分页故事板即时显示、停留后高清细化、松手后单次正式跳转”。本机 FFmpeg 9.0 验证覆盖完整页和末页残格；后端单元测试固定验证一小时、三小时、极长视频上限和纵横比，前端单元测试固定验证跨页定位、过期帧丢弃与延迟细化。

这项选择与现有播放器和流媒体行业的 trick-play 做法一致：

- [Vidstack 缩略图文档](https://vidstack.io/docs/player/core-concepts/loading/#thumbnails)使用带时间范围与图集坐标的 WebVTT/JSON 缩略图。
- [Mux 时间线预览文档](https://www.mux.com/docs/guides/create-timeline-hover-previews)把固定时间间隔的视频帧组织为故事板和坐标元数据。
- [Apple HLS Authoring Specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/)要求 trick play 使用独立 I-frame 表示，说明拖动浏览不应反复驱动正式播放轨道。
- [MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)说明该接口可在 Dedicated Worker 中低层控制视频解码；[MDN `requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)提供实际提交合成帧的媒体时间，用于可靠恢复播放流程。
