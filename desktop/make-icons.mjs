/**
 * make-icons.mjs — draws the app icons with no image library: a white briefcase
 * on the dashboard's blue, and the same at tray size with an amber dot for
 * "new postings". Writes PNGs into assets/. Run once: `node make-icons.mjs`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "assets");
mkdirSync(OUT, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const cover = (distance, scale) => Math.min(1, Math.max(0, 0.5 - distance / scale));
const BLUE = [50, 111, 209];
const WHITE = [255, 255, 255];
const AMBER = [244, 177, 95];

function briefcase(dot) {
  return (px, py, size) => {
    const u = size / 256; // design is on a 256 grid
    const x = px / u;
    const y = py / u;
    const background = cover(roundRect(x, y, 128, 128, 120, 120, 52), 1 / u);
    // body + handle (a ring cut by the body's top edge)
    const body = cover(roundRect(x, y, 128, 146, 82, 58, 14), 1 / u);
    const handleOuter = roundRect(x, y, 128, 84, 36, 26, 12);
    const handleInner = roundRect(x, y, 128, 84, 22, 14, 6);
    const handle = Math.min(cover(handleOuter, 1 / u), 1 - cover(handleInner, 1 / u)) * (y < 92 ? 1 : 0);
    const seam = cover(Math.abs(y - 140) - 5, 1 / u) * cover(Math.abs(x - 128) - 82, 1 / u);
    const white = Math.max(body, handle) * (1 - seam * 0.85);
    let color = BLUE.map((c, i) => c * (1 - white) + WHITE[i] * white);
    let alpha = background;
    if (dot) {
      // An amber dot with a white rim, so it reads on the blue and off it.
      const distance = Math.hypot(x - 196, y - 60);
      const rim = cover(distance - 64, 1 / u);
      const fill = cover(distance - 52, 1 / u);
      color = color.map((c) => c * (1 - rim) + 255 * rim);
      color = color.map((c, i) => c * (1 - fill) + AMBER[i] * fill);
      alpha = Math.max(alpha, rim);
    }
    return [...color.map((c) => Math.round(c)), Math.round(alpha * 255)];
  };
}

writeFileSync(join(OUT, "icon.png"), png(256, briefcase(false)));
writeFileSync(join(OUT, "tray.png"), png(32, briefcase(false)));
writeFileSync(join(OUT, "tray-new.png"), png(32, briefcase(true)));
console.log(`icons written to ${OUT}`);
