'use strict';
// Genera icon.ico (marca Nova: cuadrado verde redondeado + punto lima) sin dependencias.
// Usa solo módulos nativos (zlib para el PNG). Node 18+. Ejecuta: node make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GREEN = [0x00, 0x80, 0x4c];   // --brand
const LIME  = [0xdb, 0xe6, 0x4c];   // --lime

// ── CRC32 (para los chunks PNG) ──
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// ── Dibuja RGBA de tamaño size ──
function draw(size) {
  const px = Buffer.alloc(size * size * 4, 0);   // transparente
  const set = (x, y, [r, g, b]) => { const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  const pad = Math.max(1, Math.round(size * 0.05));
  const rad = Math.round(size * 0.24);
  const x0 = pad, y0 = pad, x1 = size - pad - 1, y1 = size - pad - 1;
  const d = (x, y, cx, cy) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const inRound = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    if (x < x0 + rad && y < y0 + rad) return d(x, y, x0 + rad, y0 + rad) <= rad;
    if (x > x1 - rad && y < y0 + rad) return d(x, y, x1 - rad, y0 + rad) <= rad;
    if (x < x0 + rad && y > y1 - rad) return d(x, y, x0 + rad, y1 - rad) <= rad;
    if (x > x1 - rad && y > y1 - rad) return d(x, y, x1 - rad, y1 - rad) <= rad;
    return true;
  };
  const cx = (size - 1) / 2, cy = (size - 1) / 2, dotR = size * 0.19;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!inRound(x, y)) continue;
    set(x, y, d(x, y, cx, cy) <= dotR ? LIME : GREEN);
  }
  return px;
}

// ── Codifica RGBA → PNG ──
function toPng(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Empaqueta varios PNG en un ICO ──
function toIco(images) {
  const n = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  let offset = 6 + n * 16;
  const entries = [], datas = [];
  for (const im of images) {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;   // 0 = 256
    e[1] = im.size >= 256 ? 0 : im.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(im.png.length, 8); e.writeUInt32LE(offset, 12);
    offset += im.png.length; entries.push(e); datas.push(im.png);
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map(size => ({ size, png: toPng(size, draw(size)) }));
const ico = toIco(images);
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`icon.ico generado (${ico.length} bytes, tamaños: ${sizes.join('/')})`);
