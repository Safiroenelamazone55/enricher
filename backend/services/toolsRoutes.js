'use strict';
// Herramientas descargables (extensiones y apps de escritorio) — se sirven solo con sesión iniciada.
// Los archivos viven en backend/tools_files/ (fuera de git: el repo es público); se suben al servidor con el script de despliegue de herramientas.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'tools_files');
// id → archivo guardado, nombre con el que se descarga y versión (se muestra en la pantalla).
const TOOLS = {
  'linkedin-scraper':      { file: 'linkedin-sales-scraper-1.0.8.zip',   nombre: 'LinkedIn-Sales-Scraper-1.0.8.zip',   version: '1.0.8' },
  'nova-activity-web':     { file: 'elevn-activity-extension-0.1.3.zip', nombre: 'Elevn-Activity-Extension-0.1.3.zip', version: '0.1.3' },
  'nova-activity-desktop': { file: 'ElevnActivitySetup-1.0.2.exe',       nombre: 'ElevnActivitySetup-1.0.2.exe',       version: '1.0.2' },
};

function info(id) {
  const t = TOOLS[id]; if (!t) return null;
  const p = path.join(DIR, t.file);
  let size = 0, ok = false;
  try { const st = fs.statSync(p); size = st.size; ok = st.isFile(); } catch (_) {}
  return { id, version: t.version, archivo: t.nombre, size, disponible: ok, path: p };
}

function mount(app, { requireAuth }) {
  app.get('/api/tools', requireAuth, (req, res) => {
    res.json(Object.keys(TOOLS).map(id => { const { path: _p, ...x } = info(id); return x; }));
  });
  app.get('/api/tools/:id/download', requireAuth, (req, res) => {
    const t = info(req.params.id);
    if (!t) return res.status(404).json({ error: 'Herramienta no encontrada' });
    if (!t.disponible) return res.status(404).json({ error: 'Este archivo todavía no está disponible en el servidor' });
    res.setHeader('Cache-Control', 'no-store');
    res.download(t.path, t.archivo, err => { if (err && !res.headersSent) res.status(500).json({ error: 'No se pudo descargar' }); });
  });
}

module.exports = { mount, TOOLS };
