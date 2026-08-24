# OpenVideo

OpenVideo 当前是一个 Web 优先的视频获取与播放雏形。前端使用 React，后端使用 FastAPI，通过 yt-dlp 获取 Bilibili 与 YouTube 公开视频，并通过支持 HTTP Range 的本地接口供浏览器播放。

## 项目理念

OpenVideo 源于一个真实的学习需求：面对一小时以上的数学、计算机图形学等课程视频，理解内容之外，整理笔记往往还要花费大量时间。这个项目希望把视频获取、精准分析、重点标记、内容总结与复习串联起来，帮助学习者快速掌握课程结构，记录真正关心的知识点，并随时回到对应片段复习。

标记点不只是播放书签，也是用户主动表达学习意图的分析锚点。系统可以围绕带标签的时间点提高分析权重，结合附近的语音、画面和上下文，详细总结公式推导、关键概念、案例或疑问，让自动分析服务于个人学习重点，而不是只生成一份千篇一律的全片摘要。

## 当前能力

- 接受 Bilibili、b23.tv、YouTube 与 youtu.be 的视频和播放列表地址
- 自动识别平台并探测播放列表，支持勾选条目后批量加入下载队列
- 异步串行执行下载，逐项展示读取信息、下载、处理、完成或失败状态
- 使用 yt-dlp 选择 H.264/AAC 优先的视频流，并调用 ffmpeg 合并为 MP4
- 通过 Web 创建、打开和切换可携带资料库，业务数据由 SQLite 持久化
- Web 端采用桌面优先的视频工作台：媒体库、播放器、转写/分析检查器与任务中心同屏协作
- 页面刷新后恢复媒体列表、手工时间点标记与标签；标记保存在对应媒体资产目录中
- 使用原生 HTML5 播放器播放，支持 HTTP 单区间 Range 和进度条拖动
- 对已就绪视频重复发起音频转写：优先复用平台字幕，缺失时用本地模型提取带时间戳文字，结果按资源保存为 JSON
- 支持全片时间轴与标记重点两种分析模式，按语音停顿和画面变化组织课程事件
- 为每个事件提取多张时序画面；视觉模型不可用时仍保留可回跳的音频分析结果
- 通过 LiteLLM 配置多个云端或本地模型，并按任务选择文本修正或视觉分析模型
- `重点`、`公式`、`疑问`、`案例` 标签会控制标记附近的分析目标与详细笔记

## 工程结构

```text
OpenVideo/
├── apps/
│   ├── backend/             FastAPI、yt-dlp、媒体库与 Range 播放
│   │   ├── src/openvideo/
│   │   │   ├── core/        数据模型、媒体库、字节范围
│   │   │   ├── tools/       平台来源、yt-dlp、ffmpeg/ffprobe
│   │   │   ├── ui/          HTTP API
│   │   │   └── application.py
│   │   └── tests/
│   └── web/                 React + TypeScript + Vite
├── docs/
└── library/                 运行时媒体文件，Git 已忽略
```

## 环境要求

- Python 3.13+
- uv
- Node.js 22+
- pnpm 11+
- ffmpeg 和 ffprobe

Python 依赖中已包含 yt-dlp，无需全局安装。ffmpeg/ffprobe 按以下顺序自动查找：

1. `OPENVIDEO_FFMPEG_PATH` / `OPENVIDEO_FFPROBE_PATH` 指定的完整路径
2. 项目内 `runtime/tools/ffmpeg/bin/`（免安装直接使用）
3. 系统 `PATH`

```powershell
# 推荐：把 ffmpeg 和 ffprobe 放到项目 runtime/tools/ffmpeg/bin 下
# 或放入 PATH，或指定完整路径：
$env:OPENVIDEO_FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
$env:OPENVIDEO_FFPROBE_PATH = "C:\path\to\ffprobe.exe"
```

