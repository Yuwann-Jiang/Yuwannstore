#!/bin/bash
# 校验安卓安装包：包内版本号、打包进去的页面是否最新、签名能否覆盖升级
#
# 用法：
#   ./verify-apk.sh                       # 校验最新的包，并与上一个包对比
#   ./verify-apk.sh 新.apk 旧.apk         # 指定两个包对比
#
# 为什么这么查：
#   1. DCloud 云打包出的 APK 里，**应用版本号不看 AndroidManifest**，
#      真正生效的是包内 assets/apps/<AppID>/www/manifest.json 的 version。
#      所以直接读包内文件，最准。
#   2. 顺便检查包内 index.html 有没有这次的新功能按钮 —— 确认打包时
#      用的是最新的网页源码，而不是残留的旧文件。
#   3. 签名必须和旧包一致，否则手机上装不上去（得先卸载）。
#
# 依赖 HBuilderX 自带的 JDK / apktool / apksigner，无需额外安装。

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HX="/Applications/HBuilderX.app/Contents/HBuilderX/plugins"
JAVA="$HX/amazon-corretto/bin/java"
APKTOOL="$HX/app-safe-pack/apktool.jar"
APKSIGNER="$HX/app-safe-pack/apksigner.jar"

[ -x "$JAVA" ] || { echo "找不到 HBuilderX 自带的 java：$JAVA" >&2; exit 1; }

list_apks() {
  find "$HERE/unpackage/release/apk" -maxdepth 1 -name "*.apk" -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null
}

if [ "$#" -ge 2 ]; then
  NEW="$1"; OLD="$2"
elif [ "$#" -eq 1 ]; then
  NEW="$1"; OLD="$(list_apks | sed -n '2p')"
else
  NEW="$(list_apks | sed -n '1p')"
  OLD="$(list_apks | sed -n '2p')"
fi

[ -n "${NEW:-}" ] && [ -f "$NEW" ] || { echo "没有找到 apk，请先在 HBuilderX 里打包" >&2; exit 1; }

fingerprint() { # 只取证书 SHA-256，便于对比
  "$JAVA" -jar "$APKSIGNER" verify --print-certs "$1" 2>/dev/null \
    | grep -i "SHA-256 digest" | head -1 | awk '{print $NF}'
}

bundle_info() { # bundle_info <apk> <标签>
  python3 - "$1" "$2" <<'PY'
import sys, json, zipfile
apk, tag = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(apk)
www = [n for n in z.namelist() if n.startswith("assets/apps/") and n.endswith("/www/manifest.json")]
if not www:
    print(f"  [{tag}] 包内没有 assets/apps/*/www/manifest.json，可能不是 5+App 云打包产物")
    sys.exit(0)
base = www[0][:-len("manifest.json")]
m = json.loads(z.read(www[0]).decode("utf-8"))
v = m.get("version") or {}
html_name = base + "index.html"
html = z.read(html_name).decode("utf-8", errors="replace") if html_name in z.namelist() else ""
print(f"  [{tag}] 包内版本 = {v.get('name')} (code {v.get('code')})")
print(f"  [{tag}] 应用名 = {m.get('name')} · AppID = {m.get('id')}")
print(f"  [{tag}] 包内页面 = {len(html)} 字符 · 后端地址 = "
      + ("已注入" if "window.__API_BASE__" in html else "缺失！"))
feats = [("统计页", "statsBtn"), ("导出日历", "exportBtn"), ("撤销提示", "toastAction"),
         ("原生下载分支", "plus.downloader")]
got = [name for name, kw in feats if kw in html]
miss = [name for name, kw in feats if kw not in html]
print(f"  [{tag}] 新功能包含 = {'、'.join(got) if got else '无'}")
if miss:
    print(f"  [{tag}] ⚠ 缺少 = {'、'.join(miss)}  ← 打包时用的可能不是最新页面")
PY
}

apk_package() { # 从 AndroidManifest 里取真实包名
  local dir; dir="$(mktemp -d)"
  "$JAVA" -jar "$APKTOOL" d -f -s "$1" -o "$dir/lib" >/dev/null 2>&1
  grep -o 'package="[^"]*"' "$dir/lib/AndroidManifest.xml" 2>/dev/null | head -1 | cut -d'"' -f2
  rm -rf "$dir"
}

echo "== 待校验 =="
echo "  新包：$NEW"
if [ -n "${OLD:-}" ] && [ -f "${OLD:-}" ]; then echo "  旧包：$OLD"; else echo "  旧包：（无，跳过对比）"; fi
echo
echo "== 新包 =="
bundle_info "$NEW" "新"
echo "  [新] 真实包名 = $(apk_package "$NEW")"
NEW_FP="$(fingerprint "$NEW")"
echo "  [新] 签名 SHA-256 = ${NEW_FP:-读取失败}"

if [ -n "${OLD:-}" ] && [ -f "${OLD:-}" ]; then
  echo
  echo "== 旧包 =="
  bundle_info "$OLD" "旧"
  echo "  [旧] 真实包名 = $(apk_package "$OLD")"
  OLD_FP="$(fingerprint "$OLD")"
  echo "  [旧] 签名 SHA-256 = ${OLD_FP:-读取失败}"

  echo
  echo "== 能否直接覆盖升级 =="
  if [ -n "$NEW_FP" ] && [ "$NEW_FP" = "$OLD_FP" ]; then
    echo "  ✓ 签名一致 → 手机上可以直接覆盖安装，登录态保留"
  else
    echo "  ✗ 签名不一致 → 手机必须先卸载旧版再装新版"
  fi
fi
