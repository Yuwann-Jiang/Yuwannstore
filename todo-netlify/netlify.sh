#!/bin/bash
# netlify-cli 包装脚本
#
# 为什么需要它：netlify-cli 默认把配置写到 ~/Library/Preferences/netlify，
# 该目录在受限环境下没有写权限（EPERM）。这里把 HOME 重定向到项目内的一个
# 临时目录，既避开权限错误，也不污染系统目录。
#
# 用法：./netlify.sh deploy --prod        （等同于 netlify deploy --prod）
#
# 注：这只在本机受限环境（沙箱 / 无写权限）下才需要；
#     普通开发机可以直接用 npx netlify 或全局安装的 netlify。

HERE="$(cd "$(dirname "$0")" && pwd)"

# 把 HOME 指到项目内的临时目录（已在 .gitignore 中忽略）
export HOME="$HERE/.fake-home"
mkdir -p "$HOME"

# 认证令牌：优先用环境变量，其次读本机的 .netlify-token（权限 600，已在 .gitignore 排除）
# 这样脚本里不会出现任何硬编码凭据，换台机器时把文件放回来即可。
if [ -z "${NETLIFY_AUTH_TOKEN:-}" ] && [ -f "$HERE/.netlify-token" ]; then
  NETLIFY_AUTH_TOKEN="$(tr -d '[:space:]' < "$HERE/.netlify-token")"
  export NETLIFY_AUTH_TOKEN
fi

# 站点 ID：netlify-cli 17.x 的 env:* / blobs:* 子命令只认 --site 之外的 SITE_ID 变量
if [ -z "${NETLIFY_SITE_ID:-}" ] && [ -f "$HERE/.netlify/state.json" ]; then
  NETLIFY_SITE_ID="$(sed -n 's/.*"siteId":"\([^"]*\)".*/\1/p' "$HERE/.netlify/state.json")"
  export NETLIFY_SITE_ID
fi

# 优先用本地安装的 netlify-cli，其次回退到全局命令
if [ -x "$HERE/node_modules/.bin/netlify" ]; then
  exec "$HERE/node_modules/.bin/netlify" "$@"
elif command -v netlify >/dev/null 2>&1; then
  exec netlify "$@"
else
  echo "找不到 netlify-cli，请先在 todo-netlify/ 下执行 npm install" >&2
  exit 1
fi
