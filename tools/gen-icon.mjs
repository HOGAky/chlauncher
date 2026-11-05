/**
 * @file gen-icon.mjs
 * Generates the launcher source icon (tools/icon-src.png) without external
 * image deps — a hand-rolled RGBA PNG encoder (zlib deflate + CRC chunks).
 * Draws a purple→pink diagonal gradient with a centered play triangle.
 * Usage: `node tools/gen-icon.mjs` then `npx tauri icon tools/icon-src.png`.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const W = 1024, H = 1024;

// --- tiny PNG encoder -----------------------------------------------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing --------------------------------------------------------------
const px = Buffer.alloc(W * H * 4);
function put(x, y, r, g, b, a = 255) {
  const i = (y * W + x) * 4;
  // cheap alpha-over blend
  const t = a / 255, u = 1 - t;
  px[i] = r * t + px[i] * u; px[i + 1] = g * t + px[i + 1] * u;
  px[i + 2] = b * t + px[i + 2] * u; px[i + 3] = 255;
}
const cx = W / 2, cy = H / 2;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = (x + y) / (W + H);                       // diagonal gradient
    const r = 90 + 130 * t, g = 40 + 30 * t, b = 200 + 30 * t;
    put(x, y, r, g, b);
    // play triangle: |x-cx'| <= (height/2 - |y-cy|) wedge centered at 46%
    const dx = x - W * 0.42, dy = Math.abs(y - cy);
    if (dx > 0 && dx < W * 0.24 && dy < (W * 0.24 - dx) * 0.62) {
      put(x, y, 255, 255, 255, 235);
    }
  }
}

const out = path.resolve(import.meta.dirname, 'icon-src.png');
fs.writeFileSync(out, encodePng(W, H, px));
console.log('wrote', out);
