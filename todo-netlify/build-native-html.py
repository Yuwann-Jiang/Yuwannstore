#!/usr/bin/env python3
"""
把网页版 index.html 转成原生 App 内的 index.html。

两个版本共用同一份源码，只在最前面注入一小段配置：
  window.__API_BASE__  —— 指定后端地址（App 内不是同源，必须显式指定）
  window.__NATIVE_APP__ —— 标记运行在原生 App 中（隐藏"安装到桌面"按钮等）

这样以后改网页版，重新跑一次本脚本即可同步到 App。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "public", "index.html")
DST = os.path.join(os.path.dirname(HERE), "todo-app-native", "index.html")

API_BASE = "https://yuwann-todo.netlify.app"

INJECT = """<script>
  // ===== 由 build-native-html.py 自动注入：原生 App 运行配置 =====
  window.__API_BASE__ = "%s";
  window.__NATIVE_APP__ = true;
</script>
""" % API_BASE


def main():
    with open(SRC, encoding="utf-8") as f:
        html = f.read()

    # 在第一个 <script> 之前注入配置
    m = re.search(r"<script>", html)
    if not m:
        print("错误：源文件中找不到 <script> 标签", file=sys.stderr)
        sys.exit(1)

    out = html[: m.start()] + INJECT + html[m.start():]

    # App 内不需要 PWA 清单与 Service Worker（微信/原生 WebView 不支持）
    out = out.replace('<link rel="manifest" href="/manifest.webmanifest" />',
                      "<!-- 原生 App 内不需要 PWA 清单 -->")
    out = out.replace('if ("serviceWorker" in navigator) {',
                      'if (false && "serviceWorker" in navigator) {')

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with open(DST, "w", encoding="utf-8") as f:
        f.write(out)

    print(f"已生成 App 页面: {DST}")
    print(f"  源文件      : {SRC}")
    print(f"  注入的后端  : {API_BASE}")
    print(f"  文件大小    : {os.path.getsize(DST)} 字节")


if __name__ == "__main__":
    main()
