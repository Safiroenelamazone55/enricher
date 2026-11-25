'use strict';
// Feriados recurrentes por país, para pausar el envío automático sin confundir un país con otro
// (ej. no pausar para EE. UU. un feriado que solo es feriado en Perú). Cada feriado se repite cada
// año, en fecha fija (mes/día) o por regla (ej. "4º jueves de noviembre" para Thanksgiving).
function _nthWeekday(year, month1, dow, n) {
  const d = new Date(Date.UTC(year, month1 - 1, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === dow) { count++; if (count === n) return d; }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
function _lastWeekday(year, month1, dow) {
  const d = new Date(Date.UTC(year, month1, 0)); // último día del mes
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// dow: 0=domingo … 6=sábado. Los de fecha fija no dependen de Semana Santa (esos se dejan fuera
// por ahora para no calcularlos mal — mejor pocos feriados pero exactos que muchos aproximados).
const CALENDARS = {
  PE: { nombre: 'Perú', feriados: [
    { k: 'ano_nuevo', l: 'Año Nuevo', mes: 1, dia: 1 },
    { k: 'dia_trabajo', l: 'Día del Trabajo', mes: 5, dia: 1 },
    { k: 'san_pedro_pablo', l: 'San Pedro y San Pablo', mes: 6, dia: 29 },
    { k: 'fiestas_patrias_1', l: 'Fiestas Patrias (28 jul)', mes: 7, dia: 28 },
    { k: 'fiestas_patrias_2', l: 'Fiestas Patrias (29 jul)', mes: 7, dia: 29 },
    { k: 'santa_rosa', l: 'Santa Rosa de Lima', mes: 8, dia: 30 },
    { k: 'combate_angamos', l: 'Combate de Angamos', mes: 10, dia: 8 },
    { k: 'todos_santos', l: 'Todos los Santos', mes: 11, dia: 1 },
    { k: 'inmaculada', l: 'Inmaculada Concepción', mes: 12, dia: 8 },
    { k: 'navidad', l: 'Navidad', mes: 12, dia: 25 },
  ] },
  US: { nombre: 'Estados Unidos', feriados: [
    { k: 'new_year', l: "New Year's Day", mes: 1, dia: 1 },
    { k: 'mlk', l: 'Martin Luther King Jr. Day', mes: 1, dow: 1, n: 3 },
    { k: 'presidents', l: "Presidents' Day", mes: 2, dow: 1, n: 3 },
    { k: 'memorial', l: 'Memorial Day', mes: 5, dow: 1, last: true },
    { k: 'juneteenth', l: 'Juneteenth', mes: 6, dia: 19 },
    { k: 'independence', l: 'Independence Day', mes: 7, dia: 4 },
    { k: 'labor', l: 'Labor Day', mes: 9, dow: 1, n: 1 },
    { k: 'columbus', l: 'Columbus Day', mes: 10, dow: 1, n: 2 },
    { k: 'veterans', l: 'Veterans Day', mes: 11, dia: 11 },
    { k: 'thanksgiving', l: 'Thanksgiving', mes: 11, dow: 4, n: 4 },
    { k: 'christmas', l: 'Christmas Day', mes: 12, dia: 25 },
  ] },
  MX: { nombre: 'México', feriados: [
    { k: 'ano_nuevo', l: 'Año Nuevo', mes: 1, dia: 1 },
    { k: 'constitucion', l: 'Día de la Constitución', mes: 2, dow: 1, n: 1 },
    { k: 'benito_juarez', l: 'Natalicio de Benito Juárez', mes: 3, dow: 1, n: 3 },
    { k: 'dia_trabajo', l: 'Día del Trabajo', mes: 5, dia: 1 },
    { k: 'independencia', l: 'Día de la Independencia', mes: 9, dia: 16 },
    { k: 'revolucion', l: 'Día de la Revolución', mes: 11, dow: 1, n: 3 },
    { k: 'navidad', l: 'Navidad', mes: 12, dia: 25 },
  ] },
};

function listCalendars() { return Object.entries(CALENDARS).map(([k, v]) => ({ k, nombre: v.nombre, feriados: v.feriados.map(h => ({ k: h.k, l: h.l })) })); }

// Devuelve el nombre del feriado si `date` (UTC) cae en uno de los `keys` elegidos de `pais`; null si no.
function holidayOn(pais, keys, date) {
  const cal = CALENDARS[pais];
  if (!cal || !Array.isArray(keys) || !keys.length) return null;
  const y = date.getUTCFullYear();
  for (const h of cal.feriados) {
    if (!keys.includes(h.k)) continue;
    let hd;
    if (h.mes && h.dia) hd = new Date(Date.UTC(y, h.mes - 1, h.dia));
    else if (h.last) hd = _lastWeekday(y, h.mes, h.dow);
    else if (h.n) hd = _nthWeekday(y, h.mes, h.dow, h.n);
    else continue;
    if (hd.getUTCFullYear() === date.getUTCFullYear() && hd.getUTCMonth() === date.getUTCMonth() && hd.getUTCDate() === date.getUTCDate()) return h.l;
  }
  return null;
}

module.exports = { CALENDARS, listCalendars, holidayOn };
