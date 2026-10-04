# -*- coding: utf-8 -*-
"""
墨阅 · 图标生成脚本（纯标准库实现）
用有向距离场绘制抗锯齿图形，输出多尺寸 PNG 并打包为 .ico。
用法：python tools/make_icon.py [输出路径.ico] [预览.png]
"""
import math
import os
import struct
import sys
import zlib

# 设计稿坐标系：64×64
BG_TOP = (0xDC, 0x7E, 0x5D)
BG_BOTTOM = (0xBE, 0x5A, 0x38)
INK = (0xFF, 0xF7, 0xEE)


def lerp(a, b, t):
    return a + (b - a) * t


def sd_round_box(px, py, x0, y0, x1, y1, r_tl, r_tr, r_br, r_bl):
    """带四角独立圆角的矩形距离场（y 轴向下）"""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2, (y1 - y0) / 2
    if px >= cx:
        r = r_tr if py < cy else r_br
    else:
        r = r_tl if py < cy else r_bl
    qx = abs(px - cx) - hx + r
    qy = abs(py - cy) - hy + r
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return min(max(qx, qy), 0.0) + outside - r


def sd_segment(px, py, ax, ay, bx, by):
    """点到线段的距离"""
    pax, pay = px - ax, py - ay
    bax, bay = bx - ax, by - ay
    h = max(0.0, min(1.0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
    return math.hypot(pax - bax * h, pay - bay * h)


def render(size):
    scale = size / 64.0
    small = size <= 32
    stroke = 3.2 * (1.45 if small else 1.0)       # 小尺寸加粗线条，保证清晰
    line_w = 3.0 * (1.45 if small else 1.0)
    lines = [((25, 27.5), (39, 27.5)), ((25, 33.5), (39, 33.5))] if small else \
            [((25, 27), (39, 27)), ((25, 33), (39, 33)), ((25, 39), (34, 39))]
    pixels = bytearray(size * size * 4)
    ss = 4 if size <= 64 else 2                      # 超采样
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    ux = (x + (sx + 0.5) / ss) / scale
                    uy = (y + (sy + 0.5) / ss) / scale
                    d_bg = sd_round_box(ux, uy, 2, 2, 62, 62, 14, 14, 14, 14)
                    if d_bg > 0:
                        continue
                    t = uy / 64.0
                    col = [lerp(BG_TOP[i], BG_BOTTOM[i], t) for i in range(3)]
                    # 书页轮廓
                    d_page = abs(sd_round_box(ux, uy, 18, 18, 46, 46, 0, 8, 0, 8)) - stroke / 2
                    d = d_page
                    for (a, b) in lines:
                        d = min(d, sd_segment(ux, uy, a[0], a[1], b[0], b[1]) - line_w / 2)
                    # 子像素采样只判断内外，抗锯齿由超采样平均得到
                    if d <= 0:
                        col = list(INK)
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 1.0
            n = ss * ss
            i = (y * size + x) * 4
            a = acc[3] / n
            if a > 0:
                pixels[i] = int(round(acc[0] / acc[3]))
                pixels[i + 1] = int(round(acc[1] / acc[3]))
                pixels[i + 2] = int(round(acc[2] / acc[3]))
                pixels[i + 3] = int(round(a * 255))
    return pixels


def png_bytes(size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'host', 'app.ico')
    preview = sys.argv[2] if len(sys.argv) > 2 else None
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    images = []
    for s in sizes:
        images.append((s, png_bytes(s, render(s))))
        print('已生成', s, 'px', flush=True)
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b''
    data = b''
    for s, png in images:
        dim = 0 if s >= 256 else s
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    with open(out, 'wb') as f:
        f.write(header + entries + data)
    print('图标已写入', os.path.abspath(out))
    if preview:
        with open(preview, 'wb') as f:
            f.write(images[-1][1])


if __name__ == '__main__':
    main()
