// Convierte lo que se leyó de un template de Lemlist (texto de la ficha + nodos y aristas del flujo + contenido de cada paso)
// en el formato de Nova: ficha + árbol de pasos (con esperas, condiciones y ramas). El dato crudo se guarda para poder reprocesarlo.
'use strict';

const clean = s => String(s == null ? '' : s).replace(/\r/g, '').trim();
const lines = s => clean(s).split('\n').map(x => x.trim()).filter(Boolean);

// ── Ficha (panel izquierdo) ──
function parseLeft(left) {
  const L = lines(left).filter(x => x !== 'Volver a templates');
  const out = { tipo: 'multicanal', autor: '', titulo: '', prospectos: 0, apertura: 0, respuesta: 0, para: [], objetivo: [], descripcion: '', copias: 0 };
  if (!L.length) return out;
  out.tipo = /solo\s*emails?/i.test(L[0]) ? 'solo_emails' : 'multicanal';
  const iEst = L.findIndex(x => /^Estad[ií]sticas$/i.test(x));
  const head = L.slice(1, iEst > 0 ? iEst : 3);
  out.autor = head[0] || '';
  out.titulo = head.slice(1).join(' ').trim();
  const num = re => { const m = L.join('\n').match(re); return m ? parseInt(m[1].replace(/\D/g, ''), 10) || 0 : 0; };
  out.prospectos = num(/([\d.,]+)\s+prospectos/i);
  out.apertura = num(/(\d+)\s*%\s*tasa de apertura/i);
  out.respuesta = num(/(\d+)\s*%\s*tasa de respuesta/i);
  const sec = name => {
    const i = L.findIndex(x => x.toLowerCase() === name.toLowerCase());
    if (i < 0) return '';
    const stop = ['Categoría', 'Objetivo', 'Descripción', 'Más información sobre esta template', 'Usar esta template'];
    const buf = [];
    for (let j = i + 1; j < L.length; j++) { if (stop.includes(L[j]) || /^\d+$/.test(L[j]) && j > i + 1 && L[j + 1] === 'Usar esta template') break; buf.push(L[j]); }
    return buf.join(name === 'Descripción' ? '\n' : ' ').trim();
  };
  out.para = sec('Categoría').split(',').map(x => x.trim()).filter(Boolean);
  out.objetivo = sec('Objetivo').split(',').map(x => x.trim()).filter(Boolean);
  out.descripcion = sec('Descripción');
  const iUse = L.findIndex(x => x === 'Usar esta template');
  if (iUse > 0 && /^\d+$/.test(L[iUse - 1])) out.copias = parseInt(L[iUse - 1], 10);
  return out;
}

// ── Idioma (Lemlist no lo muestra en la ficha): se infiere del texto ──
function guessIdioma(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-záéíóúñàâçèêëîïôùûüœ' ]/g, ' ') + ' ';
  const score = words => words.reduce((n, w) => n + (t.split(' ' + w + ' ').length - 1), 0);
  const fr = score(['le', 'la', 'les', 'des', 'vous', 'votre', 'vos', 'une', 'pour', 'avec', 'est', 'nous', 'je', 'et', 'du', 'sur', "d'un", 'que']);
  const es = score(['el', 'los', 'las', 'para', 'con', 'una', 'por', 'que', 'su', 'sus', 'es', 'nuestro', 'hola', 'te', 'tu', 'mi', 'del', 'en']);
  const en = score(['the', 'and', 'you', 'your', 'to', 'of', 'for', 'with', 'is', 'are', 'we', 'our', 'in', 'that', 'this', 'have', 'on']);
  if (fr > es && fr > en * 0.6) return 'fr';
  if (es > en && es > fr) return 'es';
  return 'en';
}

// ── Espera: «Esperar durante\n3 días» → días (las horas y minutos se pasan a fracciones de día) ──
function parseEspera(txt) {
  const t = clean(txt).replace(/\s+/g, ' ');
  if (!t || /inmediatamente/i.test(t)) return 0;
  const m = t.match(/(\d+)\s*(minuto|hora|d[ií]a|semana)/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10), u = m[2].toLowerCase();
  if (u.startsWith('minuto')) return +(n / 1440).toFixed(3);
  if (u.startsWith('hora')) return +(n / 24).toFixed(3);
  if (u.startsWith('sem')) return n * 7;
  return n;
}

