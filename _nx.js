const fs=require('fs');let s=fs.readFileSync('frontend/app.js','utf8');const crlf=s.includes('\r\n');if(crlf)s=s.replace(/\r\n/g,'\n');
const a=s.indexOf("  function nextManualValidation(companyId) {");const b=s.indexOf("  async function quitarValidacionManual(companyId) {");
if(a<0||b<0||b<a) throw new Error('anclas');
s=s.slice(0,a)+`  // Siguiente: la próxima empresa SIN validar de la lista. Salta las que ya tienen Tier (las tuyas, las de la otra cuenta o las de la IA), así nunca
  // se reabre —ni se pisa— lo que ya está hecho. Si después de la actual no queda ninguna, busca desde el principio de la lista.
  function nextManualValidation(companyId) {
    const list = _filteredCompaniesList(), idx = list.findIndex(c => c.id === companyId);
    const desde = idx === -1 ? 0 : idx + 1;
    const nx = list.slice(desde).find(c => !_validadaCo(c)) || list.find(c => !_validadaCo(c) && c.id !== companyId);
    if (!nx) { showBanner('No quedan empresas por validar en este filtro', 'info'); return; }
    openManualValidation(nx.id);
  }
`+s.slice(b);
const n="      <div class=\"flt-body\" style=\"display:flex;flex-direction:column;gap:10px\">\n        <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px\">\n          <label class=\"cant-flabel\">Datos de la empresa";
if(s.split(n).length!==2) throw new Error('flt-body');
s=s.replace(n,()=>"      <div class=\"flt-body\" style=\"display:flex;flex-direction:column;gap:10px\">\n        ${_validadaCo(co) ? '<div class=\"cant-manual-done\">Esta empresa ya está validada. Si cambias algo, se reemplaza lo anterior.</div>' : ''}\n        <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px\">\n          <label class=\"cant-flabel\">Datos de la empresa");
fs.writeFileSync('frontend/app.js',crlf?s.replace(/\n/g,'\r\n'):s);
