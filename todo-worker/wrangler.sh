#!/bin/bash
# wrangler 包装脚本
#
# 为什么需要它：wrangler 默认把配置和日志写到 ~/Library/Preferences/.wrangler，
# 该目录在受限环境下没有写权限。这里通过 XDG 环境变量把它重定向到项目内的
# 临时目录，避免 EPERM 错误，也不污染系统目录。
#
# 用法：./wrangler.sh deploy        （等同于 wrangler deploy）
#       ./wrangler.sh kv namespace create TODO_KV
#
# 注：这只在本机受限环境（沙箱 / 无写权限）下才需要；
#     普通开发机可以直接用 npx wrangler 或全局安装的 wrangler。

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="$HERE/.wrangler-home"

export XDG_CONFIG_HOME="$BASE/config"
export XDG_CACHE_HOME="$BASE/cache"
export XDG_DATA_HOME="$BASE/data"
export XDG_STATE_HOME="$BASE/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

if [ -x "$HERE/node_modules/.bin/wrangler" ]; then
  exec "$HERE/node_modules/.bin/wrangler" "$@"
elif command -v wrangler >/dev/null 2>&1; then
  exec wrangler "$@"
else
  echo "找不到 wrangler，请先在 todo-worker/ 下执行 npm install" >&2
  exit 1
fi
