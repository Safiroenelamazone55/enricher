'use strict';
// Normalización de CARGOS para agruparlos por rol (pedido explícito 2026-10-26): «Director de Operaciones de Novacentrax», «Operations Director»
// y «direttore operations» son el mismo rol. Solo importa el rol: se quita el nombre de la empresa, los paréntesis, la geografía, las colas
// descriptivas y se unifica el idioma (ES/EN/IT/PT/CS) a una forma canónica en español.
//
// Dos pasos, deliberadamente separados:
//  1) limpiarCargo(): limpieza SEGURA del texto (empresa, paréntesis, separadores, geografía). Es lo que se guardaría como dato.
//  2) rolCanonico(): AGRUPACIÓN por nivel + área («Director de Operaciones», «Responsable de Logística»). Es solo para agrupar/priorizar;
//     NUNCA cambia el cargo real del contacto (el mensaje sigue diciendo lo que dice su perfil).
// Lo que no se reconoce queda tal cual (limpio): mejor un grupo de más que mezclar roles distintos.

const _n = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const _has = (txt, re) => re.test(' ' + txt + ' ');

// Formas legales que no identifican a la empresa (para reconocer su nombre dentro del cargo).
const _LEGAL = new Set(['sa', 'sl', 'slu', 'sau', 'sas', 'sac', 'spa', 'srl', 'srls', 'snc', 'ltd', 'llc', 'inc', 'gmbh', 'bv', 'nv', 'ag', 'co', 'corp', 'lda', 'ltda', 'sociedad', 'societa', 'benefit', 'grupo', 'group', 'gruppo']);
const _GEO = ['iberia', 'espana', 'spain', 'portugal', 'italia', 'italy', 'europa', 'europe', 'peru', 'chile', 'mexico', 'madrid', 'barcelona', 'alicante', 'valencia', 'catalunya', 'cataluna'];

