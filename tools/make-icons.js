// Generates the app icons (blue-to-violet gradient with a white tick) as PNGs, with no
// dependencies. Run with `npm run icons`; the output is committed, so this is only needed
// when the design changes.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (size, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const A = [0x1a, 0x73, 0xe8]; // gradient start (top-left)
const B = [0x7c, 0x4d, 0xff]; // gradient end (bottom-right)
const TICK = [[0.29, 0.52], [0.44, 0.67], [0.71, 0.36]];

// distance from point p to segment a-b
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

// radius: corner rounding as a fraction of the size (0 = full bleed); scale shrinks the tick for maskable safe zones
function render(size, { radius, scale }) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling for smooth edges
  const half = 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, tick = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          // rounded square coverage
          const qx = Math.abs(u - half) - (half - radius);
          const qy = Math.abs(v - half) - (half - radius);
          const inside = radius === 0 || (Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) <= radius * radius;
          if (inside) bg++;
          // tick, scaled about the centre
          const p = [(u - half) / scale + half, (v - half) / scale + half];
          const d = Math.min(segDist(p, TICK[0], TICK[1]), segDist(p, TICK[1], TICK[2]));
          if (inside && d <= 0.055) tick++;
        }
      }
      const n = SS * SS;
      const g = (x + y) / (2 * size);
      const i = (y * size + x) * 4;
      const t = tick / n;
      for (let c = 0; c < 3; c++) {
        const base = A[c] + (B[c] - A[c]) * g;
        out[i + c] = Math.round(base * (1 - t) + 255 * t);
      }
      out[i + 3] = Math.round((bg / n) * 255);
    }
  }
  return png(size, out);
}

const dir = path.join(__dirname, '..', 'public');
const files = {
  'icon-192.png': [192, { radius: 0.22, scale: 1 }],
  'icon-512.png': [512, { radius: 0.22, scale: 1 }],
  'icon-maskable-512.png': [512, { radius: 0, scale: 0.72 }], // full bleed; tick stays inside the 80% safe zone
  'apple-touch-icon.png': [180, { radius: 0, scale: 0.85 }], // iOS rounds the corners itself
  'favicon.png': [64, { radius: 0.22, scale: 1 }],
};
for (const [name, [size, opts]] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), render(size, opts));
  console.log('wrote', name);
}
