# DeepSeek 环境密钥

模型设置的「API 密钥」可填写 `env:DEEPSEEK_API_KEY`。设置文件和设置 API 只保存、返回这个引用；实际值只在后端请求时读取。原有直接填写密钥的配置仍可使用，但会以明文存入 `preferences.json`，并不是加密凭据库。

## 自行配置

1. 在系统用户配置目录的 `OpenVideo/.env` 中自行填写 `DEEPSEEK_API_KEY`。可参考仓库根目录 `.env.example` 的 `DEEPSEEK_API_KEY=` 行，其他配置无需复制；不要覆盖已有文件，不要把真实密钥放入聊天、Git 或前端 `VITE_*` 变量。
   - Windows：`%LOCALAPPDATA%\OpenVideo\.env`
   - Linux：通常为 `~/.config/OpenVideo/.env`，遵循 `XDG_CONFIG_HOME`
   - macOS：`~/Library/Application Support/OpenVideo/.env`
2. 启动时选择一种方式：把变量设置在启动后端的进程环境中，然后使用原有启动命令；或在仓库根目录显式执行：

   ```text
   uv run --directory apps/backend uvicorn openvideo.ui.api:app --host 127.0.0.1 --port 38471 --env-file "你的用户配置目录/OpenVideo/.env"
   ```

   然后另开终端执行 `pnpm dev:web`。`--env-file` 使用现有 `uvicorn[standard]` 的 dotenv 支持；已有进程环境变量优先，文件不会覆盖它们。普通 `pnpm dev` 不会自动读取 `.env`。本功能不会创建、修改或迁移任何真实环境文件。
3. 在模型设置中填写服务商提供的模型名称、API 地址 `https://api.deepseek.com` 和密钥引用 `env:DEEPSEEK_API_KEY`。多个模型可共用同一个引用。不要仅凭模型名称勾选图片、音频或视频输入，按实际支持能力配置。
4. 重启后端使环境文件变更生效。模型测试会发起真实付费 API 请求，只有准备好后再自行点击测试。

## 安全与范围

- 当前只允许引用 `DEEPSEEK_API_KEY`，并且仅允许官方 DeepSeek HTTPS 地址，含可选 `/v1`。自定义网关请使用独立的显式密钥；不能借此读取任意后端环境变量或把 DeepSeek 环境密钥转发到其他站点。
- 环境引用缺失、为空或目标不匹配时，在发起请求前失败。DeepSeek 空白密钥不再依赖 SDK 隐式环境回退，请明确填写引用。
- 聊天 Agent、文本任务、字幕纠错、视觉请求和能力探测使用同一解析规则。此配置不会让文本模型获得视觉或音频能力；原始语音转录仍使用本地 Whisper/Qwen/SenseVoice。
- 已解析的密钥及轮换前值只留在进程内存，用于请求和日志/错误脱敏，不写入偏好设置。不要开启第三方网络抓包或请求体转储；环境变量和 `.env` 本身也不是加密保险库。
- Git 忽略 `.env` 和 `.env.*`（仅 `.env.example` 例外），但忽略规则无法保护已被跟踪的文件；提交前仍应检查。

本次验证只使用明显的假值和模拟响应，未读取真实密钥、调用真实服务或验证账户可用性。
