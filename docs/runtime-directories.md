# 本地运行目录

OpenVideo 将可变的本地运行内容与源码分开管理。以下目录默认位于仓库根目录，均不会提交到 Git。

```text
OpenVideo/
├─ tools/
│  └─ ffmpeg/
│     └─ bin/
│        ├─ ffmpeg.exe
│        └─ ffprobe.exe
├─ models/
│  └─ faster-whisper/
│     └─ …模型缓存文件
└─ library/
   └─ …视频、缩略图、字幕和资料库数据库
```

## FFmpeg

FFmpeg 与 FFprobe 是第三方本地可执行程序，负责下载后的合并、转码、抽帧、媒体信息读取和音频提取。默认将两个 `.exe` 放入 `tools/ffmpeg/bin/`。

设置页只需选择包含两个程序的工具目录；环境变量 `OPENVIDEO_FFMPEG_DIRECTORY` 可用于固定该目录。部署场景仍可通过 `OPENVIDEO_FFMPEG_PATH`、`OPENVIDEO_FFPROBE_PATH` 分别覆盖单个程序路径。

## faster-whisper

faster-whisper 是本地语音转写引擎。没有平台字幕时，应用会使用它转写音频。默认情况下，按设置中的模型名下载并缓存到 `models/faster-whisper/`。

如已下载离线模型，可在设置页选择该模型文件夹，或设置 `OPENVIDEO_WHISPER_MODEL_PATH`。指定本地模型目录后不会使用默认缓存目录。

## 资料库

资料库保存用户数据，默认是 `library/`，但建议在设置页选择容量充足的独立磁盘目录。它与工具和模型目录相互独立，可单独迁移或备份。