function limpiarCargo(raw, empresa, opts) {
  const seguro = !!(opts && opts.seguro);   // seguro: solo quita lo que NO es el cargo (empresa, paréntesis, «| X», «@ X», «at X», geografía); no corta por comas ni barras
  let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();       // (ES / PT), (Spain)…
  s = s.split(seguro ? /\s+[|@]\s+|\s+at\s+/i : /\s+[|@·•]\s+|\s+at\s+|\s+\/\s+|\s+[–—]\s+/i)[0];   // «Operations Manager | Empresa», «CEO at X», «CEO y fundadora / EMPRESA» → lo primero
  if (!seguro) s = s.split(/\s*,\s*/)[0];                              // «Responsable Logistica, encargado de camaras…» → lo primero (solo para agrupar)
  // «Marketing Strategy Lead — U.S. Insurance Brand»: tras un guion largo, si lo que sigue es geografía o el nombre de la empresa, no es parte del cargo.
  const empT = _n(empresa).split(' ').filter(t => t.length >= 3 && !_LEGAL.has(t));
  const dash = s.split(/\s+[–—-]\s+/);
  if (dash.length > 1 && dash[0].trim().split(' ').length >= 2) {
    const rest = _n(dash.slice(1).join(' '));
    if (/\b(u s a?|usa|us|uk|emea|latam|apac|north america|south america|europe|europa|asia|global|international|worldwide)\b/.test(rest) || (empT.length && empT.some(t => t.length >= 4 && rest.split(' ').includes(t)))) s = dash[0].trim();
  }
  s = s.replace(/\s+for\s+m\/s\b.*$/i, '').replace(/^(?:a|an|the)\s+(?=\S+\s+\S+)/i, '').trim();   // «A Global Network Partner for M/s. X» → «Global Network Partner»
  // Nombre de la empresa dentro del cargo («CEO Bidfood Spain», «Director de Operaciones de Novacentrax»): solo se quita si aparece COMPLETO y seguido
  // (todas las palabras del nombre, en orden). Antes se quitaba palabra por palabra y destrozaba cargos que comparten una palabra con la empresa.
  const emp = empT;
  if (emp.length) {
    const toks = s.split(' '), nt = toks.map(t => _n(t));
    let at = -1;
    for (let i = 0; i + emp.length <= nt.length && at < 0; i++) if (emp.every((e, k) => nt[i + k] === e)) at = i;
    if (at >= 0 && (emp.length > 1 || emp[0].length >= 4)) {
      const keep = toks.slice(0, at).concat(toks.slice(at + emp.length));
      while (keep.length && /^(de|del|di|da|en|at|of|in|para|for|-)$/i.test(keep[keep.length - 1])) keep.pop();
      if (keep.length) s = keep.join(' ');
    }
  }
  // Geografía y sector al final: «… Delegación Alicante», «… Portugal», «… Sector Alimentación».
  s = s.replace(/\s+(delegaci[oó]n|delegacion|sector|filial|sucursal)\s+.*$/i, '');
  for (const g of _GEO) s = s.replace(new RegExp('\\s+' + g + '$', 'i'), '');
  s = s.replace(/^[\s\-–—|,;:/]+|[\s\-–—|,;:/]+$/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

// Nivel (de mayor a menor) y área, reconocidos en varios idiomas.
const NIVELES = [
  ['CEO', /\b(ceo|chief executive officer|consejer[oa] delegad[oa]|amministratore delegato|amministratore unico|amm unico|administrador[a]? unic[oa]|administrador[a]? delegad[oa]|managing director|director[a]? general|direttore generale|general manager|gerente general)\b/],
  ['COO', /\b(coo|chief operating officer)\b/],
  ['CFO', /\b(cfo|chief financial officer|director[a]? financier[oa]|direttore finanziario)\b/],
  ['CIO', /\b(cio|chief information officer)\b/],
  ['CTO', /\b(cto|chief technology officer)\b/],
  ['CMO', /\b(cmo|chief marketing officer)\b/],
  ['Presidente', /\b(president[ea]?|presidenta|chairman|chairwoman)\b/],
  ['Propietario', /\b(propietari[oa]|owner|titular|titolare|fundador[a]?|founder|co ?founder|cofundador[a]?|socio|socia|partner|dueno|duena|autonomo[a]?)\b/],
  ['Director', /\b(director[a]?|direttore|direttrice|direzione|head of|diretor[a]?)\b/],
  ['Coordinador', /\b(coordinador[a]?|coordinatore|coordinatrice|coordenador[a]?|coordinator)\b/],
  ['Responsable', /\b(jefe|jefa|responsable|responsabile|resp|gerente|manager|managers|manazer|encargad[oa]|supervisor[a]?|capo|chef de)\b/],
  ['Especialista', /\b(especialista|specialist|gestor[a]?|tecnic[oa]|administrativ[oa]|administratiu|analista|analyst|asistente|assistant|auxiliar|operari[oa])\b/],
];
const AREAS = [
  ['Logística', /\b(logisti[a-z]*|logistics?|supply chain|cadena de suministro|trasporti|transporte|transporti|transport|almacen|almacenes|magazzino|warehouse|distribuzione|distribucion|distributiv[a-z]*)\b/],
  ['Operaciones', /\b(operaciones|operacion|operations|operation|operazioni|operazione|operaci|operacoes)\b/],
  ['Flota', /\b(flota|fleet|flotta)\b/],
  ['Compras', /\b(compras|purchasing|procurement|acquisti|approvvigionamenti|buyer)\b/],
  ['Producción', /\b(produccion|production|produzione|fabrica|planta|plant|manufacturing)\b/],
  ['Calidad', /\b(calidad|quality|qualita)\b/],
  ['Comercial', /\b(comercial|commercial|commerciale|ventas|sales|vendite|business development|desarrollo de negocio|desarrollo comercial|comercio)\b/],
  ['Marketing', /\b(marketing|mercadeo|comunicacion|communication|comunicazione)\b/],
  ['Finanzas', /\b(finanzas|financiero|financiera|finance|financial|finanze|finanziario|contabilidad|accounting|administracion y finanzas)\b/],
  ['Recursos Humanos', /\b(rrhh|hr|recursos humanos|human resources|risorse umane|people|talento|talent)\b/],
  ['Tecnología', /\b(tecnologia|technology|sistemas|it|informatica|informatico|tic|digital|ti)\b/],
  ['Mantenimiento', /\b(mantenimiento|maintenance|manutenzione)\b/],
  ['Seguridad', /\b(seguridad|safety|security|sicurezza|prevencion|hse|prl)\b/],
  ['Atención al cliente', /\b(atencion al cliente|customer service|customer success|servicio al cliente|clientes|servizio clienti)\b/],
];
// Áreas que se leen como adjetivo: «Director Comercial» (no «Director de Comercial»).
const _ADJ = new Set(['Comercial']);
// Niveles que por sí solos ya son el rol (no necesitan un área).
const _SOLO = new Set(['CEO', 'COO', 'CFO', 'CIO', 'CTO', 'CMO', 'Presidente', 'Propietario']);

// {rol, nivel, area}. rol = forma canónica para agrupar; si no se reconoce nada, el cargo limpio.
function rolCanonico(raw, empresa) {
  const limpio = limpiarCargo(raw, empresa);
  const t = _n(limpio);
  if (!t) return { rol: '', nivel: '', area: '', limpio };
  const nivel = (NIVELES.find(([, re]) => _has(t, re)) || [''])[0];
  // Área: la que aparece PRIMERO en el texto («Jefe de logística y operaciones…» → Logística).
  let area = '', pos = Infinity;
  for (const [nm, re] of AREAS) { const m = re.exec(' ' + t + ' '); if (m && m.index < pos) { pos = m.index; area = nm; } }
  let rol;
  if (_SOLO.has(nivel)) rol = nivel;
  else if (nivel && area) rol = _ADJ.has(area) ? `${nivel} ${area}` : `${nivel} de ${area}`;
  else if (area) rol = area;                                           // «Logística», «Operaciones»: el área sola
  else rol = limpio.replace(/\s+/g, ' ');                               // sin reconocer: se deja el cargo limpio
  return { rol, nivel, area, limpio };
}

module.exports = { limpiarCargo, rolCanonico };
