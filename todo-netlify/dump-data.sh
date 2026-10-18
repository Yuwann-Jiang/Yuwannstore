#!/bin/bash
# 读取 Netlify Blobs 中所有账号与待办（只读，不改动任何数据）
#
# 用法：
#   export NETLIFY_AUTH_TOKEN='你的 Netlify 个人访问令牌'
#   export NETLIFY_SITE_ID='你的站点 ID'
#   ./dump-data.sh
#
# ⚠️ 凭据一律通过环境变量传入，**不要**写死在本文件里
#    （本文件会提交到公开仓库）。
set -uo pipefail

cd "$(dirname "$0")"

if [ -z "${NETLIFY_AUTH_TOKEN:-}" ] || [ -z "${NETLIFY_SITE_ID:-}" ]; then
  echo "错误：请先设置 NETLIFY_AUTH_TOKEN 与 NETLIFY_SITE_ID 环境变量" >&2
  echo "  export NETLIFY_AUTH_TOKEN='...'" >&2
  echo "  export NETLIFY_SITE_ID='...'" >&2
  exit 1
fi

OUT="${OUT_DIR:-/tmp/netlify-dump}"
mkdir -p "$OUT"

./netlify.sh blobs:list todo-app 2>/dev/null \
  | grep -o -E '^\| [a-z]+:[^ ]+' | sed 's/^| //' | sed 's/ *$//' > "$OUT/keys.txt"

grep '^user:'  "$OUT/keys.txt" | sed 's/^user://'  > "$OUT/users.txt"  || true
grep '^todos:' "$OUT/keys.txt" | sed 's/^todos://' > "$OUT/todousers.txt" || true

echo "开始读取 $(wc -l < "$OUT/users.txt" | tr -d ' ') 个账号..."
while read -r u; do
  [ -n "$u" ] || continue
  ./netlify.sh blobs:get todo-app "user:$u"  > "$OUT/user_$u.json"  2>/dev/null || true
  ./netlify.sh blobs:get todo-app "todos:$u" > "$OUT/todos_$u.json" 2>/dev/null || true
done < "$OUT/users.txt"
echo "读取完成，输出目录：$OUT"
