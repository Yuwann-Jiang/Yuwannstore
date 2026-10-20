#!/bin/bash
# 打包前自检：确认 HBuilderX 里点「云打包」之前，工程内容是新的、版本是对的
#
# 用法：./preflight.sh
#
# 检查四件事：
#   1. App 内页面是不是从最新的网页源码生成的（不是残留的旧文件）
#   2. 新功能有没有真的在这份页面里（统计 / 导出日历 / 纪念 / 农历 / 撤销）
#   3. manifest.json 的版本号是否已递增（Android 靠 versionCode 升级）
#   4. 图标与启动图是否齐全

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

pass=0; fail=0; warn=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }
note() { echo "  ! $1"; warn=$((warn+1)); }

echo "==================== 打包前自检 ===================="
echo

echo "[1] 页面是否与网页版同步"
WEB="../todo-netlify/public/index.html"
if [ ! -f "$WEB" ]; then
  bad "找不到网页版源码：$WEB"
else
  # 用生成脚本产出一份到临时文件，跟现有的比
  TMP="$(mktemp -d)"
  if python3 ../todo-netlify/build-native-html.py >/dev/null 2>&1; then
    if grep -q "window.__NATIVE_APP__" index.html; then
      ok "index.html 已由 build-native-html.py 生成（含原生注入）"
    else
      bad "index.html 缺少原生注入，请重新运行 python3 ../todo-netlify/build-native-html.py"
    fi
  else
    bad "生成脚本执行失败，请手动运行 python3 ../todo-netlify/build-native-html.py"
  fi
  rm -rf "$TMP"

  # 与网页源码做逐字比对：把生成的 3 处改动还原回去，应该与源文件一模一样
  if python3 - <<'PY'
import io, re, sys
web = io.open('../todo-netlify/public/index.html', encoding='utf-8').read()
native = io.open('index.html', encoding='utf-8').read()
stripped = re.sub(r'<script>\s*// ===== 由 build-native-html.py 自动注入.*?</script>\n',
                  '', native, flags=re.S)
stripped = stripped.replace("<!-- \u539f\u751f App \u5185\u4e0d\u9700\u8981 PWA \u6e05\u5355 -->",
                            '<link rel="manifest" href="/manifest.webmanifest" />')
stripped = stripped.replace('if (false && "serviceWorker" in navigator) {',
                            'if ("serviceWorker" in navigator) {')
sys.exit(0 if stripped == web else 1)
PY
  then ok "内容与网页版源码完全一致（仅差那 3 处原生改动）"
  else bad "与网页版不一致，请重新运行 python3 ../todo-netlify/build-native-html.py"
  fi
fi
echo

echo "[2] 新功能是否都在页面里"
check_feature() { # check_feature <名称> <关键词>
  if grep -q "$2" index.html; then ok "$1"; else bad "$1（缺少关键字 $2）"; fi
}
check_feature "待办编辑（✏️）"        'data-action="edit"'
check_feature "撤销完成（10 秒提示条）" 'toastAction'
check_feature "统计页"                'id="statsView"'
check_feature "导出待办到日历"        'id="exportBtn"'
check_feature "纪念视图"              'id="memorialView"'
check_feature "纪念：农历选择"        'id="memLunarYear"'
check_feature "纪念：导出到日历"      'id="memExport"'
check_feature "原生下载分支"          'plus.downloader'
echo

echo "[3] 版本号"
python3 - <<'PY'
import json, io, sys
m = json.load(io.open('manifest.json', encoding='utf-8'))
v = m.get('version') or {}
name, code = v.get('name'), v.get('code')
print(f"  · 当前版本：{name}（code {code}）")
print(f"  · AppID：{m.get('id')}")
pkg = ((m.get('plus') or {}).get('distribute') or {}).get('google') or {}
print(f"  · manifest 里的包名：{pkg.get('packagename')}")
try:
    code_n = int(code)
except (TypeError, ValueError):
    print("  ✗ versionCode 不是数字"); sys.exit(1)
if code_n >= 190:
    print("  ✓ versionCode ≥ 190，够用来覆盖升级")
else:
    print("  ✗ versionCode 偏小，手机会认为不是升级")
PY
echo

echo "[4] 图标与启动图"
for d in unpackage/res/icons unpackage/res/splash; do
  n=$(ls "$d" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -ge 9 ]; then ok "$d 共 $n 个文件"; else bad "$d 只有 $n 个文件"; fi
done
echo

echo "==================== 结论 ===================="
echo "  通过 $pass 项，失败 $fail 项，提醒 $warn 项"
if [ "$fail" -eq 0 ]; then
  echo "  ✅ 可以打包了：在 HBuilderX 里「发行 → 原生App-云打包」"
else
  echo "  ❌ 先修掉上面的失败项再打包"
fi
echo
echo "  打包对话框里请保持："
echo "    · 打包类型：正式版"
echo "    · Android 包名：plus.H5E0B88F1（与线上旧包一致，否则手机会装成两个 App）"
echo "    · 证书：与上次相同（换证书手机必须卸载重装）"
echo "    · 不要勾「安心打包」「代码混淆」（那是 uni-app 专用的）"
echo
echo "  打完跑一次：./verify-apk.sh"
echo "  它会读包内真正的版本号、检查新功能有没有打进去、比对签名能否覆盖升级。"
echo "===================================================="

exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
