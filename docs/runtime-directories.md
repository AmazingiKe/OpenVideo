# 本地运行目录

OpenVideo 将可变的本地运行内容与源码分开管理。以下目录默认位于仓库根目录，均不会提交到 Git。

```text
OpenVideo/
└─ runtime/
   ├─ tools/
   │  └─ ffmpeg/
   │     └─ bin/
   │        ├─ ffmpeg.exe
   │        └─ ffprobe.exe
   └─ models/
      ├─ faster-whisper/
      ├─ qwen3-asr/
      └─ sensevoice/
         └─ …模型缓存文件
```

## FFmpeg

FFmpeg 与 FFprobe 是第三方本地可执行程序，负责下载后的合并、转码、抽帧、媒体信息读取和音频提取。默认将两个 `.exe` 放入 `runtime/tools/ffmpeg/bin/`。

设置页选择工具根目录；应用会在其中的 `ffmpeg/bin/` 查找两个程序。环境变量 `OPENVIDEO_TOOLS_DIRECTORY` 可用于固定工具根目录。部署场景仍可通过 `OPENVIDEO_FFMPEG_PATH`、`OPENVIDEO_FFPROBE_PATH` 分别覆盖单个程序路径。

## faster-whisper

faster-whisper 是当前可执行的本地语音转写引擎。没有平台字幕时，应用会使用设置页保存的默认转录方案，也允许工作台按任务覆盖模型。模型文件缓存到 `runtime/models/faster-whisper/`。

转录模型目录与任务选项共用统一引擎接口。Qwen3-ASR 和 SenseVoice 分别预留 `qwen3-asr/`、`sensevoice/` 子目录；运行适配器未安装前，模型目录 API 会返回 `adapter_required`，任务不会静默回退到其他引擎。

设置页选择模型根目录，应用会在其中管理 `faster-whisper/` 等不同模型的子目录。环境变量 `OPENVIDEO_MODELS_DIRECTORY` 可用于固定模型根目录。

转录正文保存在资源的 `artifacts/transcript.json`。每次重新转录成功后会原子替换正文；失败时保留上一份可用结果。

最近一次任务的来源、引擎、参数、开始与完成时间、耗时、状态、累计次数和失败信息保存在 `artifacts/transcription.json`。资源根目录的 `meta.json` 同时保留状态与累计次数摘要，便于不打开数据库也能判断资源是否转录过。

## 资料库

资料库不属于应用运行目录。首次启动时必须由用户创建或打开一个外部资料库；应用只在用户配置中保存上次使用的路径，不会在 OpenVideo 目录内隐式创建资料库。

后台任务记录保存在资料库主数据库 `openvideo.sqlite3`，LangGraph 检查点保存在资料库根目录的 `agent_checkpoints.sqlite3`。两者都属于可丢弃运行状态，不是用户成果或应用配置；删除后不会影响业务文件恢复。
