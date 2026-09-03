# OpenBrief 技术架构详解

> 本文是对开源项目 **OpenBrief** 的完整技术拆解，作为 OpenVideo 项目的架构参考资料。

---

## 目录

1. [文档说明](#1-文档说明)
2. [项目定位与形态](#2-项目定位与形态)
3. [技术栈总览](#3-技术栈总览)
4. [仓库结构与四层架构](#4-仓库结构与四层架构)
5. [视频解析（一）：导入与媒体处理](#5-视频解析一导入与媒体处理)
6. [视频解析（二）：字幕与语音转录](#6-视频解析二字幕与语音转录)
7. [关键澄清：它"分析"的到底是什么](#7-关键澄清它分析的到底是什么)
8. [知识点生成（一）：摘要](#8-知识点生成一摘要)
9. [知识点生成（二）：问答、播客、测验、校对翻译](#9-知识点生成二问答播客测验校对翻译)
10. [LLM 接入层](#10-llm-接入层)
11. [安全边界](#11-安全边界)
12. [数据存储与产物组织](#12-数据存储与产物组织)
13. [端到端时序图](#13-端到端时序图)
14. [评估与对 OpenVideo 的借鉴建议](#14-评估与对-openvideo-的借鉴建议)

---

## 1. 文档说明

### 1.1 分析对象

| 项目 | 值 |
| --- | --- |
| 项目名称 | OpenBrief |
| 源码位置 | `C:\Users\19252\Downloads\Compressed\openbrief-main` |
| 上游仓库 | `github.com/tantara/openbrief` |
| 桌面端版本 | `0.4.0`（`client/apps/tauri/package.json` 与 `src-tauri/Cargo.toml` 一致） |
| 许可证 | AGPL-3.0-only |

### 1.2 分析方法与边界

本文基于**静态源码阅读**得出，具体做法是：

- 完整读取核心 domain / services / hooks 层 TypeScript 源码
- 读取 Rust 可信边界层（`src-tauri/src/*.rs`）关键实现
- 交叉验证仓库文档（`README.md`、`AGENTS.md`、`docs/LOCAL_MODEL.md`）与实际代码

**未做的事情**（因此以下结论存在对应边界）：

- 未执行 `pnpm install`、`cargo build` 或任何构建/测试命令
- 未实际运行桌面应用观察运行时行为
- 未验证外部模型下载链接与 API 的当前可用性

因此，凡涉及"运行时表现""实际效果"的描述，均为**从代码逻辑推导**，而非实测。文中对不确定处会明确标注。

### 1.3 阅读建议

如果你只关心某一部分：

- 想了解**怎么解析视频** → 第 5、6、7 章
- 想了解**怎么生成知识内容** → 第 8、9、10 章
- 想了解**架构怎么组织** → 第 4、11、12 章
- 想直接看**能借鉴什么** → 第 14 章

第 13 章的时序图可以当作全文索引使用。

---

## 2. 项目定位与形态

### 2.1 产品定位

OpenBrief 的一句话定位是：

> 把视频和音频转换成清晰、可听的简报（Turn videos and audio into clear, listenable briefings）。

具体能力链条为：

```text
导入视频/音频/PDF
  → 提取转录文本
  → 生成有据可依的摘要
  → 针对内容问答
  → 转成语音收听
```

核心卖点是 **本地优先（local-first）**：媒体文件、转录、摘要、生成的音频都存放在用户机器上，AI 推理可以走云端 API，也可以走本地模型。

### 2.2 关键结论：这是桌面端应用

这是理解整个项目最重要的一点。

**主应用是 Tauri 桌面端**，位于：

```text
client/apps/tauri/
```

仓库中虽然还有 Next.js、Expo、TanStack Start 三个应用，但它们**不是桌面功能的等价实现**。

### 2.3 三端职责边界

| 应用 | 路径 | 实际职责 | 是否具备核心视频分析能力 |
| --- | --- | --- | --- |
| **Tauri 桌面端** | `client/apps/tauri` | 完整产品：导入、下载、转码、转录、摘要、问答、播客、测验、TTS、媒体库 | **是**（全部能力在此） |
| Next.js Web | `client/apps/nextjs` | 官网首页、下载页、分享页、认证、YouTube 上传/排行/管理、tRPC API | 否 |
| Expo 移动端 | `client/apps/expo` | 移动端应用外壳、分享查看、反馈 | 否 |
| TanStack Start | `client/apps/tanstack-start` | 另一套 Web 应用外壳 | 否 |

### 2.4 为什么核心能力无法迁移到 Web

桌面端的关键能力全部依赖浏览器沙箱不具备的权限：

| 能力 | 依赖 | 浏览器为何做不到 |
| --- | --- | --- |
| 视频下载 | yt-dlp 子进程 | 无法执行本地二进制 |
| 媒体探测/转码 | ffprobe / ffmpeg 子进程 | 同上 |
| 本地语音转录 | Whisper / Parakeet / Qwen3-ASR 本地权重 | 模型体积与本地文件访问 |
| 本地语音合成 | Supertonic / Qwen3-TTS sidecar | 同上 |
| 媒体库管理 | 任意路径文件读写 + SQLite | 无文件系统权限 |
| API 密钥存储 | 操作系统钥匙串 | 无系统钥匙串访问 |

因此，**研究 OpenBrief 的视频分析与内容生成实现，应当只看 `client/apps/tauri`**。

---

## 3. 技术栈总览

### 3.1 桌面端渲染层（TypeScript / React）

来源：`client/apps/tauri/package.json`

| 类别 | 技术 | 版本 |
| --- | --- | --- |
| UI 框架 | React | `19.1.4` |
| 语言 | TypeScript | `^5.9.3` |
| 构建 | Vite | `7.1.12` |
| 样式 | Tailwind CSS | `^4.1.16` |
| 测试 | Vitest | `^4.1.7` |
| 测试辅助 | Testing Library (react / jest-dom)、jsdom | — |
| 富文本 | Tiptap（`react` / `starter-kit` / `markdown`） | `^3.23.5` |
| 图标 | lucide-react、@lobehub/icons | — |
| Tauri API | `@tauri-apps/api` + 插件 `cli/dialog/log/opener/os/updater` | v2 |

### 3.2 Rust 可信边界层

来源：`client/apps/tauri/src-tauri/Cargo.toml`

| 用途 | crate | 版本 |
| --- | --- | --- |
| 桌面框架 | `tauri`（features: `macos-private-api`, `protocol-asset`, `tray-icon`, `image-png`） | 2 |
| HTTP 客户端 | `reqwest`（feature `stream`，用于流式响应） | `0.13.3` |
| 本地数据库 | `rusqlite`（feature `bundled`，内置 SQLite） | `0.32` |
| **本地语音识别** | `transcribe-rs`（feature `whisper-cpp`） | `0.3.8` |
| WAV 读写 | `hound` | `3.5` |
| 字幕解析 | `subtp`（SRT/VTT） | `0.2` |
| 序列化 | `serde` / `serde_json` | 1 |
| 异步流 | `futures-util` | `0.3` |
| 校验 | `sha1` | `0.10` |
| 日志 | `log` + `tauri-plugin-log` | — |
| 插件 | `shell` `2.3.5` / `os` `2.3.2` / `updater` `2.10.1` / `dialog` `2.7.1` / `cli` / `single-instance` `2.4.2` | — |
| macOS 专用 | `objc2-app-kit`（透明浮窗背景） | `0.3.2` |

Cargo workspace 包含两个成员：`.`（主应用）与 `helper`（辅助 sidecar）。

### 3.3 外部媒体工具

来源：`src-tauri/build.rs` 中的 `MEDIA_TOOL_NAMES`

```rust
const MEDIA_TOOL_NAMES: [&str; 3] = ["yt-dlp", "ffmpeg", "ffprobe"];
```

| 工具 | 用途 | 分发方式 |
| --- | --- | --- |
| **yt-dlp** | 视频下载、字幕列举与提取 | 随应用打包，支持运行时自动更新 |
| **ffmpeg** | 音频提取、视频转码、缩略图截取 | 通过 `@ffmpeg-installer/ffmpeg` 按平台打包 |
| **ffprobe** | 媒体元数据探测 | 通过 `@ffprobe-installer/ffprobe` 按平台打包 |

### 3.4 AI 模型

| 类型 | 支持的模型 | 运行位置 |
| --- | --- | --- |
| 语音识别 STT | Whisper（tiny/base/small/medium/large-v3-turbo）、Parakeet TDT 0.6B v3、Qwen3-ASR 0.6B/1.7B | 本地 |
| 语音合成 TTS | Supertonic 3、Qwen3-TTS | 本地 |
| 大语言模型 LLM | OpenAI GPT、Anthropic Claude、Google Gemini、OpenRouter、DeepSeek、任意 OpenAI 兼容端点 | 云端 API 或本地兼容服务 |
| 视频向量 | **暂无** | — |

### 3.5 工程与工具链

| 项目 | 值 |
| --- | --- |
| 包管理 | pnpm `11.0.9`（workspace） |
| 构建编排 | Turborepo `^2.5.8` |
| Node 版本 | `^22.21.0` |
| 代码规范 | ESLint 9 + Prettier 3（共享配置在 `tooling/`） |
| 依赖版本统一 | pnpm `catalog:` 机制 |

### 3.6 Web 端技术栈（配套，非核心）

来源：`client/apps/nextjs/package.json`

Next.js `^16.0.9`、tRPC `^11.7.1`、TanStack Query、Better Auth `1.4.0-beta.9`、Drizzle ORM `^0.44.7`、Vercel Postgres、AWS S3 SDK（用于 Cloudflare R2）、Zod `^4.1.12`。

---

## 4. 仓库结构与四层架构

### 4.1 目录结构

```text
openbrief-main/
├── README.md                   项目说明与运行方式
├── AGENTS.md                   架构约束与开发规范
├── docs/
│   ├── LOCAL_MODEL.md          本地模型存储规范
│   ├── release.md
│   └── WINDOWS_SIGNING.md
└── client/                     pnpm workspace 根目录
    ├── pnpm-workspace.yaml
    ├── turbo.json
    ├── apps/
    │   ├── tauri/              ★ 核心桌面应用
    │   │   ├── src/            React 渲染层
    │   │   ├── src-tauri/      Rust 可信边界
    │   │   └── scripts/        sidecar 与媒体工具准备脚本
    │   ├── nextjs/             Web 应用
    │   ├── expo/               移动端
    │   ├── tanstack-start/
    │   └── workers/
    ├── packages/
    │   ├── api/                共享 tRPC 路由
    │   ├── auth/               认证集成
    │   ├── db/                 Drizzle schema
    │   ├── model-card/         模型能力卡（语言支持、平台支持）
    │   ├── openbrief-content/  可移植内容 schema（Zod）
    │   ├── ui/                 共享 shadcn 组件
    │   └── validators/
    └── tooling/                eslint / prettier / tailwind / typescript 配置
```

### 4.2 桌面端源码结构

```text
client/apps/tauri/src/
├── main.tsx                    入口
├── App.tsx                     → AppShell
├── app/
│   ├── AppShell.tsx            ★ 应用协调层（约 3490 行）
│   ├── AppLayout.tsx
│   └── navigationShortcuts.ts
├── domain/                     ★ 纯逻辑层（无副作用）
│   ├── chat.ts                 聊天 Prompt 与消息
│   ├── summary.ts              摘要 Prompt、模板、时间戳
│   ├── podcast.ts              播客脚本 Prompt 与校验
│   ├── quiz.ts                 测验 Prompt 与校验
│   ├── transcript.ts           转录流水线命令
│   ├── transcript-actions.ts   校对/翻译 TSV 协议
│   ├── ingest.ts               导入计划
│   ├── helper-protocol.ts      Helper 命令/事件协议
│   ├── media-library.ts        核心数据类型与路径规则
│   ├── provider.ts             LLM 请求计划
│   ├── download-error.ts       下载错误分类
│   └── settings.ts / share.ts / platform.ts / compatibility.ts
├── services/                   ★ 副作用层
│   ├── ingestService.ts        导入流水线
│   ├── transcriptService.ts    转录流水线
│   ├── summaryChatService.ts   摘要/问答/播客/测验/校对
│   ├── providerService.ts      LLM 调用与续写
│   ├── providerAdapters.ts     各厂商响应适配与 SSE
│   ├── tauriProviderClient.ts  走 Rust 的可信 HTTP
│   ├── tauriHelperClient.ts    走 Rust 的 Helper 调用
│   ├── mediaLibraryRepository.ts  持久化仓储
│   ├── podcastService.ts / supertonicService.ts  TTS
│   ├── artifactExportService.ts   产物导出
│   └── ...（共约 30 个服务）
├── hooks/
│   ├── useMediaLibrary.ts      ★ 状态与任务编排（约 1729 行）
│   ├── useSettingsSnapshot.ts
│   ├── useVideoPlayback.ts
│   └── useTauriFileDrop.ts
├── features/                   功能 UI
│   ├── finder/                 媒体库与导入
│   ├── workbench/              阅读/摘要/问答工作台
│   ├── playlists/ settings/ voices/ onboarding/ tutorial/ faq/
│   └── transcript-overlay/     字幕浮窗
├── components/                 可复用组件
└── i18n/                       15 种语言（含 zh_cn / zh_tw）
```

### 4.3 Rust 层结构

```text
client/apps/tauri/src-tauri/src/
├── lib.rs              应用装配与命令注册
├── main.rs             入口
├── helper.rs           Helper 命令执行与事件解析
├── helper_sidecar.rs   媒体工具命令计划（argv 构造）
├── provider.rs         LLM HTTP 请求与 SSE 流
├── credentials.rs      API 密钥安全存取
├── trusted_paths.rs    路径校验、文件复制、产物导出
├── media_library.rs    SQLite 持久化与 bundle manifest
├── media_tools.rs      yt-dlp 更新策略
├── ingest.rs           导入 URL 分类与本地导入计划
├── stt_models.rs       STT 模型目录与下载
├── qwen_asr.rs         Qwen3-ASR 路由
├── fluidaudio.rs       Parakeet 路由
├── supertonic.rs       TTS 生成
├── workspace.rs        多工作区
├── storage_usage.rs    存储占用统计
├── headless_download.rs  无界面下载
└── platform_plugins.rs
```

### 4.4 四层架构职责

`AGENTS.md` 明确规定了分层规则，代码实现也严格遵守：

```text
┌─────────────────────────────────────────────┐
│ features/ + components/     功能界面与组件    │
├─────────────────────────────────────────────┤
│ hooks/                      状态与任务编排    │
├─────────────────────────────────────────────┤
│ services/                   副作用（IO/网络） │
├─────────────────────────────────────────────┤
│ domain/                     纯函数逻辑        │
╞═════════════════════════════════════════════╡
│ Rust src-tauri/             可信边界          │
└─────────────────────────────────────────────┘
```

各层的允许与禁止：

| 层 | 允许 | 禁止 |
| --- | --- | --- |
| `domain/` | 构造 Prompt、构造命令、校验模型返回、生成路径、纯计算 | 网络请求、文件读写、调用 Tauri、依赖 React |
| `services/` | 调用 Tauri 命令、发起网络请求、读写配置、编排流水线 | 直接持有 React state、直接渲染 |
| `hooks/` | 管理任务状态、进度、错误、驱动持久化 | 直接执行子进程、直接持有密钥 |
| `features/` | 渲染界面、处理交互 | 承载业务规则 |
| Rust | 文件路径、凭证、子进程、模型、数据库、HTTP | 把密钥或权限根目录暴露给渲染层 |

`AGENTS.md` 中的两条硬性约束尤其重要：

> - Renderer code must not receive raw provider secrets or authority-bearing filesystem roots.
> - Helper subprocess execution must use argv arrays, not shell-concatenated commands.

即：**渲染层不得接触原始密钥与权限根路径；子进程必须用 argv 数组而非 shell 字符串拼接**。这两条在第 11 章会看到具体落实。

---

## 5. 视频解析（一）：导入与媒体处理

本章描述从"用户给出一个视频"到"得到可播放媒体 + 元数据 + 缩略图"的全过程。

### 5.1 两种导入入口

| 入口 | 触发 | 主要实现 |
| --- | --- | --- |
| 在线 URL | 粘贴链接 | `services/ingestService.ts` → `importYoutubeUrl` |
| 本地文件 | 文件选择/拖拽 | `services/ingestService.ts` → `importLocalFile` |

### 5.2 URL 分类与白名单

导入前先做 URL 分类，实现在 `domain/helper-protocol.ts` 的 `classifyVideoProviderUrl`。

支持的域名白名单是显式写死的：

```ts
export const supportedVideoProviderDomains: Record<VideoProviderKind, string[]> = {
  youtube: ["youtube.com", "youtu.be"],
  tiktok:  ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  twitch:  ["twitch.tv", "clips.twitch.tv"],
  vimeo:   ["vimeo.com", "player.vimeo.com"],
};
```

分类结果有三种：

| 结果 | 含义 | 后续行为 |
| --- | --- | --- |
| `single-video` | 单个视频链接 | 正常下载 |
| `unsupported-playlist-or-channel` | 播放列表或频道 | 拒绝，提示原因 |
| `unsupported-provider` | 不在白名单 | 拒绝，提示支持的平台 |

值得注意：内部命令名虽然固定叫 `download_youtube`，但通过 `sourceKind` 字段区分四个平台，并非只支持 YouTube。

### 5.3 yt-dlp 下载参数

命令 argv 由 Rust 侧 `helper_sidecar.rs` 的 `download_youtube_plan` 构造：

```text
--newline
--no-playlist
--extractor-args  youtube:player_client=default,-web,-web_safari
--format          <见下方>
--merge-output-format mp4
--write-thumbnail
--convert-thumbnails jpg
--write-info-json
--ffmpeg-location <打包的 ffmpeg 目录>
-o <输出模板>
<url>
```

其中 format 选择串（为可读性换行展示）：

```text
bestvideo[ext=mp4][vcodec^=avc1][height<=720][fps<=30]+bestaudio[ext=m4a][acodec^=mp4a]
/ best[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=720][fps<=30]
/ bestvideo[ext=mp4][height<=720][fps<=30]+bestaudio[ext=m4a]
/ best[ext=mp4][height<=720][fps<=30]
/ best[height<=720][fps<=30]
/ bestvideo[ext=mp4][vcodec^=avc1][height<=720]+bestaudio[ext=m4a][acodec^=mp4a]
/ best[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=720]
/ best[height<=720]
/ best
```

**为什么要这样限制规格**，这是本项目一个值得学习的工程取舍：

| 约束 | 目的 |
| --- | --- |
| `vcodec^=avc1`（H.264） | Tauri WebView 各平台原生支持最好，避免解码失败 |
| `acodec^=mp4a`（AAC） | 同上 |
| `height<=720` | 控制文件体积与下载时间；转录不需要高分辨率 |
| `fps<=30` | 降低转码与播放开销 |
| `ext=mp4` + `merge-output-format mp4` | 统一容器格式，简化后续处理 |
| 多级 `/` 回退 | 严格条件不满足时逐级放宽，保证尽量能下载成功 |

`--extractor-args youtube:player_client=default,-web,-web_safari` 是针对 YouTube 反爬策略的规避配置，排除了容易被限制的 web 客户端。

同时下载的附带产物：

- `--write-thumbnail --convert-thumbnails jpg` → 平台原始封面（JPG）
- `--write-info-json` → 视频元数据 JSON（标题、作者等）

### 5.4 本地文件导入

本地文件**不直接引用用户原始路径**，而是通过 Rust 命令复制进应用媒体库：

```ts
const copied = await invokeCommand<LocalFileImportResult>(
  "copy_local_file_into_library",
  { sourcePath: request.sourcePath },
);
```

返回：

```ts
type LocalFileImportResult = {
  assetId: string;
  originalFileName: string;
  libraryRelativePath: string;
  fileSizeBytes: number;
  sourceType?: MediaSourceType;   // video | audio | pdf
  pageCount?: number;             // PDF 页数
};
```

这样设计的收益：

- 原文件被移动或删除不影响应用
- 每个资源成为自包含目录，可打包迁移（详见 12.3）
- 路径权限由 Rust 掌握，渲染层只见相对路径

支持的扩展名（`domain/ingest.ts`）：

```ts
supportedVideoFileExtensions = ["mp4", "m4v", "mov", "webm", "mkv"]
supportedAudioFileExtensions = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"]
supportedPdfFileExtensions   = ["pdf"]
```

三类媒体分别落到 `videos/` `audios/` `pdfs/` 三个库目录。

### 5.5 ffprobe 媒体探测

无论在线还是本地，下载/复制完成后都会探测：

```text
ffprobe -v error -print_format json -show_format -show_streams <input>
```

结果结构（`domain/helper-protocol.ts`）：

```ts
{
  command: "probe_media";
  durationSeconds: number;
  fileSizeBytes: number;
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  resolution?: string;
  frameRate?: number;
  pixelFormat?: string;
  videoProfile?: string;
  videoLevel?: number;
}
```

这些字段既用于界面展示，也用于判断是否需要转码。

### 5.6 ffmpeg 转码

当探测结果显示视频不适合 WebView 直接播放时，执行转码（`transcode_video_plan`）：

```text
ffmpeg -hide_banner -y
  -i <input>
  -map 0:v:0
  -map 0:a:0?
  -c:v libx264
  -preset veryfast
  -crf 23
  -vf fps=30
  -pix_fmt yuv420p
  -c:a aac
  -b:a 128k
  -movflags +faststart
  <output>
```

关键参数解释：

| 参数 | 作用 |
| --- | --- |
| `-map 0:a:0?` | 尾部 `?` 表示音轨可选，无音轨的视频不会因此失败 |
| `-preset veryfast` | 牺牲部分压缩率换取转码速度，桌面端体验优先 |
| `-crf 23` | 恒定质量模式的常用默认值 |
| `-pix_fmt yuv420p` | 最通用的像素格式，兼容性最好 |
| `-movflags +faststart` | 把 moov atom 移到文件头部，播放器无需读完整文件即可起播 |

### 5.7 ffmpeg 缩略图

```text
ffmpeg -hide_banner -y
  -ss 00:00:01
  -i <video>
  -frames:v 1
  -vf scale=640:-2
  <output>
```

默认取第 1 秒的单帧，缩放到宽 640（`-2` 表示高度自动保持宽高比且为偶数）。

时间点可通过 payload 的 `timestampSeconds` 覆盖，Rust 侧 `ffmpeg_seek_timestamp` 会做有限性与非负校验。

> **重要**：这里生成的缩略图**仅用于媒体库和界面展示，不会进入任何模型推理**。这一点在第 7 章会展开。

### 5.8 导入流水线完整顺序

以在线视频为例，`ingestService.importYoutubeUrl` 的实际执行序列：

```text
1. classifyVideoProviderUrl(url)        分类与白名单校验
2. createYoutubeDownloadCommand()       构造下载命令
3. helper: download_youtube             yt-dlp 下载
4. helper: probe_media                  ffprobe 探测
5. ensureWebviewPlayableVideo()         必要时 ffmpeg 转码
6. helper: extract_thumbnail            ffmpeg 截取封面
7. createYoutubeVideoAsset()            组装 VideoAsset
8. 写入媒体库快照
```

每一步都通过 `logRuntimeInfo` / `logRuntimeError` 记录耗时与状态，形成 `before X` / `after X` 成对日志。

### 5.9 下载错误分类与恢复建议

`domain/download-error.ts` 把 yt-dlp 的原始错误分类成结构化类型，并给出可执行的恢复动作。

例如：

| 原始错误特征 | 分类 | 用户提示 | 恢复动作 |
| --- | --- | --- | --- |
| `Your yt-dlp version ... is older than` | `yt-dlp-outdated` | yt-dlp 已过期 | `update-yt-dlp` |
| `SABR streaming` + `403 Forbidden` | `youtube-sabr-forbidden` | YouTube 拒绝下载 | 先更新 yt-dlp，再考虑浏览器 Cookie |
| 通用 403 | `forbidden` | 站点拒绝下载 | 更新 yt-dlp 或使用登录态 Cookie |

这种"错误 → 分类 → 用户可读信息 → 可点击恢复动作"的三段式设计，比直接抛出原始 stderr 对用户友好得多，值得借鉴。

---

## 6. 视频解析（二）：字幕与语音转录

这是"视频分析"的实质环节：把音视频变成**带时间戳的文本**。

### 6.1 核心策略：字幕优先，本地 STT 回退

实现在 `services/transcriptService.ts` 的 `extractTranscript`。

决策逻辑：

```ts
function shouldAttemptCaptionExtraction(request) {
  return (
    request.sourcePreference !== "local-stt" &&              // 用户没强制要求本地转录
    mediaSourceTypeForAsset(request.video) === "video" &&    // 是视频（音频/PDF 不走字幕）
    request.video.sourceKind !== "local-file" &&             // 不是本地导入
    Boolean(request.video.originalUri)                       // 有原始 URL
  );
}
```

四个条件全部满足才尝试拉取平台字幕。完整流程：

```text
┌─ 满足字幕条件？
│
├─ 是 ──→ yt-dlp 提取字幕
│         ├─ 成功且有内容 ──→ 返回（sourceKind: "youtube-captions"）
│         ├─ 无内容 & 用户强制要字幕 ──→ 抛出 provider_captions_unavailable
│         └─ 失败 ──→ 记录失败事件，继续往下
│
└─ 否 ─┬─→ ffmpeg 提取 16kHz 单声道 WAV
       └─→ 本地 STT 引擎转录
           └─→ 返回（sourceKind: "local-stt"）
```

这个策略的价值：

| 维度 | 字幕路径 | 本地 STT 路径 |
| --- | --- | --- |
| 速度 | 秒级 | 分钟级（取决于时长与模型） |
| CPU/GPU 占用 | 极低 | 高 |
| 时间戳精度 | 平台提供，通常够用 | 模型输出，可能更精确 |
| 可用性 | 依赖平台是否有字幕 | 始终可用 |
| 准确度 | 人工字幕高、自动字幕一般 | 取决于模型规格 |

优先走字幕能显著降低常见场景的等待时间与资源占用，这是很实际的产品决策。

### 6.2 字幕语言列举

在提取前可以先列出可用字幕语言：

```text
yt-dlp --newline --skip-download --no-playlist --list-subs <url>
```

Rust 侧 `parse_caption_languages` 解析 stdout，区分：

```ts
type CaptionLanguage = {
  code: string;
  label: string;
  kind: "manual" | "automatic";   // 人工字幕 / 自动生成字幕
};
```

界面据此让用户选择具体语言，而不是盲目使用 `en`。

### 6.3 字幕提取

```text
yt-dlp --newline
  --skip-download
  --write-subs
  --write-auto-subs
  --sub-format vtt
  --sub-langs <语言列表，默认 en>
  -o <输出模板>
  <url>
```

要点：

- `--skip-download` 只取字幕，不重复下载视频
- `--write-subs` + `--write-auto-subs` 同时接受人工与自动字幕
- `--sub-format vtt` 统一为 WebVTT，Rust 侧用 `subtp` crate 解析

Rust 的 `helper.rs` 中还有一个补偿逻辑 `enrich_helper_result_from_trusted_context`：如果 sidecar 返回的结果缺少 `segments`，Rust 会在可信侧重新解析字幕文件补齐。这是对旧版 sidecar 的兼容处理。

### 6.4 音频提取（STT 前置）

```text
ffmpeg -hide_banner -y
  -i <video>
  -vn
  -acodec pcm_s16le
  -ar 16000
  -ac 1
  <output.wav>
```

| 参数 | 值 | 原因 |
| --- | --- | --- |
| `-vn` | 去掉视频流 | STT 只需要音频 |
| `-acodec pcm_s16le` | 16-bit PCM | Whisper 系模型的标准输入 |
| `-ar 16000` | 16 kHz | 语音识别通用采样率 |
| `-ac 1` | 单声道 | 减少数据量，语音识别不需要立体声 |

Rust 侧 `helper_sidecar.rs` 的 `transcribe_audio` 会强校验这一格式，不符合则报 `transcribe_audio_requires_extracted_16khz_mono_wav`。

### 6.5 STT 引擎路由

引擎选择在 `domain/transcript.ts` 的 `createTranscribeAudioCommand` 中根据模型路径完成：

```ts
const requestedModelPath = request.whisperModelPath ?? "models/whisper-small-default.bin";
const prefersParakeet = requestedModelPath.includes("fluidaudio/parakeet-tdt-0.6b-v3");
const qwenAsrModelId = qwenAsrModelIdForPath(requestedModelPath);

return {
  command: "transcribe_audio",
  enginePreference: qwenAsrModelId ? "qwen3-asr" : "auto",
  ...(prefersParakeet ? { modelId: "parakeet-tdt-0.6b-v3" } : {}),
  ...(qwenAsrModelId ? { modelId: qwenAsrModelId } : {}),
  modelPath: prefersParakeet ? "models/ggml-small.bin" : requestedModelPath,
  ...
};
```

Rust 侧 `helper.rs` 按优先级分派：

```text
transcribe_audio 请求
  ├─ should_route_transcribe_to_qwen()?       → qwen_asr::run_transcribe_audio
  ├─ should_route_transcribe_to_fluidaudio()? → fluidaudio::run_transcribe_audio
  └─ 否则                                      → helper sidecar（whisper.cpp）
```

三条引擎路径：

| 引擎 | 实现 | 平台限制 |
| --- | --- | --- |
| Whisper | `transcribe-rs` (whisper.cpp)，helper sidecar 内 | 跨平台 |
| Parakeet TDT | FluidAudio sidecar（CoreML 模型） | 主要面向 Apple 平台，`stt_models.rs` 有可用性判定 |
| Qwen3-ASR | LocalAI Python sidecar（HuggingFace / MLX 快照） | 视平台与依赖 |

### 6.6 统一数据结构：TranscriptSegment

**这是整个架构的枢纽**。无论字幕还是哪种 STT 引擎，最终都归一化为：

```ts
export type TranscriptSegment = {
  id: string;
  startSeconds: number;
  endSeconds?: number;
  text: string;
  sourceKind: TranscriptSourceKind;   // "youtube-captions" | "local-stt"
  words?: TranscriptWord[];           // 可选的词级时间戳
};

export type TranscriptWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};
```

它的意义在于**彻底解耦**：

```text
        多种输入源                     多种转录引擎
   ┌────────┬────────┬───────┐   ┌─────────┬──────────┬───────────┐
   │ YouTube│ 本地文件│  音频  │   │ Whisper │ Parakeet │ Qwen3-ASR │
   └────┬───┴────┬───┴───┬───┘   └────┬────┴─────┬────┴─────┬─────┘
        └────────┴───────┴────────────┴──────────┴──────────┘
                                │
                                ▼
                   TranscriptSegment[]  ← 唯一接口
                                │
        ┌───────┬───────┬───────┼───────┬────────┐
        ▼       ▼       ▼       ▼       ▼        ▼
       摘要    问答    播客    测验   校对     翻译
```

下游六种内容生成功能**完全不需要知道**转录来自 yt-dlp 还是 Whisper。这是本项目最值得借鉴的设计决策之一。

`words` 字段（词级时间戳）目前定义了但在摘要/问答链路中未见使用，推测是为将来的精确高亮或强制对齐（Qwen3-ForcedAligner）预留。

### 6.7 Helper 协议

渲染层与 Rust 之间通过版本化协议通信（`domain/helper-protocol.ts`）：

```ts
export const helperProtocolVersion = 1;

export type HelperCommandName =
  | "probe_media"        // ffprobe 探测
  | "download_youtube"   // yt-dlp 下载
  | "extract_thumbnail"  // ffmpeg 截图
  | "list_captions"      // yt-dlp 列字幕语言
  | "extract_captions"   // yt-dlp 提取字幕
  | "extract_audio"      // ffmpeg 提音频
  | "transcode_video"    // ffmpeg 转码
  | "transcribe_audio"   // 本地 STT
  | "cancel_job";        // 取消任务
```

事件类型：

```ts
type HelperEvent =
  | { type: "job_started";   jobId; command }
  | { type: "job_progress";  jobId; command; progressPercent; message? }
  | { type: "job_completed"; jobId; command; result }
  | { type: "job_failed";    jobId; command; errorCode; message }
  | { type: "job_cancelled"; jobId; command: "cancel_job"; targetJobId };
```

错误码是封闭枚举：

```ts
type HelperErrorCode =
  | "unsupported_url"
  | "invalid_command"
  | "cancelled"
  | "helper_unavailable";
```

### 6.8 进度映射

转录由多个子命令串联，`useMediaLibrary.ts` 把各命令的局部进度映射到全局百分比：

```ts
function transcriptProgressRange(command: HelperCommandName) {
  switch (command) {
    case "extract_captions":  return { start: 2,  end: 35 };
    case "extract_audio":     return { start: 40, end: 55 };
    case "transcribe_audio":  return { start: 60, end: 99 };
    default:                  return { start: 1,  end: 5  };
  }
}
```

映射公式：

```ts
progress = range.start + (range.end - range.start) * (子命令进度 / 100)
```

这样用户看到的是**单调递增的整体进度**，而不是每个子步骤都从 0 跳到 100。

`upsertTranscriptJob` 还额外保证运行中进度只增不减：

```ts
progressPercent: nextJob.status === "running"
  ? Math.max(job.progressPercent, nextJob.progressPercent)
  : nextJob.progressPercent,
```

### 6.9 字幕失败的特殊处理

有一个细节体现了对用户体验的考虑（`transcriptJobPatchFromEvent`）：

```ts
if (helperEvent.type === "job_failed") {
  if (helperEvent.command === "extract_captions") {
    return {
      status: "running",              // 不标记为失败
      preferredSource: "local-stt",   // 切换来源标记
      progressPercent: 35,            // 推进到字幕阶段末尾
      errorMessage: undefined,        // 清除错误
    };
  }
  // 其他命令失败才真正标记 failed
}
```

即：**字幕提取失败不算任务失败**，只是自动切换到本地 STT 继续。用户不会看到一个刺眼的错误提示，然后又莫名其妙地继续跑。

### 6.10 事件去重

同一事件可能通过 `onEvent` 回调和 `eventsForJob()` 轮询被记录两次，因此有去重键：

```ts
function transcriptPipelineEventKey(event) {
  // 按事件类型生成稳定键，例如：
  // helper_event:job_progress:job-1:45:downloading
  // helper_event:job_completed:job-1
}
```

配合 `Set<string>` 保证每个事件只被处理一次。

---

## 7. 关键澄清：它"分析"的到底是什么

这一章单独列出，因为它是最容易被误解的部分。

### 7.1 结论

> **OpenBrief 当前的"视频分析"是 transcript-first（转录优先），而非视觉理解。**

它分析的是**视频里说了什么**，不是**视频里看到了什么**。

### 7.2 有什么 / 没有什么

| 能力 | 是否具备 | 说明 |
| --- | --- | --- |
| 语音内容理解 | ✅ | 通过字幕或 STT |
| 时间轴定位 | ✅ | 每段都有 `startSeconds` |
| 视频元数据 | ✅ | 标题、作者、时长、编码 |
| 封面图 | ✅ 但仅展示 | 不进入模型推理 |
| **帧级视觉理解** | ❌ | 无 |
| **镜头/场景切分** | ❌ | 无 |
| **画面 OCR / 幻灯片识别** | ❌ | 无 |
| **图像 embedding 检索** | ❌ | 无 |
| **多模态模型直接输入视频/帧** | ❌ | 无 |
| **人物、动作、物体识别** | ❌ | 无 |

### 7.3 证据

**证据一：Prompt 中只有文本**

`domain/summary.ts` 的 `createSummaryPrompt` 组装的 userPrompt 字段为：

```text
VIDEO_TITLE / VIDEO_URL / VIDEO_ID / SOURCE_KIND
SUMMARY_TEMPLATE / LENGTH_MODE / TARGET_LANGUAGE
LAST_AVAILABLE_TIMESTAMP
THUMBNAIL_IMAGE_URL          ← 仅当缩略图是 http URL 时才带
TIMESTAMPED_TRANSCRIPT       ← 主体内容
```

`THUMBNAIL_IMAGE_URL` 只是一个**文本 URL 字符串**，配套的 System Prompt 规则是：

> - Use only provided thumbnails, images, frames, or slide URLs.
> - Do not invent image URLs or describe visuals that were not provided.

即模型被允许在 Markdown 里**引用**这个图片链接，但模型本身**没有看到图片内容**。

**证据二：请求体中没有图像**

`domain/provider.ts` 的 `createProviderBody` 对所有 provider 构造的都是纯文本消息：

```ts
// OpenAI 系
messages: [
  { role: "system", content: systemPrompt },
  { role: "user",   content: userPrompt },
]

// Gemini
contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }]
```

没有 `image_url`、没有 `inline_data`、没有任何多模态载荷。

**证据三：缩略图只截 1 帧**

`extract_thumbnail_plan` 固定 `-frames:v 1`，且默认只取第 1 秒。这显然不是为分析设计的采样策略。

**证据四：README 自己说了**

模型支持表格中：

| Model type | Supported | TODO |
| --- | --- | --- |
| Video embedding | **None** | Frame and clip embeddings for semantic search |

路线图中同样列着未完成项：

> - [ ] Add video embedding for frame and clip semantic search across the library.

### 7.4 这意味着什么

对以下类型的视频，OpenBrief 的分析能力会明显受限：

- 无旁白的演示或操作录屏
- 内容主要在图表、代码、幻灯片上的技术分享
- 依赖画面才能理解的教程（如"点这里，然后点那里"）
- 音乐、体育、风景等非语言主导内容
- 画面中有关键文字但未被念出的场景

对以播讲、访谈、课程、评论为主的视频，转录优先策略则完全够用，且成本远低于视觉方案。

### 7.5 对 OpenVideo 的启示

如果 OpenVideo 需要真正的视觉理解，需要在现有链路上补充：

```text
现有：视频 → 音频 → 转录 → LLM
补充：视频 → 关键帧采样 → (VLM 描述 | OCR | CLIP embedding) → 与转录时间轴对齐 → 多模态 Prompt
```

好消息是：OpenBrief 的 `TranscriptSegment` 时间轴结构天然可以承载视觉信息——只要新增一种以时间戳为键的视觉描述流，就能与现有转录融合，而下游的摘要/问答/测验逻辑几乎不用改。

---

## 8. 知识点生成（一）：摘要

从本章开始进入"知识点生成"部分。

### 8.1 生成链路总览

```text
useMediaLibrary.generateSummary()          ← 状态与任务管理
   └→ summaryChatService.generateSummary()  ← 编排
        ├→ domain/summary.createSummaryPrompt()   ← 构造 Prompt（纯函数）
        ├→ providerService.complete()             ← 调用 LLM
        └→ domain/summary.createSummaryDocument() ← 组装结果文档
```

### 8.2 Prompt 的双层结构

这是本项目 Prompt 工程的核心写法：**System Prompt 定义规则，User Prompt 提供数据**。

```text
┌──────────────────────────────────────────────┐
│ System Prompt                                 │
│  · 角色定义                                    │
│  · 核心规则（不许编造、去除广告…）               │
│  · 时间戳规则                                  │
│  · 图片规则                                    │
│  · 输出结构骨架                                │
│  · 长度模式指令（动态追加）                      │
│  · 目标语言指令（动态追加）                      │
│  · 时间戳链接契约（动态追加）                     │
├──────────────────────────────────────────────┤
│ User Prompt                                   │
│  · 本次视频的元数据字段                          │
│  · 带时间戳的转录全文                            │
└──────────────────────────────────────────────┘
```

好处是：用户可以在设置里覆盖 System Prompt（改变风格与规则），而 User Prompt 的数据结构保持稳定，元数据和时间戳始终能正确传入模型。

### 8.3 System Prompt 的四组规则

默认模板 `YOUTUBE_BLOG_SUMMARY_SYSTEM_PROMPT` 位于 `domain/summary.ts`，共约 60 行，分四组：

**（1）核心规则**

- 只返回最终 Markdown，不要输出计划、推理或"以下是摘要"之类的话
- 所有论断必须基于提供的转录、元数据、时间戳和图片
- 不得编造事实、引用、时间戳、图片、标题、说话人姓名、链接或视觉细节
- 用清晰直接的博客式散文，短段落优先，仅在提升可扫读性时使用要点
- 保留重要的细微差别、示例、数字、人名、主张与结论
- 移除填充词、重复表达、开场废话、口播广告、订阅提醒、抽奖信息与无关跑题，且**不要说明自己移除了这些**
- 保持中立，除非讲者本人在批评某事

**（2）时间戳规则**

- 只使用转录或元数据中存在的时间戳
- 永远不要发明时间戳，永远不要使用晚于 `LAST_AVAILABLE_TIMESTAMP` 的时间戳
- 使用 OpenBrief 内部链接而非外部视频链接
- 时间戳链接的文字只放时间标签本身，不要把整句话包进链接
- 每个主要章节的标题附近必须有一个主时间戳链接

**（3）图片规则**

- 只使用提供的缩略图/图片/帧/幻灯片 URL
- 不得发明图片 URL，不得描述未提供的视觉内容
- 没有合适图片时直接省略，不要写占位符

**（4）输出结构**

```markdown
# [吸引人的文章标题]
（可选：有缩略图时插入图片）
简介段落：3-5 句，说明视频讲什么、为什么重要、核心结论

## Table of Contents
| Section | Starts At | What You Will Learn |
| --- | --- | --- |
| [章节标题](#anchor) | [MM:SS](#openbrief-timestamp-SECONDS) | 一句话 |
（4-8 行，按转录的自然话题边界划分）

## Summary
2-4 段综合全片：先主论点，再重要支撑点，最后结论或实践意义

## Key Sections
### [章节标题] - [MM:SS](#openbrief-timestamp-SECONDS)
（可选图片）
2-5 段博客式散文
**Key points:**
- 高信息量要点
- 具体的例子/数字/主张/结论
- 可选的第三点

## Key Takeaways
5-8 条具体的要点

## Notable Quotes
1-3 条简短原文引用（不值得保留时整节省略）

## Final Thought
一段话收尾
```

### 8.4 User Prompt 的字段

```text
VIDEO_TITLE: <标题>
VIDEO_URL: <URL 或 "not provided">
VIDEO_ID: <资源 ID>
SOURCE_KIND: <youtube | tiktok | twitch | vimeo | local-file>
SUMMARY_TEMPLATE: <模板名>
LENGTH_MODE: <Short | Default | Long | Explain simply>
TARGET_LANGUAGE: <目标语言>            ← 仅指定时出现
LAST_AVAILABLE_TIMESTAMP: 12:34 (754 seconds)
THUMBNAIL_IMAGE_URL: <URL>            ← 仅缩略图为 http URL 时出现

TIMESTAMPED_TRANSCRIPT:
Chunk 1 (starts 0:00 / 0 seconds)
[0:00 | 0s] 第一段文本
[0:12 | 12s] 第二段文本
...
Chunk 2 (starts 4:30 / 270 seconds)
...
```

`LAST_AVAILABLE_TIMESTAMP` 是一个很聪明的防幻觉设计：明确告诉模型时间轴的上界，配合 System Prompt 中"永远不要使用晚于它的时间戳"的规则，能有效抑制模型编造超出视频长度的时间点。

### 8.5 转录段的格式设计

```ts
export function formatTranscriptSegment(segment: TranscriptSegment) {
  return `[${formatTimestamp(segment.startSeconds)} | ${
    Math.floor(segment.startSeconds)
  }s] ${segment.text}`;
}
```

输出形如：

```text
[12:34 | 754s] 这一段视频里讲话的内容
```

同时提供两种时间表示：

| 部分 | 形式 | 用途 |
| --- | --- | --- |
| `12:34` | 人类可读 | 模型在正文里直接引用作为链接文字 |
| `754s` | 整数秒 | 模型构造 `#openbrief-timestamp-754` 链接目标 |

这样模型不需要自己做时分秒换算——换算恰恰是 LLM 容易出错的地方。

### 8.6 四种摘要模板

```ts
export const videoSummaryTemplates: VideoSummaryTemplate[] = [
  { id: "youtube-blog",        label: "YouTube blog report", ... },
  { id: "documentary-report",  label: "Documentary report",  ... },
  { id: "lecture-notes",       label: "Lecture notes",       ... },
  { id: "transcript-brief",    label: "Transcript brief",    ... },
];
```

关键实现细节：**它们不是四套独立 Prompt，而是同一主 Prompt 追加差异化指令**。

```ts
systemPrompt: [
  YOUTUBE_BLOG_SUMMARY_SYSTEM_PROMPT,   // 共享基座
  "",
  "Lecture/study additions:",           // 差异部分
  "- Prioritize concepts, definitions, examples, procedures, and conclusions.",
  "- Make Key Sections useful as study notes while still preserving blog-style prose.",
  "- Add review questions in Key Takeaways when they are grounded in the transcript.",
  "- Avoid inventing curriculum structure that is not supported by the source.",
].join("\n")
```

各模板的差异指令：

| 模板 | 追加的侧重 |
| --- | --- |
| `youtube-blog` | 无（基座本身） |
| `documentary-report` | 围绕人物、地点、事件、主张、转折点组织；场景级上下文；证据导向措辞；必要时在 Key Takeaways 中加事实核查清单 |
| `lecture-notes` | 优先概念、定义、示例、流程、结论；Key Sections 兼具学习笔记功能；加复习题；不要发明源中没有的课程结构 |
| `transcript-brief` | 保持紧凑高信息量；转录短时减少章节；偏向直接综合而非穷尽覆盖 |

这种"基座 + 增量"的写法维护成本很低：修改核心规则只需改一处。

### 8.7 长度模式

```ts
type SummaryLengthMode = "short" | "default" | "long" | "explain-simply";
```

通过追加自然语言指令实现：

| 模式 | 指令要点 |
| --- | --- |
| Short | 保持结构的前提下尽量精简，表格行/章节/要点取最小可用数量 |
| Default | 平衡深度：足以让多数读者不必看视频，但不要变成转录重写 |
| Long | 完整覆盖全片脉络，转录支持时保留更多示例、细节、证据和时间戳章节 |
| Explain simply | 使用平实语言，从上下文解释专业术语；保持有据可依，不要过度简化超出转录的主张 |

注意：这里**没有字数或 token 的硬约束**，完全依赖模型对自然语言指令的理解。

### 8.8 多语言输出

```ts
export const summaryOutputLanguageOptions = [
  { code: "source", label: "Target language" },       // 跟随源语言
  { code: "en",     label: "English",  outputLanguage: "English" },
  { code: "ko",     label: "Korean",   outputLanguage: "Korean" },
  { code: "ja",     label: "Japanese", outputLanguage: "Japanese" },
  { code: "zh-CN",  label: "Chinese (Simplified)",  outputLanguage: "Chinese (Simplified)" },
  { code: "zh-TW",  label: "Chinese (Traditional)", outputLanguage: "Chinese (Traditional)" },
  { code: "es" }, { code: "fr" }, { code: "de" }, { code: "pt-BR" },
];
```

指定后 System Prompt 会追加：

```text
Target language:
- Rewrite the source language transcript into a Markdown summary in Chinese (Simplified).
- Preserve proper nouns, product names, cited titles, and timestamps from the source.
```

即"理解源语言 → 直接输出目标语言"，**一次调用完成**，不做"先摘要再翻译"两步。这样省一次调用，但也意味着翻译质量与摘要质量耦合。

### 8.9 时间戳回链闭环

这是 OpenBrief 最有产品价值的设计之一。

**生成端**：Prompt 明确契约

```ts
function createSummaryTimestampLinkInstruction() {
  return [
    "OpenBrief timestamp link contract:",
    `- Use ... [MM:SS](${summaryTimestampHrefPrefix}SECONDS) or [HH:MM:SS](${summaryTimestampHrefPrefix}SECONDS).`,
    "- SECONDS must be an integer from the transcript timestamp, not a formatted time string.",
    "- Use it for section timestamp labels, paragraph leads, and high-signal moments...",
    "- Do not wrap prose in timestamp links; keep prose editable...",
    "- Do not use VIDEO_URL&t=SECONDS for in-app timestamp links.",
  ].join("\n");
}
```

生成的链接形如：

```markdown
[12:34](#openbrief-timestamp-754)
```

**兜底端**：自动把裸时间戳转成链接

```ts
export function createClickableSummaryTimestampMarkdown(markdown: string) {
  let insideCodeFence = false;
  return markdown.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      insideCodeFence = !insideCodeFence;   // 跟踪代码块状态
      return line;
    }
    if (insideCodeFence) return line;       // 代码块内不处理
    return linkBareSummaryTimestamps(line);
  }).join("\n");
}
```

匹配规则：

```ts
/(^|[\s|({])(\d{1,3}:\d{2}(?::\d{2})?)(?=\s*(?:$|[|)\]},.;!?]))/g
```

即使模型没按契约输出链接，只写了 `12:34`，也会被自动转成可点击链接。**同时正确跳过代码块**，避免把代码里的 `12:34` 误伤。

**解析端**：

```ts
export function parseSummaryTimestampHref(href: unknown): number | undefined {
  const rawValue = href.startsWith(summaryTimestampHrefPrefix)
    ? href.slice(summaryTimestampHrefPrefix.length)
    : href.startsWith(legacySummaryTimestampHrefPrefix)   // 兼容旧格式
      ? href.slice(legacySummaryTimestampHrefPrefix.length)
      : undefined;
  if (rawValue === undefined) return undefined;
  const seconds = Number(rawValue);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
```

注意它同时兼容旧格式 `openbrief://timestamp/754`，说明格式演进时做了向后兼容。

**完整闭环**：

```text
转录段 startSeconds: 754
   ↓ formatTranscriptSegment
"[12:34 | 754s] 文本"
   ↓ LLM 按契约生成
"[12:34](#openbrief-timestamp-754)"
   ↓ 用户点击
parseSummaryTimestampHref → 754
   ↓
视频播放器 seek 到 754 秒
```

**结果是摘要与原视频之间形成双向可导航关系**，这比单纯生成一段文字有价值得多。

### 8.10 重要局限：没有分层摘要

这是需要重点指出的一个设计局限。

代码里确实有分块：

```ts
export function chunkTranscriptSegments(
  segments: TranscriptSegment[],
  maxCharacters = 2400,
): TranscriptChunk[] { ... }
```

但看它怎么被使用：

```ts
userPrompt: [
  // ...元数据字段
  "TIMESTAMPED_TRANSCRIPT:",
  ...chunks.map((chunk) =>
    [
      `Chunk ${chunk.index + 1} (starts ${formatTimestamp(chunk.startSeconds)} / ${
        Math.floor(chunk.startSeconds)
      } seconds)`,
      chunk.text,
    ].join("\n"),
  ),
].join("\n"),
```

**所有 chunk 被拼接进同一个 userPrompt，一次性发送**。

所以这里的"分块"只是**给转录加了章节标记**，让模型更容易感知话题边界，**并没有减少上下文长度**。

对比真正的分层摘要：

```text
OpenBrief 当前做法：
  全部转录 → 一次 LLM 调用 → 完整摘要

典型 map-reduce 做法：
  转录分块 → 每块独立摘要（并行 N 次调用）
          → 合并块摘要 → 最终摘要（1 次调用）
```

**后果**：

| 视频时长 | 大致转录量 | 影响 |
| --- | --- | --- |
| < 30 分钟 | 数千 token | 正常 |
| 30-90 分钟 | 一至数万 token | 接近部分模型上限，成本上升 |
| > 2 小时 | 数万 token 以上 | 可能超出上下文窗口，或触发 `max_tokens` 截断 |

代码中确实有截断续写机制（见 10.6），能缓解**输出**截断，但无法解决**输入**超限。

---

## 9. 知识点生成（二）：问答、播客、测验、校对翻译

### 9.1 聊天问答

**Prompt 构造**（`domain/chat.ts`）异常简洁：

```ts
export const DEFAULT_CHAT_SYSTEM_PROMPT =
  "Answer only from the provided local video context. Say when the context is insufficient.";

export function createChatPrompt({ video, question, contextMode, summary, transcript, systemPromptOverride }) {
  const context =
    contextMode === "summary"
      ? summary?.markdown ?? "No summary is available yet."
      : transcript.map(formatTranscriptSegment).join("\n");

  return {
    contextMode,
    systemPrompt: systemPromptOverride?.trim() || DEFAULT_CHAT_SYSTEM_PROMPT,
    userPrompt: [
      `Video title: ${video.title}`,
      `Context mode: ${contextMode}`,
      "",
      "Context:",
      context,
      "",
      `Question: ${question}`,
    ].join("\n"),
  };
}
```

**两种上下文模式对比**：

| 维度 | `summary` 模式 | `transcript` 模式 |
| --- | --- | --- |
| 上下文内容 | 当前摘要 Markdown | 全部带时间戳转录 |
| Token 消耗 | 低 | 高 |
| 响应速度 | 快 | 慢 |
| 细节覆盖 | 只覆盖摘要提到的 | 覆盖全部原话 |
| 适用问题 | "这个视频主要讲什么" | "他在第几分钟提到了 X" |

**局限一：这不是 RAG**

代码中不存在：

- 文本 embedding 生成
- 向量索引或向量数据库
- 基于问题的语义检索
- Top-K 片段召回
- 重排序（rerank）
- 引用来源验证

当前是：

```text
问题 + 完整上下文 → LLM
```

而非：

```text
问题 → 向量检索 → 召回相关片段 → LLM（带引用）
```

**局限二：没有真正的多轮上下文**

`ChatMessage` 类型有 `sessionId` 字段，`useMediaLibrary` 也维护 `activeChatSessionIdsByVideoId` 并保存全部历史消息。但回看 `createChatPrompt`，它接收的参数只有：

```ts
{ video, question, contextMode, summary, transcript, systemPromptOverride }
```

**没有历史消息参数**。也就是说：历史消息被存储、被展示、被持久化，但**不会被重新发送给模型**。

因此当前实现更接近"针对同一视频上下文的一组独立单轮问答"，而非有记忆的多轮对话。用户问"那他后来怎么说的"，模型无法理解"他"指谁。

`resetChatSession` 会生成新 sessionId，用于在界面上分隔对话组：

```ts
const nextSessionId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
```

### 9.2 播客生成

播客是唯一的**两阶段**生成功能。

#### 阶段一：LLM 生成结构化脚本

`domain/podcast.ts` 的 `createPodcastScriptPrompt`：

```ts
systemPrompt: [
  "You write two-speaker podcast scripts for OpenBrief.",
  "Return only valid JSON. Do not include markdown fences.",
  "Keep every turn suitable for text-to-speech and avoid stage directions.",
].join("\n"),
```

第三条"避免舞台指示"很关键——因为脚本要直接送进 TTS，`(笑)` `[停顿]` 这类标注会被念出来。

userPrompt 结构：

```text
Create a conversational podcast summary.   ← 或 calm audiobook brief
Title: <标题>
Source type: <video | audio | pdf>
Source: <current summary | source transcript | active transcript translation>
Length: <见下表>
Output language: <语言 或 "match the source">
Speaker A: <A 的名字>
Speaker B: <B 的名字>

Return JSON with this exact shape:
{"title":"...","description":"...","turns":[{"speakerId":"A","text":"...","anchor":{"startSeconds":0}}]}

Source material:
<摘要 Markdown 或 转录全文>
```

三档长度：

```ts
const lengthGuidance: Record<PodcastLengthMode, string> = {
  short:   "6 to 8 concise turns, about 3 to 5 minutes",
  default: "14 to 18 focused turns, about 8 to 10 minutes",
  long:    "24 to 32 detailed turns, about 15 to 20 minutes",
};
```

三种素材来源：

| `sourceKind` | 素材 |
| --- | --- |
| `current-summary` | 当前摘要的 Markdown |
| `transcript` | 原始转录 |
| `active-transcript-translation` | 当前激活的转录翻译版本 |

#### 阶段二：解析与严格校验

**这是本项目处理 LLM 结构化输出的标准范式，值得完整学习。**

第一步，容错解析 JSON：

```ts
export function parsePodcastScriptJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);   // 去掉可能的代码围栏
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");                             // 找第一个 {
  const end = candidate.lastIndexOf("}");                           // 找最后一个 }
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("podcast_script_json_missing");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
```

即使模型违反指令加了 ```` ```json ```` 围栏，或在 JSON 前后加了寒暄，也能提取出来。

第二步，逐项校验：

```ts
export function validatePodcastScriptResponse(value, request): PodcastScriptDocument {
  if (!isRecord(value)) throw new Error("podcast_script_invalid");

  const rawTurns = Array.isArray(value.turns) ? value.turns : [];
  if (rawTurns.length < 4) throw new Error("podcast_script_too_short");

  const turns = rawTurns.map((turn, index) => {
    if (!isRecord(turn)) throw new Error("podcast_turn_invalid");
    if (turn.speakerId !== "A" && turn.speakerId !== "B") {
      throw new Error("podcast_turn_speaker_invalid");
    }
    const text = typeof turn.text === "string" ? turn.text.trim() : "";
    if (!text) throw new Error("podcast_turn_text_empty");
    if (text.length > 1200) throw new Error("podcast_turn_text_too_long");

    const anchor = normalizePodcastAnchor(turn.anchor, request.video);
    return {
      id: `turn-${String(index + 1).padStart(4, "0")}`,   // 服务端重新编号
      speakerId,
      speakerLabel: speakers.get(speakerId)?.label ?? `Speaker ${speakerId}`,
      text,
      ...(anchor ? { anchor } : {}),
    };
  });
  ...
}
```

校验规则汇总：

| 规则 | 错误码 | 理由 |
| --- | --- | --- |
| 必须是对象 | `podcast_script_invalid` | 基本类型防护 |
| 至少 4 轮 | `podcast_script_too_short` | 少于 4 轮不成对话 |
| speakerId 只能 A/B | `podcast_turn_speaker_invalid` | 只配置了两个声音 |
| 文本非空 | `podcast_turn_text_empty` | 空文本会让 TTS 报错 |
| 文本 ≤ 1200 字符 | `podcast_turn_text_too_long` | 防止单段 TTS 超时或爆内存 |
| anchor 秒数 ≤ 视频时长 | 静默丢弃 | 防止幻觉时间戳 |
| anchor 页码 ≤ 总页数 | 静默丢弃 | PDF 场景同理 |

anchor 校验的实现：

```ts
function isValidSeconds(value: number | undefined, durationSeconds?: number) {
  return typeof value === "number" && value >= 0 &&
    (typeof durationSeconds !== "number" || value <= durationSeconds);
}
```

注意 anchor 不合法时是**静默丢弃**而非抛错——因为 anchor 是可选增强，不值得让整个播客生成失败。这个"关键字段严格抛错、可选字段静默降级"的区分很有分寸。

#### 阶段三：本地 TTS 合成

```ts
const result = await invokeCommand<PodcastTtsResult>(
  "generate_supertonic_podcast_tts",
  {
    request: {
      assetLibraryPath: request.video.libraryPath,
      podcastId: request.podcast.id,
      modelId: request.podcast.tts.modelId,
      language: request.podcast.tts.languageCode,
      speakers: request.podcast.tts.speakers.map(podcastSpeakerPayload),
      turns: request.podcast.script.turns.map((turn) => ({
        id: turn.id,
        speakerId: turn.speakerId,
        text: turn.text,
      })),
      scriptMarkdown: request.podcast.script.markdown,
      manifestJson: JSON.stringify(request.podcast, null, 2),
    },
  },
);
```

Rust 侧逐轮生成 WAV 并合并，返回：

```ts
type PodcastTtsResult = {
  podcastId: string;
  audioPath: string;          // 合并后的 podcast.wav
  scriptPath: string;         // script.md
  manifestPath: string;       // podcast.json
  turnAudioPaths: string[];   // 每轮独立音频
  turnTimings: PodcastTurnTiming[];   // 每轮在总音频中的起止时间
  modelId: string;
  durationSeconds: number;
  sizeBytes: number;
};
```

`turnTimings` 让界面能在播放时高亮当前对话轮次。

产物布局：

```text
{videos|audios|pdfs}/{assetId}/podcast/{podcastId}/
├── podcast.json          清单
├── script.md             脚本 Markdown
└── audio/
    ├── podcast.wav       合并音频
    └── turns/
        ├── 0001-speaker-a.wav
        ├── 0002-speaker-b.wav
        └── ...
```

任务分两阶段上报状态：

```ts
type PodcastGenerationStage = "script" | "tts" | "complete";
```

### 9.3 测验与闪卡生成

`domain/quiz.ts`，模式与播客高度一致。

**System Prompt**：

```ts
export const DEFAULT_QUIZ_SYSTEM_PROMPT = [
  "You create grounded study quizzes for OpenBrief.",
  "Return only valid JSON. Do not include markdown fences.",
  "Use only the supplied source material. Do not invent facts.",
  "If no specific area of interest is provided, create the strongest general quiz you can from the source.",
  "For general quizzes, cover the most important concepts, relationships, examples, and practical takeaways with a balanced spread across the material.",
  "When possible, include anchors with startSeconds/endSeconds for audio or video, or pageStart/pageEnd for PDFs.",
].join("\n");
```

**两种题型的 JSON 契约**：

```ts
// multiple-choice
'{"title":"...","description":"...","items":[{"question":"...","options":["...","...","...","..."],"correctOptionIndex":0,"explanation":"...","anchor":{"startSeconds":0}}]}'

// flash-card
'{"title":"...","description":"...","items":[{"front":"...","back":"...","explanation":"...","anchor":{"startSeconds":0}}]}'
```

**校验规则**：

| 规则 | 错误码 |
| --- | --- |
| 顶层必须是对象 | `quiz_invalid` |
| items 非空 | `quiz_empty` |
| 每个 item 是对象 | `quiz_item_invalid` |
| 选择题：问题非空、选项 ≥ 2、正确索引指向存在的选项 | `quiz_multiple_choice_invalid` |
| 闪卡：正反面均非空 | `quiz_flash_card_invalid` |
| 题目数量归一化到 1-50 | 静默截断 |
| anchor 越界 | 静默丢弃 |

数量归一化：

```ts
export function normalizeQuestionCount(value: number) {
  return Math.min(50, Math.max(1, Math.trunc(value)));
}
```

且实际取用时会截断到请求数量：

```ts
const items = rawItems.slice(0, requestedCount).map(...)
```

即模型多生成了也只取前 N 个，保证结果可预期。

选项还做了清洗：

```ts
const options = Array.isArray(item.options)
  ? item.options
      .map((option) => (typeof option === "string" ? option.trim() : ""))
      .filter(Boolean)        // 去掉空选项
      .slice(0, 6)            // 最多 6 个
  : [];
```

### 9.4 转录校对与翻译

这两个功能共用一套机制，是本项目**处理长列表 LLM 转换**的范式。

#### TSV 协议而非 JSON

```ts
// 校对
"Output format:",
"segment_id<TAB>corrected_text",

// 翻译
"Output format:",
"segment_id<TAB>start_timestamp<TAB>translated_text",
"The start_timestamp column must match the matching input segment exactly.",
```

**为什么用 TSV 而不是 JSON**：

| 维度 | TSV | JSON |
| --- | --- | --- |
| Token 开销 | 极低（无括号、引号、字段名） | 高 |
| 部分输出可用性 | **每行独立，截断后前面的行仍可用** | 截断即整体不可解析 |
| 转义复杂度 | 低 | 需处理引号、换行转义 |
| 结构表达力 | 弱（只适合平铺表格） | 强 |

对"N 个片段各输出一行"这种平铺场景，TSV 明显更合适。**尤其是截断容错这一点**，直接支撑了下面的断点续传机制。

#### 输入格式

```ts
...segments.map((segment) =>
  [
    segment.id,
    formatTimestamp(segment.startSeconds),
    segment.text.replace(/\s+/g, " ").trim(),    // 压缩空白
  ].join("\t"),
),
```

注意 `replace(/\s+/g, " ")`——把所有连续空白压成单个空格，防止原文中的换行破坏 TSV 行结构。

#### 解析：两种严格程度

**校对（宽松）**：

```ts
export function parseTranscriptSegmentTsv(providerText: string) {
  const textById = new Map<string, string>();
  for (const line of providerText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, ...columns] = trimmed.split("\t");
    // 智能判断：第二列如果长得像时间戳，就跳过它
    const textParts =
      columns.length > 1 && isTranscriptTimestamp(columns[0]?.trim())
        ? columns.slice(1)
        : columns;
    const text = textParts.join("\t").trim();
    if (id && text) textById.set(id.trim(), text);
  }
  return textById;
}
```

即使模型多输出了一列时间戳也能正确处理。

**翻译（严格，要求时间戳对齐）**：

```ts
export function parseTimestampAlignedTranscriptSegmentTsv(providerText, expectedSegments) {
  const expectedTimestampById = new Map(
    expectedSegments.map((s) => [s.id, formatTimestamp(s.startSeconds)]),
  );
  const textById = new Map<string, string>();

  for (const line of providerText.split(/\r?\n/)) {
    const [rawId, rawTimestamp, ...textParts] = line.trim().split("\t");
    const id = rawId?.trim();
    const timestamp = rawTimestamp?.trim();
    const expectedTimestamp = id ? expectedTimestampById.get(id) : undefined;

    // 三重校验：id 存在 + 时间戳完全匹配 + 有文本
    if (!id || !expectedTimestamp || timestamp !== expectedTimestamp || textParts.length === 0) {
      continue;   // 不匹配直接丢弃这一行
    }
    textById.set(id, textParts.join("\t").trim());
  }
  return textById;
}
```

翻译时要求时间戳必须精确匹配，是为了防止模型在翻译过程中打乱、合并或平移片段——这在跨语言场景（如中英语序差异）中是真实风险。

#### 断点续传机制

**这是本项目最实用的工程设计之一**（`services/summaryChatService.ts`）：

```ts
const maxTranscriptTransformAttempts = 3;

async function completeTranscriptTransformWithResume({ ... }) {
  const textById = new Map<string, string>();
  let nextIndex = findFirstMissingTranscriptSegmentIndex(segments, textById);
  let lastFailureMessage = "provider_request_failed";

  for (let attempt = 0;
       attempt < maxTranscriptTransformAttempts && nextIndex < segments.length;
       attempt += 1) {

    const remainingSegments = segments.slice(nextIndex);   // ★ 只发剩余部分
    let latestSnapshot = "";
    const prompt = createPrompt(remainingSegments);

    const result = await providerService.complete({
      ...,
      streamingMode: true,
      onTextSnapshot: (text) => { latestSnapshot = text; },   // ★ 保留流式快照
    });

    // ★ 即使请求失败，也用已收到的流式内容
    const providerText = result.ok ? result.text : latestSnapshot;

    mergeTranscriptTransformText({ textById, expectedSegments: remainingSegments, providerText, ... });
    nextIndex = findFirstMissingTranscriptSegmentIndex(segments, textById);

    if (!result.ok) {
      lastFailureMessage = result.message;
      if (!providerText.trim()) throw new Error(result.message);   // 完全没内容才放弃
    }
  }

  if (nextIndex < segments.length) {
    throw new Error(`${lastFailureMessage}:transcript_transform_incomplete:${segments[nextIndex].id}`);
  }
  return textById;
}
```

三个精妙之处：

**（1）只重发缺失部分**

假设 500 个片段，模型只输出了前 300 个：

```text
朴素做法：重试 → 重发全部 500 个 → 再次可能只出 300 个 → 死循环
本项目：  重试 → 只发第 301-500 个 → 大概率一次补全
```

**（2）失败也用流式快照**

即使请求最终报错（超时、网络中断），流式过程中已经收到的文本仍然被解析利用。这在长任务中能挽救大量已完成的工作。

**（3）强制开启流式**

```ts
streamingMode: true,
```

即使用户没开流式模式，转录转换也强制用流式——正是为了拿到 `latestSnapshot`。

失败时的错误信息还携带了断点位置：

```text
provider_request_failed:transcript_transform_incomplete:segment-301
```

便于排查在哪一段卡住。

#### 结果回填与变体管理

```ts
export function applyTranscriptTextMapBySegmentId(segments, textById) {
  return segments.map((segment) => ({
    ...segment,
    text: textById.get(segment.id)?.trim() || segment.text,   // 没有结果就保留原文
  }));
}
```

翻译结果不覆盖原转录，而是创建新变体：

```ts
export type TranscriptVariant = {
  id: string;
  videoId: string;
  kind: "review" | "translation" | "source";
  languageCode?: string;
  languageLabel?: string;
  provider?: ProviderKind;
  model?: string;
  sourceKind?: TranscriptSourceKind;
  segments: TranscriptSegment[];
  artifactPath: string;
  createdAtIso: string;
};
```

用户可以在原始字幕、AI 转录、校对版、多个语言的翻译版之间自由切换，历史版本不丢失。

### 9.5 统一模式总结

四类结构化生成功能遵循同一套范式：

```text
┌────────────────────────────────────────────┐
│ 1. Prompt 中给出精确的输出格式契约            │
│    （JSON shape 或 TSV 列定义）              │
├────────────────────────────────────────────┤
│ 2. 容错解析                                  │
│    · JSON：剥离围栏、定位首尾大括号            │
│    · TSV：逐行解析，跳过异常行                 │
├────────────────────────────────────────────┤
│ 3. 程序校验                                  │
│    · 关键字段不合法 → 抛出带语义的错误码        │
│    · 可选字段不合法 → 静默丢弃                 │
├────────────────────────────────────────────┤
│ 4. 服务端重新赋权威值                         │
│    · ID 重新编号                             │
│    · 数量截断到请求值                         │
│    · 路径由程序生成                           │
└────────────────────────────────────────────┘
```

核心原则：**永远不直接信任 LLM 的输出结构**。这一点在生产系统中至关重要。

---

## 10. LLM 接入层

### 10.1 分层结构

```text
业务层（summaryChatService）
   ↓  统一接口 complete()
providerService.ts          续写、失败处理、日志
   ↓
domain/provider.ts          构造 ProviderRequestPlan（无密钥）
   ↓
tauriProviderClient.ts      走 Tauri 通道
   ↓
Rust provider.rs            注入密钥 + 端点白名单 + 发送请求
   ↓
providerAdapters.ts         解析各厂商响应格式
```

### 10.2 支持的 Provider 与端点

```ts
const providerEndpoints: Record<ProviderKind, string> = {
  openai:      "https://api.openai.com/v1/chat/completions",
  anthropic:   "https://api.anthropic.com/v1/messages",
  gemini:      "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  openrouter:  "https://openrouter.ai/api/v1/chat/completions",
  deepseek:    "https://api.deepseek.com/v1/chat/completions",
  "openai-compatible": "http://localhost:1234/v1/chat/completions",
};
```

`openai-compatible` 的端点可以在界面上修改并存入 localStorage：

```ts
const OPENAI_COMPATIBLE_ENDPOINT_KEY = "openbrief.openai-compatible-endpoint";
```

这使得接入 LM Studio、Ollama（OpenAI 兼容模式）、vLLM 等本地推理服务成为可能。

### 10.3 请求体差异适配

`domain/provider.ts` 的 `createProviderBody` 处理三种格式：

**OpenAI 系（含 OpenRouter / DeepSeek / 兼容端点）**

```json
{
  "model": "gpt-5.4-mini",
  "temperature": 0.3,
  "top_p": 0.9,
  "max_tokens": 4096,
  "stream": true,
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "..." }
  ]
}
```

**Anthropic**

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "temperature": 0.3,
  "top_p": 0.9,
  "stream": true,
  "system": "...",
  "messages": [ { "role": "user", "content": "..." } ]
}
```

注意 Anthropic 的 system 是**独立顶层字段**，不在 messages 里。

**Gemini**

```json
{
  "generationConfig": {
    "temperature": 0.3,
    "topP": 0.9,
    "maxOutputTokens": 4096
  },
  "contents": [
    { "role": "user", "parts": [{ "text": "<system>\n\n<user>" }] }
  ]
}
```

Gemini 这里的处理方式是**把 system 和 user 拼进同一段文本**：

```ts
parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
```

而没有使用 Gemini 的 `systemInstruction` 字段。这是一个可以改进的地方——独立的 system instruction 通常比拼接更能让模型遵守约束。

流式端点也不同：

```ts
const method = streamingMode ? "streamGenerateContent" : "generateContent";
```

### 10.4 七类操作的默认生成参数

```ts
export const defaultGenerationParamsByOperation: Record<ProviderOperation, Required<GenerationParams>> = {
  summary:              { temperature: 0.3,  topP: 0.9,  maxTokens: 4096 },
  chat:                 { temperature: 0.2,  topP: 0.9,  maxTokens: 2048 },
  podcast_script:       { temperature: 0.55, topP: 0.95, maxTokens: 4096 },
  quiz:                 { temperature: 0.35, topP: 0.9,  maxTokens: 4096 },
  transcript_review:    { temperature: 0.1,  topP: 0.9,  maxTokens: 4096 },
  transcript_translate: { temperature: 0.1,  topP: 0.9,  maxTokens: 4096 },
  transcript_resegment: { temperature: 0.2,  topP: 0.9,  maxTokens: 4096 },
};
```

参数取值的逻辑很清晰：

| 操作 | temperature | 理由 |
| --- | ---: | --- |
| 转录校对 / 翻译 | 0.1 | 需要高度确定性，绝不能自由发挥 |
| 聊天 | 0.2 | 基于给定上下文回答，不需要创造性 |
| 重新分段 | 0.2 | 结构性操作 |
| 摘要 | 0.3 | 需要一点组织与表达能力 |
| 测验 | 0.35 | 出题需要一定多样性 |
| 播客脚本 | 0.55 | 需要自然的对话感和变化 |

`topP` 基本固定 0.9，只有播客用 0.95 以增加词汇多样性。

用户可修改，且有范围校验：

```ts
temperature: numberInRange(value?.temperature, 0, 2) ?? fallback.temperature,
topP:        numberInRange(value?.topP, 0, 1) ?? fallback.topP,
maxTokens:   integerInRange(value?.maxTokens, 1, 128000) ?? fallback.maxTokens,
```

超范围的值会静默回退到默认值，而不是报错或直接透传给 API。

### 10.5 流式实现

完整链路：

```text
LLM 服务端 SSE
   ↓
Rust: response.bytes_stream()
   ↓
Rust: consume_sse_buffer() 按 \n\n 或 \r\n\r\n 切帧
   ↓
Rust: parse_sse_frame() 提取 data: 行，跳过 [DONE] 与心跳
   ↓
Rust: extract_provider_stream_text_delta() 按厂商取增量
   ↓
Rust: app.emit("openbrief://provider-stream", { requestId, text })
   ↓
TS: listen() 收到事件，比对 requestId
   ↓
TS: options.onTextSnapshot(event.payload.text)
   ↓
TS: createThrottledTextSnapshotHandler 节流 100ms
   ↓
React: setSummaryJob({ ..., draftText })
   ↓
界面渐进渲染
```

各厂商的流式增量提取（Rust 侧）：

```rust
fn extract_provider_stream_text_delta(provider: ProviderKind, value: &Value) -> String {
    match provider {
        Openai | Openrouter | Deepseek | OpenaiCompatible =>
            value.pointer("/choices/0/delta/content")...,
        Anthropic =>
            value.pointer("/delta/text")...,
        Gemini =>
            extract_gemini_candidate_text(value),
    }
}
```

TypeScript 侧有等价实现（`providerAdapters.ts`），用于不走 Tauri 的场景（如浏览器预览或测试）。

**节流实现**：

```ts
function createThrottledTextSnapshotHandler(onSnapshot, intervalMs = 100) {
  let latestDraftText: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let lastEmittedAt: number | undefined;

  const handler = (draftText: string) => {
    latestDraftText = draftText;
    if (lastEmittedAt === undefined) { emit(); return; }   // 首次立即发
    const elapsedMs = performance.now() - lastEmittedAt;
    if (elapsedMs >= intervalMs) { /* 立即发 */ }
    else { /* 安排延迟发送 */ }
  };
  handler.cancel = cancel;
  return handler;
}
```

没有节流的话，每个 token 都会触发一次 React setState，长摘要会导致明显卡顿。

流式事件传的是**累积全文**而非增量（`text: text.clone()`，其中 `text` 是累加变量），因此 React 侧只需直接替换，无需自己拼接——这简化了渲染逻辑，代价是事件体积随生成变大。

### 10.6 截断续写

```ts
const maxProviderContinuationRequests = 4;

async function completeProviderWithContinuation({ request, ... }) {
  let text = "";
  let usage: AiTokenUsage | undefined;
  let finishReason: ProviderFinishReason = "unknown";

  for (let attempt = 0; attempt <= maxProviderContinuationRequests; attempt += 1) {
    const attemptRequest = attempt === 0 ? request : { ...request, continuationText: text };
    const textBeforeAttempt = text;

    // 流式回调要带上之前累积的部分
    const onTextSnapshot = request.onTextSnapshot
      ? (attemptText: string) => request.onTextSnapshot?.(`${textBeforeAttempt}${attemptText}`)
      : undefined;

    const response = await executeAttempt({ attemptRequest, requestPlan, onTextSnapshot });

    if (response.status < 200 || response.status >= 300) {
      return createProviderFailureResult({ ... });   // HTTP 错误直接失败
    }

    text += extractProviderText(request.provider, response.body);
    usage = mergeProviderUsage(usage, extractProviderUsage(request.provider, response.body));
    finishReason = extractProviderFinishReason(request.provider, response.body);

    if (finishReason !== "length") {
      return { ok: true, text, usage, finishReason, requestPlan: initialRequestPlan };
    }
    // finishReason === "length" 说明被 max_tokens 截断，继续循环
  }

  // 4 次续写后仍未完成，返回已有内容
  return { ok: true, text, usage, finishReason: "length", requestPlan: initialRequestPlan };
}
```

续写提示词：

```ts
function continuationPrompt() {
  return [
    "Continue exactly where the previous response stopped.",
    "Do not restart, summarize, apologize, or repeat completed content.",
    "Return only the continuation in the same format.",
  ].join("\n");
}
```

续写消息的构造方式（以 OpenAI 系为例）：

```ts
messages.push(
  { role: "assistant", content: continuationText },   // 已生成的部分
  { role: "user",      content: continuationPrompt() },
);
```

**finish reason 归一化**（不同厂商叫法不同）：

```ts
function normalizeFinishReason(value: unknown): ProviderFinishReason {
  const normalized = value.toLowerCase();
  if (["length", "max_tokens", "max_token", "max_output_tokens",
       "max_tokens_reached", "max_tokens_exceeded"].includes(normalized)) {
    return "length";
  }
  if (normalized === "stop" || normalized === "end_turn") return "stop";
  return "unknown";
}
```

**局限**：`text += attemptText` 是纯字符串拼接，**没有重叠检测与去重**。如果模型没完全遵守"不要重复已完成内容"的指令，重复片段会直接出现在结果里。改进方向是做后缀-前缀最长匹配去重。

### 10.7 Token 用量统计

```ts
function mergeProviderUsage(current, next): AiTokenUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    inputTokens:       sumOptionalNumbers(current.inputTokens, next.inputTokens),
    cachedInputTokens: sumOptionalNumbers(current.cachedInputTokens, next.cachedInputTokens),
    outputTokens:      sumOptionalNumbers(current.outputTokens, next.outputTokens),
    totalTokens:       sumOptionalNumbers(current.totalTokens, next.totalTokens),
  };
}
```

多次续写的用量会累加。各厂商字段名的适配：

| 字段 | OpenAI 系 | Anthropic | Gemini |
| --- | --- | --- | --- |
| 输入 | `prompt_tokens` | `input_tokens` | `promptTokenCount` |
| 输出 | `completion_tokens` | `output_tokens` | `candidatesTokenCount` |
| 缓存输入 | `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` / `cached_input_tokens` | `cachedContentTokenCount` |
| 总计 | `total_tokens` | 计算得出 | `totalTokenCount` |

用量最终记录在 `ChatMessage.tokenUsage`，界面可展示成本。

### 10.8 服务的三种实现

```ts
createMockProviderService()    // 返回固定的假数据，用于测试与浏览器预览
createLiveProviderService()    // 真实调用
createDefaultProviderService() // 自动选择：能用 Tauri 就 live，否则 mock
```

```ts
export function createDefaultProviderService(): ProviderService {
  if (!canUseTauriRuntime()) {
    return createMockProviderService();
  }
  return createLiveProviderService({
    trustedHttpClient: createTauriProviderHttpClient(),
  });
}
```

Mock 实现也支持流式（分 6 段模拟推送），使得在浏览器里跑 Vite 开发服务器时界面依然可以完整走通。这对开发效率帮助很大。

---

## 11. 安全边界

`AGENTS.md` 定义的安全原则在代码中有严格落实。

### 11.1 密钥不进入渲染层

渲染层构造的 `ProviderRequestPlan` 中，密钥位置是**占位符**：

```ts
function createRedactedHeaderPlan(provider: ProviderKind): Record<string, string> {
  switch (provider) {
    case "openai":
    case "openrouter":
    case "deepseek":
    case "openai-compatible":
      return { Authorization: "[TAURI_SECRET:api-key]" };
    case "anthropic":
      return { "x-api-key": "[TAURI_SECRET:api-key]", "anthropic-version": "2023-06-01" };
    case "gemini":
      return { "x-goog-api-key": "[TAURI_SECRET:api-key]" };
  }
}
```

真实密钥由 Rust 在发送前注入：

```rust
let api_key = read_provider_api_key_for_app(&app, request_plan.provider)?
    .ok_or_else(|| "provider_api_key_missing".to_string())?;

let response = client
    .post(&request_plan.endpoint)
    .headers(provider_headers(request_plan.provider, &api_key)?)
    .json(&request_plan.body)
    .send()
    .await?;
```

`credentialPolicy: "tauri-secret-store"` 字段也明确标记了这一契约。

存储策略（`domain/media-library.ts`）：

```ts
{
  secretStoragePreference: "os-keychain",
  fallbackSecretStorage: "encrypted-or-0600-app-private-file",
}
```

优先操作系统钥匙串，降级为加密或 0600 权限的应用私有文件。

### 11.2 端点白名单

即使渲染层被攻破，也不能让 Rust 带着密钥请求任意地址：

```rust
fn is_allowed_provider_endpoint(provider: ProviderKind, endpoint: &str) -> bool {
    match provider {
        ProviderKind::Openai => endpoint == "https://api.openai.com/v1/chat/completions",
        ProviderKind::Deepseek => endpoint == "https://api.deepseek.com/v1/chat/completions",
        ProviderKind::Anthropic => endpoint == "https://api.anthropic.com/v1/messages",
        ProviderKind::Openrouter => endpoint == "https://openrouter.ai/api/v1/chat/completions",
        ProviderKind::Gemini => {
            endpoint.starts_with("https://generativelanguage.googleapis.com/v1beta/models/")
                && (endpoint.ends_with(":generateContent")
                    || endpoint.ends_with(":streamGenerateContent"))
                && !endpoint.contains([' ', '\n', '\r', '\t'])
        }
        ProviderKind::OpenaiCompatible => {
            let is_local = endpoint.starts_with("http://localhost:")
                || endpoint.starts_with("http://127.0.0.1:");
            let is_tls = endpoint.starts_with("https://");
            (is_local || is_tls)
                && endpoint.ends_with("/v1/chat/completions")
                && !endpoint.contains([' ', '\n', '\r', '\t'])
        }
    }
}
```

细节值得注意：

- 固定端点用**完全相等**比较，不是 `starts_with`
- Gemini 因模型名可变，用前缀 + 后缀双向约束
- `openai-compatible` 允许自定义，但限制为 **localhost 或 HTTPS**，禁止明文 HTTP 发往外网
- 显式检查空白字符，防止 header/URL 注入

方法也限制为 POST：

```rust
if request_plan.method != "POST" {
    return Err("provider_method_not_allowed".to_string());
}
```

### 11.3 诊断信息脱敏

错误诊断上报前会递归脱敏：

```ts
const forbiddenSecretKeyFragments = [
  "apikey", "api_key", "authorization", "credential",
  "oauth", "refresh_token", "secret", "token", "x_api_key", "x-api-key",
];

export function redactProviderDiagnostic(value: unknown, additionalSecrets: string[] = []): unknown {
  if (typeof value === "string") return redactSecretText(value, additionalSecrets);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactProviderDiagnostic(item, additionalSecrets));

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      if (isForbiddenSecretKey(key)) return [key, "[REDACTED]"];
      return [key, redactProviderDiagnostic(nestedValue, additionalSecrets)];
    }),
  );
}
```

文本级脱敏：

```ts
function redactSecretText(value: string, additionalSecrets: string[]) {
  return additionalSecrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      value
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]"),
    );
}
```

同时覆盖：字段名匹配、`Bearer xxx` 模式、`sk-xxx` 模式、以及已知的具体密钥字符串。

还有配套的检测函数用于测试断言：

```ts
export function providerDiagnosticContainsSecret(value: unknown): boolean
```

### 11.4 子进程 argv 数组

所有外部命令都以结构化 argv 构造，绝不做 shell 字符串拼接：

```rust
pub struct CommandPlan {
    tool: &'static str,
    program: PathBuf,
    args: Vec<String>,
}

pub fn extract_audio_plan(payload: &Value) -> HelperResult<CommandPlan> {
    let input = required_string(payload, &["videoPath", "inputPath", "path"])?;
    let output = required_string(payload, &["outputPath"])?;
    Ok(CommandPlan {
        tool: "ffmpeg",
        program: discover_media_tool("ffmpeg"),
        args: vec![
            "-hide_banner".into(), "-y".into(),
            "-i".into(), input,
            "-vn".into(),
            "-acodec".into(), "pcm_s16le".into(),
            "-ar".into(), "16000".into(),
            "-ac".into(), "1".into(),
            output,
        ],
    })
}
```

这从根本上消除了 shell 注入的可能——文件名里有空格、分号、`$()` 都不会造成问题。

### 11.5 路径逃逸防护

```rust
#[tauri::command]
pub fn resolve_library_file_path<R: Runtime>(app: AppHandle<R>, relative_path: String) -> Result<String, String> {
    let library_root = app_library_root(&app)?;
    let absolute_path = library_absolute_path(&library_root, &relative_path, false)?;
    let canonical_path = absolute_path.canonicalize()
        .map_err(|error| format!("library_file_not_found:{error}"))?;

    if !canonical_path.starts_with(&library_root) {
        return Err("library_file_escaped_root".to_string());
    }
    Ok(path_to_string(canonical_path))
}
```

关键是先 `canonicalize()`（解析 `..` 与符号链接）再判断前缀，而不是直接对原始字符串做前缀检查——后者可以被 `../../..` 绕过。

`packages/openbrief-content` 中还有一层独立的路径校验：

```ts
export function validatePortableArtifactPath({ assetId, sourceType, path }) {
  if (!path.trim()) return { ok: false, reason: "path_empty" };
  if (path.includes("\\")) return { ok: false, reason: "path_backslash" };
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return { ok: false, reason: "path_absolute" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return { ok: false, reason: "path_url" };

  const segments = path.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) return { ok: false, reason: "path_traversal" };
  if (!portableAssetRoots.includes(segments[0])) return { ok: false, reason: "path_root_unsupported" };

  const root = portableAssetRootPath(sourceType, assetId);
  if (path === root || !path.startsWith(`${root}/`)) return { ok: false, reason: "path_outside_asset_root" };

  return { ok: true };
}
```

拒绝：空路径、反斜杠、绝对路径、盘符路径、URL、路径穿越、非法根目录、越出资源目录。

### 11.6 Helper payload 密钥防护

`domain/helper-protocol.ts` 中同样定义了禁止字段列表：

```ts
const forbiddenSecretKeyFragments = [
  "apikey", "api_key", "authorization", "credential",
  "oauth", "provider", "secret", "token",
];
```

配套测试 `keeps provider credentials out of helper payloads` 用于保证发给 helper 的命令载荷中不含凭证。

---

## 12. 数据存储与产物组织

### 12.1 内存中的统一快照

所有库状态集中在一个对象里：

```ts
export type MediaLibrarySnapshot = {
  videos: VideoAsset[];
  ingestJobs: IngestJob[];
  transcriptJobs: TranscriptJob[];
  transcriptsByVideoId: Record<string, TranscriptSegment[]>;
  transcriptVariantsByVideoId: Record<string, TranscriptVariant[]>;
  summariesByVideoId: Record<string, SummaryDocument>;
  summaryHistoryByVideoId: Record<string, SummaryDocument[]>;
  chatMessagesByVideoId: Record<string, ChatMessage[]>;
  podcastsByVideoId: Record<string, PodcastDocument>;
  podcastHistoryByVideoId: Record<string, PodcastDocument[]>;
  podcastJobsByVideoId: Record<string, PodcastGenerationJob>;
  quizzesByVideoId: Record<string, QuizDocument>;
  quizHistoryByVideoId: Record<string, QuizDocument[]>;
  quizJobsByVideoId: Record<string, QuizGenerationJob>;
  playlists: VideoPlaylist[];
};
```

设计特点：**"当前项 + 历史列表"成对存在**。例如 `summariesByVideoId`（当前展示的）与 `summaryHistoryByVideoId`（全部历史）。用户重新生成摘要时旧版本不丢失。

### 12.2 三种仓储实现

```ts
export interface MediaLibraryRepository {
  loadSnapshot(): Promise<MediaLibrarySnapshot>;
  saveSnapshot(snapshot: MediaLibrarySnapshot): Promise<void>;
  listVideos(): Promise<VideoAsset[]>;
  // ...
}
```

| 实现 | 用途 |
| --- | --- |
| `SqlMediaLibraryRepository` | 生产环境，走 Tauri → Rust → SQLite |
| `JsonMediaLibraryRepository` | 基于文本存储适配器的 JSON 文件实现 |
| `InMemoryMediaLibraryRepository` | 测试与浏览器预览 |

自动选择：

```ts
export function createDefaultMediaLibraryRepository(initialVideos: VideoAsset[] = []): MediaLibraryRepository {
  if (canUseTauriRuntime()) return new SqlMediaLibraryRepository();
  return new InMemoryMediaLibraryRepository({ ...createEmptyMediaLibrarySnapshot(), videos: initialVideos });
}
```

持久化触发点在 `useMediaLibrary` 的更新函数中，通过第二个参数控制：

```ts
function updateLibrarySnapshot(update, persist = false) {
  const next = update(librarySnapshotRef.current);
  hasLocalMutationRef.current = true;
  librarySnapshotRef.current = next;
  setLibrarySnapshot(next);
  if (persist) void repository.saveSnapshot(next);
  return next;
}
```

即：**高频的进度更新不落盘，只有产生实质结果时才持久化**。例如摘要生成完成、聊天消息追加、播客生成完成时才传 `true`。这避免了流式生成期间每 100ms 写一次数据库。

### 12.3 Rust 侧持久化

```rust
pub fn load_media_library_snapshot<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let library_root = app_library_root(&app)?;
    let db_path = library_root.join("openbrief.sqlite3");
    ...
}
```

数据库文件：`<library-root>/openbrief.sqlite3`，使用 `rusqlite` 的 `bundled` feature（SQLite 编译进二进制，无需系统依赖）。

保存时除写库外，还会：

1. `migrate_video_bundle_paths()` — 迁移旧版路径布局
2. `write_video_bundle_manifests()` — 为每个视频写出 bundle 清单

清单结构（`domain/media-library.ts`）：

```ts
export type VideoBundleManifest = {
  schemaVersion: 1;
  videoId: string;
  video: VideoAsset;
  artifacts: {
    thumbnailPath?: string;
    audioPath?: string;
    transcriptPath?: string;
    transcriptVariantPaths: string[];
    summaryPaths: string[];
    chatSessionPaths: string[];
  };
};
```

### 12.4 自包含资源包布局

`AGENTS.md` 明确规定：

> Treat each imported asset directory as a portable bundle that can be zipped and imported on another device.

即**每个资源目录都应当是可压缩、可迁移到另一台设备的完整包**。

布局：

```text
<library-root>/
├── openbrief.sqlite3
├── videos/
│   └── {videoId}/
│       ├── openbrief-video.json        bundle 清单
│       ├── <原始视频文件>.mp4
│       ├── thumbnail/
│       │   └── {videoId}-thumbnail.jpg
│       ├── audio/
│       │   └── {videoId}-audio.wav
│       ├── transcript/
│       │   ├── transcript.json
│       │   └── {variantId}/transcript.txt
│       ├── summary/
│       │   └── {summaryId}/summary.md
│       ├── chat/
│       │   ├── {sessionId}.jsonl
│       │   └── tts/{messageId}/{generationId}/voice-message-<time>.wav
│       ├── podcast/
│       │   └── {podcastId}/
│       │       ├── podcast.json
│       │       ├── script.md
│       │       └── audio/{podcast.wav, turns/*.wav}
│       └── quiz/
│           └── {quizId}/quiz.json
├── audios/{audioId}/...      结构同上
├── pdfs/{pdfId}/...          结构同上
├── playlists/
└── job-temp/                 临时文件
```

`AGENTS.md` 明确禁止的做法：

> Do not add new top-level per-asset artifact buckets such as `transcripts/`, `summaries/`, `thumbnails/`, or global TTS `generations/`.

即禁止把产物按类型平铺到全局目录——那样就无法整体打包迁移了。

路径生成必须是媒体类型感知的：

```ts
const podcastDirectoryBySourceType = {
  video: "videos",
  audio: "audios",
  pdf:   "pdfs",
} as const;
```

同样禁止对音频/PDF 资源硬编码 `videos/{id}`。

（观察：`domain/transcript-actions.ts` 的 `createTranscriptArtifactPath` 目前仍硬编码了 `videos/` 前缀，与这条规则存在出入，可能是尚未完成的迁移。）

### 12.5 模型存储

来源：`docs/LOCAL_MODEL.md` 与 `src-tauri/src/stt_models.rs`

```text
<app-data>/models/
├── ggml-tiny.bin
├── ggml-base.bin
├── ggml-small.bin
├── ggml-medium.bin
├── ggml-large-v3-turbo-q5_0.bin
├── ggml-large-v3-turbo.bin
├── ggml-small.bin.partial              ← 下载中的临时文件
├── fluidaudio/
│   └── parakeet-tdt-0.6b-v3/
│       ├── Preprocessor.mlmodelc/
│       ├── Encoder.mlmodelc/
│       ├── Decoder.mlmodelc/
│       ├── JointDecisionv3.mlmodelc/
│       └── parakeet_vocab.json
├── supertonic/
│   ├── hf/hub/...                      HuggingFace 缓存
│   └── supertonic-3/
│       ├── onnx/{duration_predictor,text_encoder,vector_estimator,vocoder}.onnx
│       ├── voice_styles/{F1..F5,M1..M5}.json
│       └── manifest.json
└── localai/
    └── hf/hub/
        ├── models--Qwen--Qwen3-ASR-0.6B/
        ├── models--Qwen--Qwen3-ASR-1.7B/
        ├── models--Qwen--Qwen3-TTS-12Hz-0.6B-Base/
        └── models--mlx-community--*/    Apple MLX 变体
```

**原子下载流程**（`stt_models.rs`）：

```text
1. 下载到 <file>.partial
2. 计算并校验 SHA1
3. 重命名为最终 ggml-*.bin
4. 文件存在即视为已下载
```

这保证了中断的下载不会被误认为可用模型。

Whisper 模型目录：

| Model ID | 文件 | 约体积 | 说明 |
| --- | --- | ---: | --- |
| `whisper-tiny` | `ggml-tiny.bin` | 75 MB | 最小 |
| `whisper-base` | `ggml-base.bin` | 142 MB | 低成本基线 |
| `whisper-small` | `ggml-small.bin` | 466 MB | **默认推荐** |
| `whisper-medium` | `ggml-medium.bin` | — | — |
| `whisper-large-v3-turbo-q5` | `ggml-large-v3-turbo-q5_0.bin` | — | 量化版 |
| `whisper-large-v3-turbo` | `ggml-large-v3-turbo.bin` | — | — |

Parakeet 会做平台可用性判定（`catalog_includes_parakeet_only_for_supported_fluidaudio_platforms` 测试印证了这一点），不支持的平台不会在目录中出现该模型。

下载进度通过事件推送：

```ts
await listen<RawSttModelDownloadProgress>(
  "openbrief://stt-model-download-progress",
  (event) => { if (event.payload.modelId === modelId) options.onProgress?.(...); },
);
```

### 12.6 产物导出

导出分两步：

```ts
// 第一步：把内存中的内容写成库内文件
await invokeCommand<MarkdownSaveResult>("write_text_artifact", {
  relativePath: sourceRelativePath,
  text: summary.markdown,
});

// 第二步：从库内复制到用户选择的位置
const result = await invokeCommand<ArtifactExportResult>("export_library_artifact", {
  sourceRelativePath,
  outputDirectory,
  fileName,
});
```

支持导出的类型：

```ts
export type VideoArtifactDownloadKind =
  | "video"          // 原视频
  | "thumbnail"      // 缩略图
  | "audio"          // 提取的音频
  | "transcription"  // 转录文本
  | "summary";       // 摘要 Markdown
```

转录导出格式：

```ts
export function formatTranscriptText(segments: TranscriptSegment[]) {
  return segments
    .map((segment) => `${formatTimestamp(segment.startSeconds)}\t${segment.text}`)
    .join("\n");
}
```

即 `时间戳<TAB>文本`，方便导入其他工具。

**观察**：摘要与测验在生成完成的那一刻，主要更新的是媒体库快照，其对应的 `.md` / `.json` 物理文件在**导出时**才由 `write_text_artifact` 落盘。播客因为 TTS 阶段必须产出真实音频，所以物理产物的写出更为完整。

### 12.7 多工作区隔离

```ts
export function workspaceStorageKey(key: string, storage = browserLocalStorage()): string {
  const workspaceId = readActiveWorkspaceId(storage);
  if (workspaceId === "default") return key;
  return `openbrief.workspace.${encodeURIComponent(workspaceId)}.${key}`;
}
```

默认工作区用原始 key（向后兼容），其他工作区加前缀隔离。因此不同工作区的系统提示词、生成参数、Provider 偏好互不影响。

Rust 侧有对应的工作区命令：

```rust
workspace::workspace_snapshot,
workspace::create_workspace,
workspace::switch_workspace,
```

注释也说明了权威性归属：

```ts
// Keep the Rust workspace state authoritative if browser storage is unavailable.
```

即 localStorage 只是缓存，Rust 才是权威。

### 12.8 可移植内容 Schema

`packages/openbrief-content` 用 Zod 定义了跨设备分享的数据契约：

```ts
export const PortableShareManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  app: z.literal("openbrief"),
  id: z.string().min(1),
  createdAtIso: z.iso.datetime(),
  asset: PortableAssetSchema,
  artifacts: z.array(PortableArtifactSchema),
  transfer: z.object({
    mode: z.enum(["gateway-assisted-local-http", "gateway-assisted-webrtc"]),
    requiresApproval: z.boolean().default(true),
  }).optional(),
}).superRefine((manifest, ctx) => {
  // 校验每个 artifact 路径都在资源根目录内
  for (const artifact of manifest.artifacts) {
    const result = validatePortableArtifactPath({ ... });
    if (!result.ok) ctx.addIssue({ code: "custom", path: [...], message: result.reason });
  }
});
```

artifact 还可带 SHA256 用于完整性校验：

```ts
sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
```

传输模式设计为网关辅助的本地 HTTP 或 WebRTC，且默认 `requiresApproval: true`——即接收方需明确同意。

---

## 13. 端到端时序图

```text
用户粘贴视频 URL
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 阶段一：导入                                                          │
│                                                                       │
│ domain/helper-protocol.ts :: classifyVideoProviderUrl()               │
│   └→ 白名单校验（youtube/tiktok/twitch/vimeo）                        │
│                                                                       │
│ domain/ingest.ts :: createYoutubeDownloadCommand()                    │
│   └→ 构造 download_youtube 命令                                       │
│                                                                       │
│ services/ingestService.ts :: importYoutubeUrl()                       │
│   ├→ [Rust] helper_sidecar.rs :: download_youtube_plan()              │
│   │     └→ yt-dlp（720p/30fps/avc1+mp4a，带封面与 info-json）         │
│   ├→ [Rust] probe_media_plan()  → ffprobe                             │
│   ├→ ensureWebviewPlayableVideo() → 必要时 ffmpeg 转码                 │
│   └→ [Rust] extract_thumbnail_plan() → ffmpeg 截图                    │
│                                                                       │
│ 产出：VideoAsset { id, title, libraryPath, thumbnailPath, ... }        │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 阶段二：转录                                                          │
│                                                                       │
│ services/transcriptService.ts :: extractTranscript()                  │
│                                                                       │
│   ┌─ shouldAttemptCaptionExtraction()?                                │
│   │                                                                    │
│   ├─ 是 → [Rust] extract_captions_plan()                              │
│   │        └→ yt-dlp --write-subs --write-auto-subs --sub-format vtt  │
│   │           ├─ 有内容 → 返回 sourceKind: "youtube-captions" ✓        │
│   │           └─ 失败/为空 → 记录事件，继续 ↓                          │
│   │                                                                    │
│   └─ 否/回退 → [Rust] extract_audio_plan()                            │
│                 └→ ffmpeg -vn -acodec pcm_s16le -ar 16000 -ac 1       │
│                    └→ [Rust] helper.rs 引擎路由：                      │
│                       ├─ qwen_asr::run_transcribe_audio()             │
│                       ├─ fluidaudio::run_transcribe_audio()           │
│                       └─ helper sidecar（whisper.cpp）                 │
│                          → 返回 sourceKind: "local-stt" ✓             │
│                                                                       │
│ 产出：TranscriptSegment[] ← ★ 统一枢纽结构                            │
│       进度映射：captions 2-35% / audio 40-55% / stt 60-99%            │
└──────────────────────────────────────────────────────────────────────┘
       │
       ├────────────┬────────────┬────────────┬────────────┬───────────┐
       ▼            ▼            ▼            ▼            ▼           ▼
┌───────────┐┌──────────┐┌───────────┐┌──────────┐┌──────────┐┌──────────┐
│   摘要     ││   问答    ││   播客     ││   测验    ││   校对    ││   翻译    │
├───────────┤├──────────┤├───────────┤├──────────┤├──────────┤├──────────┤
│summary.ts ││ chat.ts  ││podcast.ts ││ quiz.ts  ││transcript-actions.ts │
│           ││          ││           ││          ││                      │
│createSum- ││createCh- ││createPod- ││createQu- ││createTranscriptRe-   │
│maryPrompt ││atPrompt  ││castScript ││izPrompt  ││view/TranslationPrompt│
│           ││          ││Prompt     ││          ││                      │
│temp 0.3   ││temp 0.2  ││temp 0.55  ││temp 0.35 ││temp 0.1              │
│4096 tok   ││2048 tok  ││4096 tok   ││4096 tok  ││4096 tok              │
└─────┬─────┘└────┬─────┘└─────┬─────┘└────┬─────┘└──────────┬───────────┘
      └───────────┴────────────┴───────────┴─────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 阶段三：LLM 调用                                                      │
│                                                                       │
│ services/providerService.ts :: complete()                             │
│   └→ domain/provider.ts :: createProviderRequestPlan()                │
│        · endpoint / body（三种格式适配）                               │
│        · headers 用 [TAURI_SECRET:api-key] 占位                       │
│                                                                       │
│   └→ services/tauriProviderClient.ts                                  │
│        └→ [Rust] provider.rs                                          │
│             · validate_provider_request_plan()  端点白名单 + POST 限制 │
│             · read_provider_api_key_for_app()   注入真实密钥           │
│             · reqwest 发送                                             │
│             · 流式：bytes_stream → SSE 解析                            │
│               → emit "openbrief://provider-stream"                    │
│                                                                       │
│   └→ 回到 TS：providerAdapters.ts 解析响应                            │
│        · extractProviderText / Usage / FinishReason                   │
│                                                                       │
│   └→ finishReason === "length"？                                      │
│        └→ 续写（最多 4 次），追加 continuationPrompt()                 │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 阶段四：解析与校验                                                    │
│                                                                       │
│ 摘要      → Markdown 直用 + createClickableSummaryTimestampMarkdown() │
│ 播客/测验 → parseXxxJson()（剥围栏、定位 {}）→ validateXxxResponse()  │
│ 校对/翻译 → parseTranscriptSegmentTsv() → 按 ID 回填                  │
│             缺失时最多 3 次续传（只发剩余片段）                        │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 阶段五：持久化与呈现                                                  │
│                                                                       │
│ hooks/useMediaLibrary.ts :: updateLibrarySnapshot(update, persist)    │
│   ├→ 流式草稿：persist = false（100ms 节流，不落盘）                   │
│   └→ 最终结果：persist = true                                          │
│        └→ SqlMediaLibraryRepository.saveSnapshot()                    │
│             └→ [Rust] media_library.rs                                │
│                  · SQLite: <library-root>/openbrief.sqlite3           │
│                  · write_video_bundle_manifests()                     │
│                                                                       │
│ 播客额外：generate_supertonic_podcast_tts                             │
│   └→ 逐轮 WAV → 合并 podcast.wav → turnTimings                        │
│                                                                       │
│ 界面：Markdown 渲染 + 时间戳链接                                       │
│   点击 [12:34](#openbrief-timestamp-754)                              │
│     → parseSummaryTimestampHref() → 754                               │
│     → 视频播放器 seek(754)                     ★ 回链闭环             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 14. 评估与对 OpenVideo 的借鉴建议

### 14.1 值得借鉴的七点

#### （1）统一的 TranscriptSegment 枢纽结构

**做法**：无论字幕、Whisper、Parakeet 还是 Qwen3-ASR，全部归一化为同一结构，下游功能只依赖这个结构。

**价值**：新增一种转录引擎，下游六个生成功能一行都不用改；新增一种生成功能，也不用关心转录来源。

**建议**：OpenVideo 应当在项目早期就确立这个枢纽结构，并**预留视觉信息的位置**，例如：

```ts
type MediaSegment = {
  id: string;
  startSeconds: number;
  endSeconds?: number;
  text: string;                    // 语音内容
  sourceKind: TranscriptSourceKind;
  words?: TranscriptWord[];
  // 为视觉扩展预留：
  visual?: {
    frameDescription?: string;     // VLM 生成的画面描述
    ocrText?: string;              // 画面文字
    keyFramePath?: string;         // 关键帧路径
  };
};
```

这样后续加入视觉理解时，摘要/问答/测验的 Prompt 只需多拼一段，架构不用重构。

#### （2）字幕优先，本地 STT 回退

**做法**：四条件判定 → 尝试字幕 → 失败自动回退 STT，且**字幕失败不标记任务失败**。

**价值**：常见场景秒级完成，资源占用极低；同时保证任何视频都能得到转录。

**建议**：直接采用。注意其中的细节——失败的字幕提取被降级为"切换来源"而非"任务失败"，用户体验差异很大。

#### （3）domain / services 严格分层

**做法**：Prompt 构造、数据校验、路径生成全部是无副作用纯函数，放在 `domain/`；IO 放在 `services/`。

**价值**：`domain/` 的测试不需要 mock 任何东西。仓库中 `summary.test.ts`、`quiz.test.ts`、`podcast.test.ts`、`chat.test.ts` 都是直接调用纯函数断言，写起来非常轻。

**建议**：这是最容易在早期确立、后期难以补救的规范。特别是 **Prompt 构造必须是纯函数**——否则无法对 Prompt 做回归测试。

#### （4）Provider 统一适配层

**做法**：业务层只调 `complete({ provider, operation, systemPrompt, userPrompt, ... })`，厂商差异全部封装在请求构造与响应解析两处。

**价值**：新增一个 Provider 只需改两个 switch 分支。

**建议**：采用。并考虑改进 Gemini 的处理——当前把 system 拼进 user text，建议改用 `systemInstruction` 字段。

#### （5）时间戳贯穿全链路的回链闭环

**做法**：转录段格式同时给人类可读时间和整数秒 → Prompt 中明确链接契约 → 渲染时兜底转换裸时间戳（跳过代码块）→ 点击回跳播放器。

**价值**：这是"AI 生成内容"与"原始素材"之间最有效的可信度桥梁——用户可以一键验证任何一句话的出处。

**建议**：**强烈推荐采用**。这是本项目产品价值最高的设计。注意兜底转换要正确处理代码块。

#### （6）结构化输出必须程序校验

**做法**：Prompt 给契约 + 容错解析 + 严格校验 + 服务端重新赋权威值；关键字段抛错、可选字段静默降级。

**价值**：LLM 不遵守格式是常态而非例外。没有这层防护，生产环境会频繁崩溃。

**建议**：采用这套范式。同时**升级为使用 Provider 原生结构化输出**（见 14.2 第 5 点）。

#### （7）凭证与权限留在可信边界

**做法**：渲染层永远拿不到真实密钥；Rust 侧端点白名单 + POST 限制 + 路径 canonicalize 校验 + argv 数组。

**价值**：即使渲染层出现 XSS 或依赖投毒，攻击面也被限制在"发起白名单内的 API 请求"，无法窃取密钥或访问任意文件。

**建议**：如果 OpenVideo 也是桌面端，这套边界设计可以直接照搬。

### 14.2 当前局限与改进方向

#### （1）无视觉分析能力

**现状**：只分析语音/字幕，画面信息完全未利用（详见第 7 章）。

**影响的场景**：演示录屏、代码讲解、图表分析、无旁白内容。

**改进方向**：

```text
视频
 ├→ 现有：音频 → 转录 → 时间戳文本
 └→ 新增：关键帧采样（场景切分或固定间隔）
          ├→ VLM 生成画面描述
          ├→ OCR 提取画面文字
          └→ CLIP embedding（用于视觉检索）
              ↓
        按时间戳与转录对齐
              ↓
        多模态 Prompt / 多模态检索
```

采样策略建议：优先用 ffmpeg 的场景切分（`select='gt(scene,0.4)'`）而非固定间隔，能显著减少冗余帧。

#### （2）长视频没有分层摘要

**现状**：`chunkTranscriptSegments` 只做标记，全部转录仍一次性入 Prompt（详见 8.10）。

**影响**：超过 1-2 小时的视频可能超出上下文窗口或产生高昂成本。

**改进方向**：

```text
第一层（Map）：
  转录按 token 数分块（而非字符数），每块独立生成结构化中间摘要
  { chunkIndex, startSeconds, endSeconds, keyPoints[], quotes[], entities[] }
  → 可并行调用，用小模型即可

第二层（Reduce）：
  合并所有中间摘要 → 生成全局大纲与最终文章
  → 用大模型，输入量已大幅压缩

时间戳保留：
  中间摘要携带 startSeconds，最终文章据此生成链接
```

同时建议增加 token 估算与预警，在超限前提示用户。

#### （3）问答不是 RAG

**现状**：每次发送完整摘要或完整转录（详见 9.1）。

**影响**：长视频问答成本高、速度慢，且模型在长上下文中容易"迷失中间部分"。

**改进方向**：

```text
索引阶段（转录完成后一次性）：
  TranscriptSegment[] → 按语义边界合并成 chunk
                     → embedding（本地模型如 bge-m3，或云端）
                     → 存入本地向量索引（如 sqlite-vec / LanceDB）

查询阶段：
  问题 → embedding → Top-K 检索（K=5~10）
       → 可选 rerank
       → 拼接命中片段 + 时间戳 → LLM
       → 回答中带 [MM:SS] 引用
```

收益：token 消耗降低一个数量级，回答可附精确出处，且天然支持跨视频检索。

#### （4）没有真正的多轮上下文

**现状**：历史消息存储且展示，但不重新发送给模型（详见 9.1）。

**影响**：用户无法使用"他刚才说的那个"这类指代。

**改进方向**：

```ts
createChatPrompt({
  video, question, contextMode, summary, transcript,
  history,                        // 新增
  maxHistoryTurns = 6,            // 滑动窗口
  historySummary,                 // 超窗时的历史压缩摘要
})
```

实现要点：滑动窗口保留最近 N 轮 + 更早历史压缩成一段摘要，避免历史无限增长。

#### （5）未使用 Provider 原生结构化输出

**现状**：靠 Prompt 要求 JSON + 手工解析 + 手工校验。

**改进方向**：

| Provider | 可用机制 |
| --- | --- |
| OpenAI | `response_format: { type: "json_schema", json_schema: {...}, strict: true }` |
| Gemini | `generationConfig.responseSchema` + `responseMimeType: "application/json"` |
| Anthropic | tool use / `input_schema` |

统一做法：用 Zod 定义 schema（项目已在 `packages/openbrief-content` 用了 Zod），通过 `zod-to-json-schema` 生成各厂商所需格式，同时保留现有的手工校验作为兜底（不支持的 Provider 仍走 Prompt 约束）。

收益：格式错误率大幅下降，重试次数减少。

#### （6）缺少事实一致性验证

**现状**：System Prompt 反复强调"不许编造"，但生成后没有任何程序化验证。

**可验证的项目**（且成本很低）：

| 验证项 | 实现方式 |
| --- | --- |
| 摘要中的时间戳是否真实存在 | 提取所有 `#openbrief-timestamp-N`，检查 N ≤ 视频时长且落在某个 segment 范围内 |
| 引用是否逐字匹配 | 提取 `## Notable Quotes` 中的引文，在转录全文中做模糊匹配 |
| 测验答案是否有据 | 对每题答案在转录中检索支撑句，无支撑则标记 |
| 章节顺序是否单调 | 检查 Key Sections 的时间戳是否递增 |

**改进方向**：新增 `domain/verification.ts`，生成后自动跑一遍，把可疑项在界面上标记（而非直接丢弃），让用户知道哪些内容需要人工确认。

#### （7）核心文件过大

**现状**：

| 文件 | 行数 | 职责数 |
| --- | ---: | --- |
| `app/AppShell.tsx` | ~3490 | 导入、转录、摘要、问答、播客、测验、TTS、设置、播放、通知、导航… |
| `hooks/useMediaLibrary.ts` | ~1729 | 全部任务状态与编排 |

**影响**：单文件承载过多职责，修改任一功能都要在数千行中定位；也难以对单个功能做隔离测试。

**改进方向**：

```text
useMediaLibrary.ts 拆为：
  ├─ useMediaLibraryState.ts     快照与持久化（核心）
  ├─ useIngestPipeline.ts        导入任务
  ├─ useTranscriptPipeline.ts    转录任务
  ├─ useSummaryAgent.ts          摘要 Agent 协作
  ├─ useChatGeneration.ts        问答任务
  ├─ usePodcastGeneration.ts     播客任务
  └─ useQuizGeneration.ts        测验任务

AppShell.tsx 拆为：
  ├─ AppShell.tsx                仅路由与布局
  ├─ providers/                  各类 Context Provider
  └─ 各 feature 自行管理其对话框与状态
```

**对 OpenVideo 的建议**：从第一天就按功能切分 hook，不要等到几千行再拆。

### 14.3 快速参考：关键文件索引

想深入某个主题时，直接看这些文件：

| 主题 | 文件 |
| --- | --- |
| 视频下载参数 | `src-tauri/src/helper_sidecar.rs` → `download_youtube_plan` |
| 转码/截图/提音频参数 | `src-tauri/src/helper_sidecar.rs` → `transcode_video_plan` / `extract_thumbnail_plan` / `extract_audio_plan` |
| 字幕与 STT 编排 | `src/services/transcriptService.ts` |
| STT 引擎路由 | `src/domain/transcript.ts` + `src-tauri/src/helper.rs` |
| 摘要 Prompt | `src/domain/summary.ts` |
| 问答 Prompt | `src/domain/chat.ts` |
| 播客 Prompt 与校验 | `src/domain/podcast.ts` |
| 测验 Prompt 与校验 | `src/domain/quiz.ts` |
| 校对/翻译 TSV 协议 | `src/domain/transcript-actions.ts` |
| 断点续传 | `src/services/summaryChatService.ts` → `completeTranscriptTransformWithResume` |
| LLM 请求构造 | `src/domain/provider.ts` |
| 续写与失败处理 | `src/services/providerService.ts` |
| 各厂商响应解析 | `src/services/providerAdapters.ts` |
| Rust HTTP 与 SSE | `src-tauri/src/provider.rs` |
| 任务状态编排 | `src/hooks/useMediaLibrary.ts` |
| 持久化 | `src/services/mediaLibraryRepository.ts` + `src-tauri/src/media_library.rs` |
| 核心数据类型 | `src/domain/media-library.ts` |
| Helper 协议 | `src/domain/helper-protocol.ts` |
| 架构规范 | `AGENTS.md` |
| 模型存储规范 | `docs/LOCAL_MODEL.md` |

### 14.4 一句话总结

> OpenBrief 的本质是一个**设计相当完整的 transcript-first 桌面内容生成系统**：用 yt-dlp + ffmpeg 把任意视频规整为可播放媒体，用字幕或本地 ASR 得到统一的时间戳文本，再用手写的 Prompt Builder 与 Provider 适配层调用大模型产出摘要、问答、播客、测验，最后通过时间戳链接把生成内容与原视频重新绑定。
>
> 它的工程价值不在于用了多先进的 AI 技术，而在于**分层清晰、边界严格、对 LLM 输出不轻信、对失败有回退**。这些恰恰是从 Demo 走向可用产品最关键的部分。
>
> 它的主要局限是**尚未触及视觉理解，且长文本处理策略偏简单**——这两点正是 OpenVideo 可以选择差异化投入的方向。
