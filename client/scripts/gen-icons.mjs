/**
 * Generate the PWA PNG icons from the same shapes as public/icon.svg
 * (gold rounded square + four-point star), dependency-free: pixels are
 * rasterized here (4x supersampled) and packed into PNGs with node:zlib.
 * iOS ignores SVG apple-touch icons and strict install criteria want real
 * 192/512 PNGs with separate `any` and `maskable` purposes.
 *
 *   node scripts/gen-icons.mjs   (writes into public/)
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const GOLD = [0xff, 0xc8, 0x3d];
const INK = [0x2b, 0x24, 0x40];

// The star from icon.svg, in its 512-space: M256 72 L296 216 L440 256 L296 296
// L256 440 L216 296 L72 256 L216 216 Z
const STAR = [
  [256, 72],
  [296, 216],
  [440, 256],
  [296, 296],
  [256, 440],
  [216, 296],
  [72, 256],
  [216, 216],
];

function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(px, py, size, r) {
  if (px < 0 || py < 0 || px > size || py > size) return false;
  const cx = px < r ? r : px > size - r ? size - r : px;
  const cy = py < r ? r : py > size - r ? size - r : py;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** Render one icon as RGBA pixels. `rounded` bakes the SVG's corner radius
 *  (purpose "any"); flat icons fill the square edge-to-edge (maskable/apple),
 *  with the star shrunk by `safeScale` into the maskable safe zone. */
function render(size, { rounded, safeScale = 1 }) {
  const SS = 4; // supersamples per axis
  const px = new Uint8Array(size * size * 4);
  const radius = rounded ? (104 / 512) * size : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let star = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const inBg = rounded ? inRoundedSquare(fx, fy, size, radius) : true;
          if (!inBg) continue;
          bg++;
          // map to the 512 star space, shrunk toward center by safeScale
          const ux = ((fx / size) * 512 - 256) / safeScale + 256;
          const uy = ((fy / size) * 512 - 256) / safeScale + 256;
          if (inPolygon(ux, uy, STAR)) star++;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // composite: star over gold over transparent
      const starF = star / n;
      const goldF = bg / n - starF;
      px[i] = INK[0] * starF + GOLD[0] * goldF;
      px[i + 1] = INK[1] * starF + GOLD[1] * goldF;
      px[i + 2] = INK[2] * starF + GOLD[2] * goldF;
      px[i + 3] = 255 * (bg / n);
    }
  }
  return px;
}

// --- minimal PNG writer (8-bit RGBA, filter 0) ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
writeFileSync(out('icon-192.png'), png(192, render(192, { rounded: true })));
writeFileSync(out('icon-512.png'), png(512, render(512, { rounded: true })));
writeFileSync(
  out('icon-512-maskable.png'),
  png(512, render(512, { rounded: false, safeScale: 0.78 })),
);
writeFileSync(out('apple-touch-icon.png'), png(180, render(180, { rounded: false })));
// eslint-disable-next-line no-console -- CLI feedback
console.log('icons written to public/');
