// Genera los iconos PNG de la extensión (16/32/48/128) sin dependencias:
// cuadrado redondeado con degradado naranja Nova + una "N" blanca.
//   node make-icons.js
const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                                        // filtro 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function draw(S) {
  const buf = Buffer.alloc(S * S * 4);
  const r = S * 0.22;                       // radio de esquina
  const pad = S * 0.26, w = S * 0.13;       // posición y grosor de la "N"
  const x0 = pad, x1 = S - pad, y0 = pad, y1 = S - pad;
  const px = (x, y, R, G, B, A) => { const i = (y * S + x) * 4; buf[i] = R; buf[i+1] = G; buf[i+2] = B; buf[i+3] = A; };
  const inRounded = (x, y) => {
    let cx = x, cy = y;
    if (x < r && y < r) { cx = r; cy = r; } else if (x >= S - r && y < r) { cx = S - r - 1; cy = r; }
    else if (x < r && y >= S - r) { cx = r; cy = S - r - 1; } else if (x >= S - r && y >= S - r) { cx = S - r - 1; cy = S - r - 1; }
    else return true;
    return Math.hypot(x - cx, y - cy) <= r;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inRounded(x, y)) { px(x, y, 0, 0, 0, 0); continue; }
      // degradado vertical #FBB04E -> #E07B12
      const t = y / (S - 1);
      let R = Math.round(0xFB + (0xE0 - 0xFB) * t), G = Math.round(0xB0 + (0x7B - 0xB0) * t), B = Math.round(0x4E + (0x12 - 0x4E) * t);
      // "N" blanca: dos barras verticales + diagonal
      const onLeft  = x >= x0 && x < x0 + w && y >= y0 && y <= y1;
      const onRight = x >= x1 - w && x < x1 && y >= y0 && y <= y1;
      const diagX = x0 + ((y - y0) / (y1 - y0)) * (x1 - w - x0);
      const onDiag = y >= y0 && y <= y1 && x >= diagX && x < diagX + w;
      if (onLeft || onRight || onDiag) { R = G = B = 255; }
      px(x, y, R, G, B, 255);
    }
  }
  return buf;
}

for (const S of [16, 32, 48, 128]) {
  fs.writeFileSync(`${__dirname}/icon${S}.png`, png(S, S, draw(S)));
  console.log(`icon${S}.png`);
}