Windows 可使用自己信任的 ffmpeg 发行版（例如 [gyan.dev 官方构建](https://www.gyan.dev/ffmpeg/builds/) 或 [BtbN GitHub 构建](https://github.com/BtbN/FFmpeg-Builds/releases)）。启动后访问 `/api/health` 可以检查三个媒体依赖是否就绪；只有 yt-dlp 和 ffmpeg 同时可用时，页面上的下载按钮才会启用。

## 安装

在仓库根目录安装 Web 依赖：

```powershell
pnpm install
```

安装 API 依赖：

```powershell
Set-Location apps/backend
uv sync
```

## 开发启动

从仓库根目录统一启动 API 和 Web：

```powershell
pnpm dev
```

开发日志统一写入 `runtime/logs/dev/`，每次启动覆盖上一次日志。按 `Ctrl+C` 会同时停止前后端服务。

打开：

```text
http://127.0.0.1:5173
```

Vite 会把 `/api` 代理到 `http://127.0.0.1:8000`。

## 配置

可参考 `.env.example`：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENVIDEO_LIBRARY_PATH` | 空 | 固定当前资料库；设置后 Web 不允许切换 |
| `OPENVIDEO_FFMPEG_PATH` | 从 `PATH` 查找 | ffmpeg 完整路径 |
| `OPENVIDEO_FFPROBE_PATH` | 从 `PATH` 查找 | ffprobe 完整路径 |
| `OPENVIDEO_TOOLS_DIRECTORY` | `runtime/tools` | 第三方工具根目录 |
| `OPENVIDEO_CORS_ORIGINS` | 本机 Vite 来源 | 允许访问 API 的本机 Web 来源，逗号分隔 |
| `OPENVIDEO_MODELS_DIRECTORY` | `runtime/models` | 本地模型根目录 |
| `OPENVIDEO_AI_MODELS` | `[]` | LiteLLM 模型配置 JSON 数组；设置后 Web 中的模型配置只读 |
| `VITE_API_BASE_URL` | 空字符串 | Web 直接访问的 API 根地址；开发模式通常留空使用代理 |

未配置 `OPENVIDEO_LIBRARY_PATH` 时，应用从系统用户配置目录的 `OpenVideo/preferences.json` 恢复上次资料库；路径失效时进入初始化页。Windows 的配置根目录为 `%LOCALAPPDATA%\OpenVideo`，应用生成的偏好与页面设置统一保存在该目录，不写入项目 `runtime` 或资料库。

推荐在 Web 设置页添加模型。`LiteLLM 模型` 使用 `供应商/模型` 格式，例如 `openai/gpt-5`、`anthropic/claude-sonnet-4-5` 或 `ollama/qwen2.5-vl`。自定义兼容网关可同时填写 API 地址。`input_modalities` 支持 `text`、`image`、`audio`、`video`；当前任务必须包含 `text`，关键帧分析还要求包含 `image`。

环境变量配置示例：

```powershell
$env:OPENVIDEO_AI_MODELS = '[{"model_id":"model-0198d12345677890abcdef1234567890","name":"主多模态模型","litellm_model":"openai/gpt-5","api_key":"your-key","api_base":null,"api_version":null,"input_modalities":["text","image"]}]'
```

## 测试与构建

后端：

```powershell
Set-Location apps/backend
uv run pytest
```

前端：

```powershell
pnpm test:web
pnpm build:web
```

## 当前边界

当前支持公开、无需登录的 Bilibili 与 YouTube 视频和播放列表，不支持会员/付费/DRM、Cookie 登录、直播、弹幕和评论。登录下载所需的能力接口已预留，但本版不会读取或保存用户 Cookie。下载任务只保存在当前 API 进程内；服务重启后未完成资源会被标记为失败，已完成资源仍可播放。

当前下载并发限制为 1，适合本地单用户雏形。视频标题和用户输入不会参与服务器文件路径，前端也不会获得媒体库绝对路径。

## 下一步

1. 增加 OCR 与场景切分策略，提升关键帧和画面描述质量
2. 支持媒体库搜索、标签筛选与批量管理
3. 持久化和恢复服务重启前未完成的下载、分析任务
4. 在复用现有 API 与媒体库的前提下，增加 Qt 原生工作台
