#!/usr/bin/env python3
"""
生成 PWA 应用图标（纯标准库，零依赖）。

设计：靛蓝色圆角方块 + 白色对勾 + 底部三个红/黄/绿小圆点
（呼应待办的到期着色规则）。

输出：public/icons/ 下的 192 / 512 / 180 / 32 像素 PNG。
"""
import zlib
import struct
import os
import math

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "icons")

# 品牌色
INDIGO = (79, 70, 229)      # #4f46e5
WHITE = (255, 255, 255)
RED = (229, 72, 77)         # #e5484d
YELLOW = (234, 179, 8)      # #eab308
GREEN = (22, 163, 74)       # #16a34a

SS = 4  # 超采样倍数（抗锯齿）


def write_png(path, width, height, rgba_rows):
    """把 RGBA 像素写成 PNG（8 位/通道，含 alpha）。"""
    raw = b"".join(b"\x00" + row for row in rgba_rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def rounded_rect_alpha(x, y, size, radius):
    """点 (x,y) 在圆角矩形内的覆盖率（0..1）。"""
    r = radius
    # 把坐标折到第一象限
    cx = min(x, size - x)
    cy = min(y, size - y)
    if cx >= r or cy >= r:
        return 1.0  # 直边区域
    # 圆角区域：判断到圆心 (r, r) 的距离
    dx = r - cx
    dy = r - cy
    return 1.0 if dx * dx + dy * dy <= r * r else 0.0


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return math.sqrt(dx * dx + dy * dy)


def render(size, full_bleed=False, content_scale=1.0):
    """在 size×size 上渲染图标，返回 RGBA 行列表。

    full_bleed=True  画满整个画布（用于 maskable 图标，系统会自行裁切形状）
    content_scale    内容缩放，maskable 时需缩小以留出安全区
    """
    S = size * SS
    radius = 0 if full_bleed else S * 0.22

    def tx(p):  # 相对坐标 -> 画布坐标（带缩放，围绕中心）
        return (0.5 + (p - 0.5) * content_scale) * S

    def ty(p):
        return (0.5 + (p - 0.5) * content_scale) * S

    # 对勾的三段线（相对坐标）
    check_pts = [(0.27, 0.53), (0.43, 0.69), (0.74, 0.34)]
    stroke = S * 0.085 * content_scale
    # 三个小圆点
    dots = [
        (0.34, 0.845, RED),
        (0.50, 0.845, YELLOW),
        (0.66, 0.845, GREEN),
    ]
    dot_r = S * 0.036 * content_scale

    # 先在超采样分辨率上合成
    hi = []
    for y in range(S):
        row = bytearray(S * 4)
        for x in range(S):
            fx, fy = x + 0.5, y + 0.5

            # 背景（圆角矩形，或 maskable 时满幅）
            if not full_bleed:
                if rounded_rect_alpha(fx, fy, S, radius) <= 0:
                    continue

            r, g, b = INDIGO

            # 对勾
            d = min(
                dist_to_segment(fx, fy, tx(check_pts[0][0]), ty(check_pts[0][1]),
                                tx(check_pts[1][0]), ty(check_pts[1][1])),
                dist_to_segment(fx, fy, tx(check_pts[1][0]), ty(check_pts[1][1]),
                                tx(check_pts[2][0]), ty(check_pts[2][1])),
            )
            if d <= stroke / 2:
                r, g, b = WHITE

            # 小圆点
            for ddx, ddy, col in dots:
                dx, dy = fx - tx(ddx), fy - ty(ddy)
                if dx * dx + dy * dy <= dot_r * dot_r:
                    r, g, b = col
                    break

            o = x * 4
            row[o] = r
            row[o + 1] = g
            row[o + 2] = b
            row[o + 3] = 255
        hi.append(bytes(row))

    # 降采样（盒式平均）得到最终图
    rows = []
    for y in range(size):
        out = bytearray(size * 4)
        for x in range(size):
            ar = ag = ab = aa = 0
            for sy in range(SS):
                hrow = hi[y * SS + sy]
                for sx in range(SS):
                    o = (x * SS + sx) * 4
                    a = hrow[o + 3]
                    ar += hrow[o] * a
                    ag += hrow[o + 1] * a
                    ab += hrow[o + 2] * a
                    aa += a
            n = SS * SS
            o = x * 4
            if aa == 0:
                out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
            else:
                out[o] = ar // aa
                out[o + 1] = ag // aa
                out[o + 2] = ab // aa
                out[o + 3] = aa // n
        rows.append(bytes(out))
    return rows


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        (192, "icon-192.png", False, 1.0),
        (512, "icon-512.png", False, 1.0),
        (180, "apple-touch-icon.png", False, 1.0),
        (32, "favicon-32.png", False, 1.0),
        # maskable：满幅背景 + 内容缩到 72%，留出系统裁切安全区
        (512, "icon-maskable-512.png", True, 0.72),
    ]
    for size, name, full_bleed, scale in targets:
        rows = render(size, full_bleed=full_bleed, content_scale=scale)
        path = os.path.join(OUT_DIR, name)
        write_png(path, size, size, rows)
        print(f"  已生成 {name}  ({size}x{size}, {os.path.getsize(path)} 字节)")


if __name__ == "__main__":
    main()