// ── Tipo de paso: primero por el icono del nodo, luego por su nombre ──
function parseTipo(name, icon) {
  const ic = String(icon || '').toLowerCase(), nm = String(name || '').toLowerCase();
  if (/linkedin-invite|invitaci/.test(ic + ' ' + nm)) return 'invite';
  if (/linkedin-visit|visitar/.test(ic + ' ' + nm)) return 'visit';
  if (/inmail/.test(ic + ' ' + nm)) return 'inmail';
  if (/linkedin|chat|mensaje/.test(ic + ' ' + nm) && !/email/.test(ic)) return 'message';
  if (/whatsapp/.test(ic + ' ' + nm)) return 'whatsapp';
  if (/phone|call|llamar|llamada/.test(ic + ' ' + nm)) return 'call';
  if (/email|correo/.test(ic + ' ' + nm)) return 'email';
  if (/manual|tarea|task/.test(ic + ' ' + nm)) return 'task';
  return 'task';
}

// ── Condición: «Si Email abierto en el plazo de 4 días» ──
function parseCond(txt) {
  const t = clean(txt).replace(/\s+/g, ' ');
  const dias = (t.match(/plazo de (\d+)\s*d[ií]a/i) || [])[1];
  const low = t.toLowerCase();
  let cond = 'otra';
  if (/invitaci[oó]n aceptada/.test(low)) cond = 'invite_accepted';
  else if (/email.*(abierto)/.test(low)) cond = 'email_opened';
  else if (/direcci[oó]n de email|tienes.*email/.test(low)) cond = 'has_email';
  else if (/email.*(clic|click|enlace)|clic/.test(low)) cond = 'email_clicked';
  else if (/respond|respuesta|replied/.test(low)) cond = /email/.test(low) ? 'email_replied' : 'replied';
  return { cond, dias: dias ? parseInt(dias, 10) : 0, texto: t };
}

// ── Contenido del modal de un paso ──
function parseContenido(txt, tipo) {
  const L = clean(txt).split('\n').map(x => x.replace(/\s+$/, ''));
  const first = (L.find(x => x.trim()) || '').trim();
  const rest = L.slice(L.findIndex(x => x.trim()) + 1);
  const find = re => rest.findIndex(x => re.test(x.trim()));
  const sepVersions = s => clean(s).split(/\n\s*~~\s*\n/).map(x => x.replace(/\n{3,}/g, '\n\n').trim());
  if (tipo === 'email') {
    const iS = find(/^Objeto de email$/i), iC = find(/^Contenido del email$/i);
    const asunto = iS >= 0 ? rest.slice(iS + 1, iC >= 0 ? iC : undefined).join('\n').trim() : '';
    const cuerpo = iC >= 0 ? rest.slice(iC + 1).join('\n') : rest.join('\n');
    const asuntos = asunto.split(/\s*~~\s*/), cuerpos = sepVersions(cuerpo);
    const n = Math.max(asuntos.length, cuerpos.length);
    return { titulo: first, versiones: Array.from({ length: n }, (_, i) => ({ asunto: asuntos[i] != null ? asuntos[i] : (asuntos[0] || ''), cuerpo: cuerpos[i] != null ? cuerpos[i] : '' })) };
  }
  // el resto de canales: cada uno tiene etiquetas propias; el texto que sigue a la etiqueta es el contenido
  const LAB = {
    message: ['Mensaje'], invite: ['Mensaje adjunto a la invitación'], call: ['Guion de llamada'], inmail: ['Asunto', 'Objeto', 'Mensaje'],
    whatsapp: ['Mensaje'], task: ['Título de la tarea', 'Descripción de la tarea'], visit: [],
  };
  const labs = LAB[tipo] || [];
  const campos = {}; let act = null;
  for (const raw of rest) {
    const x = raw.trim();
    if (labs.includes(x)) { act = x; campos[act] = []; continue; }
    if (act) campos[act].push(raw);
  }
  const get = k => (campos[k] || []).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (tipo === 'task') return { titulo: get('Título de la tarea') || first, versiones: [{ asunto: '', cuerpo: get('Descripción de la tarea') }] };
  if (tipo === 'inmail') return { titulo: first, versiones: sepVersions(get('Mensaje')).map((c, i) => ({ asunto: (get('Asunto') || get('Objeto')).split(/\s*~~\s*/)[i] || get('Asunto') || get('Objeto'), cuerpo: c })) };
  const principal = labs.length ? get(labs[0]) : '';
  return { titulo: first, versiones: principal ? sepVersions(principal).map(c => ({ asunto: '', cuerpo: c })) : [] };
}

