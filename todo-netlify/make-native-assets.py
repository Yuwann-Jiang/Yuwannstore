#!/usr/bin/env python3
"""
生成 HBuilderX 5+App 打包所需的全套图标与启动图。

策略：先渲染一张高分辨率「母图」，再用盒式降采样生成所有尺寸
（既快，边缘也比逐个尺寸渲染更平滑）。

输出到 ../todo-app-native/unpackage/res/{icons,splash}/
"""
import os
import sys
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))

# 动态导入 make-icons.py（文件名含连字符，无法用普通 import）
spec = importlib.util.spec_from_file_location("mk", os.path.join(HERE, "make-icons.py"))
mk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mk)

PROJECT = os.path.join(os.path.dirname(HERE), "todo-app-native")
RES_ICONS = os.path.join(PROJECT, "unpackage", "res", "icons")
RES_SPLASH = os.path.join(PROJECT, "unpackage", "res", "splash")

MASTER = 1536  # 母图边长

ANDROID_ICONS = [48, 72, 96, 144, 192]
IOS_ICONS = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024]

SPLASHES = [
    (480, 800),
    (720, 1280),
    (1080, 1920),
    (750, 1334),
    (1242, 2208),
    (1125, 2436),
    (1170, 2532),
    (1290, 2796),
    (1536, 2048),
]

BG = (244, 246, 251)


def downsample(src, src_size, dst_size):
    """盒式降采样，带 alpha 加权，避免边缘发黑。"""
    if dst_size == src_size:
        return src
    ratio = src_size / dst_size
    out = []
    for dy in range(dst_size):
        y0 = int(dy * ratio)
        y1 = max(y0 + 1, int((dy + 1) * ratio))
        row = bytearray(dst_size * 4)
        for dx in range(dst_size):
            x0 = int(dx * ratio)
            x1 = max(x0 + 1, int((dx + 1) * ratio))
            ar = ag = ab = aa = 0
            n = 0
            for sy in range(y0, y1):
                srow = src[sy]
                base = sy  # noqa
                for sx in range(x0, x1):
                    o = sx * 4
                    a = srow[o + 3]
                    ar += srow[o] * a
                    ag += srow[o + 1] * a
                    ab += srow[o + 2] * a
                    aa += a
                    n += 1
            o = dx * 4
            if aa == 0:
                row[o] = row[o + 1] = row[o + 2] = row[o + 3] = 0
            else:
                row[o] = ar // aa
                row[o + 1] = ag // aa
                row[o + 2] = ab // aa
                row[o + 3] = aa // n
        out.append(bytes(row))
    return out


def make_splash(w, h, logo, logo_size):
    """浅色背景 + 居中偏上的 logo。"""
    bg_pixel = bytes((BG[0], BG[1], BG[2], 255))
    x0 = (w - logo_size) // 2
    y0 = int(h * 0.36)

    rows = []
    for y in range(h):
        if not (y0 <= y < y0 + logo_size):
            rows.append(bg_pixel * w)
            continue
        lrow = logo[y - y0]
        row = bytearray(bg_pixel * w)
        for lx in range(logo_size):
            lo = lx * 4
            la = lrow[lo + 3]
            if la == 0:
                continue
            o = (x0 + lx) * 4
            row[o] = (lrow[lo] * la + BG[0] * (255 - la)) // 255
            row[o + 1] = (lrow[lo + 1] * la + BG[1] * (255 - la)) // 255
            row[o + 2] = (lrow[lo + 2] * la + BG[2] * (255 - la)) // 255
            row[o + 3] = 255
        rows.append(bytes(row))
    return rows


def main():
    os.makedirs(RES_ICONS, exist_ok=True)
    os.makedirs(RES_SPLASH, exist_ok=True)

    print(f"渲染 {MASTER}x{MASTER} 母图（约需 10-30 秒）...")
    mk.SS = 1  # 母图本身就是高分辨率，无需超采样
    master = mk.render(MASTER, full_bleed=False, content_scale=1.0)
    print("母图完成\n")

    print("=== 图标 ===")
    for s in sorted(set(ANDROID_ICONS + IOS_ICONS)):
        img = downsample(master, MASTER, s)
        p = os.path.join(RES_ICONS, f"{s}x{s}.png")
        mk.write_png(p, s, s, img)
        print(f"  {s}x{s}.png")

    # 母图本身也存一份，供 HBuilderX 的「自动生成图标」使用
    mk.write_png(os.path.join(PROJECT, "icon-source-1024.png"), 1024, 1024,
                 downsample(master, MASTER, 1024))
    print("  icon-source-1024.png（HBuilderX 生成图标用的源图）")

    print("\n=== 启动图 ===")
    for w, h in SPLASHES:
        ls = int(min(w, h) * 0.28)
        logo = downsample(master, MASTER, ls)
        img = make_splash(w, h, logo, ls)
        p = os.path.join(RES_SPLASH, f"{w}x{h}.png")
        mk.write_png(p, w, h, img)
        print(f"  {w}x{h}.png  ({os.path.getsize(p)} 字节)")

    print("\n完成。")


if __name__ == "__main__":
    main()
