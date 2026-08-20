# OpenVideo

OpenVideo 当前是一个 Web 优先的视频获取与播放雏形。前端使用 React，后端使用 FastAPI，通过 yt-dlp 获取 Bilibili 与 YouTube 公开视频，并通过支持 HTTP Range 的本地接口供浏览器播放。

## 当前能力

- 接受 Bilibili、b23.tv、YouTube 与 youtu.be 的视频和播放列表地址
- 自动识别平台并探测播放列表，支持勾选条目后批量加入下载队列
- 异步串行执行下载，逐项展示读取信息、下载、处理、完成或失败状态
- 使用 yt-dlp 选择 H.264/AAC 优先的视频流，并调用 ffmpeg 合并为 MP4
- 将媒体资源持久化到 `library/videos/{asset_id}/`
- Web 端采用桌面优先的视频工作台：媒体库、播放器、转写/分析检查器与任务中心同屏协作
- 页面刷新后恢复媒体列表、手工时间点标记与标签；标记保存在对应媒体资产目录中
- 使用原生 HTML5 播放器播放，支持 HTTP 单区间 Range 和进度条拖动
- 对已就绪视频发起音频转写：优先复用平台字幕，缺失时用本地 faster-whisper 提取带时间戳文字，结果持久化为 `transcript.json`
- 生成重点片段、关键帧与视觉模型画面描述；可从转写、片段和标记回跳播放器时间点

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
2. 项目内 `tools/ffmpeg/bin/`（媒体库同级目录，免安装直接使用）
3. 系统 `PATH`

```powershell
# 推荐：把 ffmpeg 和 ffprobe 放到项目 tools/ffmpeg/bin 下
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

先启动 API：

```powershell
Set-Location apps/backend
uv run uvicorn openvideo.ui.api:app --host 0.0.0.0 --port 8000 --reload
```

再从仓库根目录启动 Web：

```powershell
pnpm dev:web
```

打开：

```text
http://127.0.0.1:5173
```

Vite 会把 `/api` 代理到 `http://127.0.0.1:8000`。

### 局域网访问

API 与 Vite 均监听 `0.0.0.0`，同一局域网内的设备可直接通过服务器 IP 访问：

```text
http://<服务器IP>:5173
```

API 地址为 `http://<服务器IP>:8000`。若需收紧跨域来源，可通过 `OPENVIDEO_CORS_ORIGINS` 指定允许的 Web 来源（逗号分隔）。

## 配置

可参考 `.env.example`：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENVIDEO_LIBRARY_PATH` | 当前进程目录下的 `library` | 媒体库存放位置 |
| `OPENVIDEO_FFMPEG_PATH` | 从 `PATH` 查找 | ffmpeg 完整路径 |
| `OPENVIDEO_FFPROBE_PATH` | 从 `PATH` 查找 | ffprobe 完整路径 |
| `OPENVIDEO_CORS_ORIGINS` | `*`（放行所有来源） | 允许访问 API 的 Web 来源，逗号分隔；局域网访问可保持默认 |
| `OPENVIDEO_WHISPER_MODEL` | `small` | 本地 ASR 模型大小，可选 `tiny`/`base`/`small`/`medium`/`large`，首次使用自动下载 |
| `OPENVIDEO_WHISPER_LANGUAGE` | `zh` | 本地 ASR 转写语言，留空则自动检测 |
| `OPENVIDEO_WHISPER_COMPUTE_TYPE` | `int8` | 本地 ASR 量化精度，CPU 上建议 `int8` |
| `VITE_API_BASE_URL` | 空字符串 | Web 直接访问的 API 根地址；开发模式通常留空使用代理 |

若从 `apps/backend` 启动且未配置媒体库路径，默认运行数据会在 `apps/backend/library`。希望统一保存在仓库根目录时，可在启动前设置：

```powershell
$env:OPENVIDEO_LIBRARY_PATH = (Resolve-Path ../..).Path + "\library"
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