// ── Árbol de pasos a partir de nodos y aristas ──
function buildTree(nodes, edges, contents) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const next = new Map();   // origen → [{to, rama}]
  for (const e of edges || []) {
    const m = String(e).match(/^(.+?)->(.+?)(?:-(yes|no|branch-\d+|fallback))?$/);
    if (!m) continue;
    if (!next.has(m[1])) next.set(m[1], []);
    const rama = /^branch-/.test(m[3] || '') ? 'yes' : m[3] === 'fallback' ? 'no' : (m[3] || '');
    next.get(m[1]).push({ to: m[2], rama });
  }
  const out = (id, rama) => ((next.get(id) || []).find(x => rama ? x.rama === rama : !x.rama) || {}).to || null;
  const isMerge = id => /__merge$/.test(id || '');
  const isCond = n => n && (/conditional/i.test(n.icon || '') || /^(Si\s|Esperar hasta|Tienes)/i.test(n.name || n.txt || ''));
  const walk = (startId) => {
    const items = [];
    let cur = startId, guard = 0;
    while (cur && cur !== 'end' && !isMerge(cur) && guard++ < 400) {
      const n = byId.get(cur);
      if (!n) break;
      if (isCond(n)) {
        const c = parseCond(n.name || n.txt);
        const si = out(cur, 'yes'), no = out(cur, 'no');
        if (!byId.has(cur + '__merge') && !si && !no) {
          // «Esperar hasta…»: no ramifica, lo que sigue ocurre solo si se cumple la condición
          const nx = out(cur);
          items.push({ k: 'cond', ...c, si: nx ? walk(nx) : [], no: [] });
          break;
        }
        items.push({ k: 'cond', ...c, si: si ? walk(si) : [], no: no ? walk(no) : [] });
        cur = out(cur + '__merge');
        continue;
      }
      if (n.name) {
        const tipo = parseTipo(n.name, n.icon);
        const cont = contents && contents[cur] ? parseContenido(contents[cur], tipo) : { titulo: n.name, versiones: [] };
        items.push({ k: 'step', id: cur, tipo, nombre: (tipo === 'task' && cont.titulo && cont.titulo !== 'Tarea manual') ? cont.titulo : n.name, espera: parseEspera(n.delay), versiones: cont.versiones });
      }
      cur = out(cur);
    }
    return items;
  };
  return walk(out('start'));
}

function parseTemplate(raw) {
  const left = parseLeft(raw.left);
  const pasos = buildTree(raw.nodes || [], raw.edges || [], raw.contents || {});
  // texto de muestra para inferir el idioma: título + primeros contenidos
  let muestra = left.titulo + ' ' + left.descripcion;
  const grab = items => { for (const it of items) { if (it.k === 'step') (it.versiones || []).forEach(v => { muestra += ' ' + (v.asunto || '') + ' ' + (v.cuerpo || '').slice(0, 400); }); else { grab(it.si || []); grab(it.no || []); } } };
  grab(pasos);
  return { ...left, idioma: guessIdioma(muestra), pasos };
}

module.exports = { parseLeft, parseTemplate, buildTree, parseContenido, parseEspera, parseTipo, parseCond, guessIdioma };
