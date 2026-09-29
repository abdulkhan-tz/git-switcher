# Renders the tray glyph (a branch: two stacked nodes joined, one side node) as macOS template PNGs.
import math, struct, zlib

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def render(size):
    s = size / 16
    nodes = [(4.5, 3.5), (4.5, 12.5), (11.5, 5.5)]
    r = 2.1
    segs = [((4.5, 3.5), (4.5, 12.5)), ((11.5, 5.5), (11.5, 7.5)), ((11.5, 7.5), (4.5, 11))]
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = (x + 0.5) / s, (y + 0.5) / s
            d = min([math.hypot(px - nx, py - ny) - r for nx, ny in nodes] + [seg_dist(px, py, *a, *b) - 0.75 for a, b in segs])
            alpha = max(0.0, min(1.0, 0.5 - d * s))
            row += bytes([0, 0, 0, int(alpha * 255)])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

open('assets/trayTemplate.png', 'wb').write(render(16))
open('assets/trayTemplate@2x.png', 'wb').write(render(32))
