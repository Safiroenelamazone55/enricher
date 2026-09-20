// Logos de clientes: detección automática del tono (claro / oscuro / a color) y "placa" de contraste para correos.
// Regla: el logo siempre va sobre una superficie de color conocido, nunca sobre el color que ponga el cliente de correo.
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', 'portal_media');
const OK_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];
const cache = new Map();
const keyOf = (file, extra) => { const st = fs.statSync(file); return file + ':' + st.mtimeMs + ':' + (extra || ''); };
const sharpOf = file => require('sharp')(file, { density: 300 });

// 'light' = logo claro (para fondos oscuros) · 'dark' = logo oscuro (para fondos claros) · 'color' = a color
async function logoTone(file) {
  const k = keyOf(file, 'tone');
  if (cache.has(k)) return cache.get(k);
  let tone = 'dark';
  try {
    const { data, info } = await sharpOf(file).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let n = 0, lum = 0, sat = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; sat += (Math.max(r, g, b) - Math.min(r, g, b)) / 255; n++;
    }
    if (n) { lum /= n; sat /= n; tone = sat > 0.28 ? 'color' : lum > 0.62 ? 'light' : 'dark'; }
  } catch (e) { /* si no se puede medir, se asume oscuro */ }
  cache.set(k, tone); return tone;
}

// Elige, entre los logos subidos, el que mejor contrasta con la superficie ('light' | 'dark'), sin depender del nombre de la variante
async function pickLogoFor(branding, surface) {
  const cands = [];
  for (const v of Object.keys((branding && branding.logos) || {})) {
    const l = branding.logos[v];
    if (!l || !l.stored || !OK_MIME.includes(l.mime)) continue;
    const file = path.join(MEDIA_DIR, l.stored);
    if (!fs.existsSync(file)) continue;
    cands.push({ variant: v, file, mime: l.mime, tone: await logoTone(file) });
  }
  const pref = surface === 'dark' ? ['light', 'color', 'dark'] : ['dark', 'color', 'light'];
  for (const t of pref) { const c = cands.find(x => x.tone === t); if (c) return c; }
  return cands[0] || null;
}

// Logo recortado (sin márgenes transparentes) sobre una placa opaca: blanca si el logo es oscuro o a color, oscura si es claro.
async function logoPlate(file, tone, darkColor) {
  const dk = /^#[0-9a-f]{6}$/i.test(darkColor || '') ? darkColor : '#0B1220';
  const bg = tone === 'light' ? dk : '#FFFFFF';
  const k = keyOf(file, 'plate:' + tone + ':' + bg);
  if (cache.has(k)) return cache.get(k);
  let buf;
  try {
    const inner = await sharpOf(file).trim({ threshold: 12 }).resize({ height: 96, width: 560, fit: 'inside' }).png().toBuffer();
    buf = await require('sharp')(inner).extend({ top: 16, bottom: 16, left: 22, right: 22, background: bg }).flatten({ background: bg }).png().toBuffer();
  } catch (e) { buf = fs.readFileSync(file); }
  cache.set(k, buf); return buf;
}

// Solo recorte (para la pantalla de acceso, que siempre es blanca): si el logo es claro, va sobre placa oscura
async function logoForWhite(file, tone, darkColor) {
  if (tone === 'light') return logoPlate(file, tone, darkColor);
  const k = keyOf(file, 'trim');
  if (cache.has(k)) return cache.get(k);
  let buf;
  try { buf = await sharpOf(file).trim({ threshold: 12 }).png().toBuffer(); } catch (e) { buf = fs.readFileSync(file); }
  cache.set(k, buf); return buf;
}
module.exports = { logoTone, pickLogoFor, logoPlate, logoForWhite, MEDIA_DIR };
