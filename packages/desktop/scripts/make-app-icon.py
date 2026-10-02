# Renders the app icon (1024px): a blue rounded square with the white branch glyph.
# Usage: python3 make-app-icon.py <out.png>
import math, struct, sys, zlib

SIZE = 1024
def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def rounded_rect(px, py, x0, y0, x1, y1, r):
    qx = max(x0 + r - px, 0, px - (x1 - r)); qy = max(y0 + r - py, 0, py - (y1 - r))
    return math.hypot(qx, qy) - r

# Glyph in a 16-unit box, scaled into the middle of the icon.
nodes = [(4.5, 3.5), (4.5, 12.5), (11.5, 5.5)]
segs = [((4.5, 3.5), (4.5, 12.5)), ((11.5, 5.5), (11.5, 7.5)), ((11.5, 7.5), (4.5, 11))]
g, off = 40.0, 512 - 8 * 40.0
top, bottom = (0x5b, 0x8c, 0xff), (0x2f, 0x5b, 0xe0)
rows = []
for y in range(SIZE):
    row = bytearray([0])
    t = y / SIZE
    bg = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    for x in range(SIZE):
        px, py = x + 0.5, y + 0.5
        a_bg = max(0.0, min(1.0, 0.5 - rounded_rect(px, py, 100, 100, 924, 924, 185)))
        ux, uy = (px - off) / g, (py - off) / g
        d = min([math.hypot(ux - nx, uy - ny) - 2.1 for nx, ny in nodes] + [seg_dist(ux, uy, *a, *b) - 0.75 for a, b in segs])
        a_fg = max(0.0, min(1.0, 0.5 - d * g)) * a_bg
        c = tuple(int(bg[i] * (1 - a_fg) + 255 * a_fg) for i in range(3))
        row += bytes([*c, int(a_bg * 255)])
    rows.append(bytes(row))

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
