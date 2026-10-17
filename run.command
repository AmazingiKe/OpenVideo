#!/bin/zsh -l

emulate -LR zsh
setopt nounset

readonly PROJECT_ROOT="${0:A:h}"
readonly MINIMUM_NODE_MAJOR=22

# Finder 启动时的 PATH 可能缺少 Homebrew、uv 和 pnpm 的默认安装目录。
typeset -U path
path+=(/opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "${PNPM_HOME:-$HOME/Library/pnpm}")

function fail_start() {
  print -u2 -- "$1"
  if [[ -t 0 ]]; then
    read -r "?按回车键关闭此窗口…"
  fi
  exit 1
}

cd "$PROJECT_ROOT" || fail_start "无法进入项目目录：$PROJECT_ROOT"

missing_tools=()
for required_tool in node pnpm uv; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    missing_tools+=("$required_tool")
  fi
done
if (( ${#missing_tools} > 0 )); then
  fail_start "缺少启动依赖：${(j:、:)missing_tools}。请按项目 README 的环境要求安装后重试。"
fi

node_major=$(node -p 'Number.parseInt(process.versions.node, 10)') || fail_start "无法运行 Node.js，请检查安装。"
if (( node_major < MINIMUM_NODE_MAJOR )); then
  fail_start "需要 Node.js ${MINIMUM_NODE_MAJOR} 或更高版本，当前主版本为 ${node_major}。"
fi
if [[ ! -d node_modules || ! -d apps/web/node_modules ]]; then
  fail_start "尚未安装前端依赖，请先在项目根目录执行：pnpm install"
fi

print -- "正在启动 OpenVideo，浏览器将自动打开。按 Ctrl+C 停止前后端。"
print -- "首次启动时 uv 会准备后端环境，可能需要较长时间。"
node scripts/dev.mjs --open || fail_start "OpenVideo 启动失败，请查看上方错误和开发日志。"
