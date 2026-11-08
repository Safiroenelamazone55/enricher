'use strict';
// «Formulario de inicio» del cliente: definición única de secciones y campos (ES/EN). La usan el formulario público,
// la ficha interna, la validación del servidor y el CSV. Los campos `sensible` se cifran en reposo.
const T = (es, en) => ({ es, en });
const o = (v, es, en) => ({ v, es, en: en == null ? es : en });

const SECCIONES = [
  { id: 's1', titulo: T('Empresa y facturación', 'Company and billing'),
    intro: T('Estos datos se usan para emitir tu factura y enviarte los informes.', 'These details are used to issue your invoice and send you reports.'),
    campos: [
      { id: 'razon', tipo: 'text', req: true, es: 'Razón social', en: 'Legal company name' },
      { id: 'nif', tipo: 'text', req: true, es: 'NIF / CIF / VAT', en: 'Tax ID / VAT number' },
      { id: 'dir', tipo: 'long', req: true, es: 'Dirección fiscal', en: 'Billing address' },
      { id: 'pais', tipo: 'text', req: true, es: 'País y zona horaria', en: 'Country and time zone', ej: T('Ejemplo: España, Madrid (GMT+1)', 'Example: Spain, Madrid (GMT+1)') },
      { id: 'contacto', tipo: 'text', req: true, es: 'Persona de contacto (nombre y cargo)', en: 'Contact person (name and role)' },
      { id: 'web', tipo: 'url', req: false, es: 'Web de la empresa', en: 'Company website', ph: 'https://' },
      { id: 'logo', tipo: 'url', req: false, es: 'Enlace al logo', en: 'Link to your logo', ph: 'https://',
        ayuda: T('Un enlace de descarga (Drive, Dropbox, tu web). Si prefieres, envíalo adjunto por el mismo canal donde mandes este formulario.', 'A download link (Drive, Dropbox, your website). If you prefer, send it as an attachment through the same channel you use for this form.') },
    ] },
  { id: 's2', titulo: T('Cómo nos comunicamos', 'How we communicate'),
    campos: [
      { id: 'mailInf', tipo: 'email', req: true, es: 'Correo para informes y facturación', en: 'Email for reports and billing', ayuda: T('Aquí enviaremos los informes y la factura.', 'We will send reports and the invoice here.') },
      { id: 'canal', tipo: 'select', req: true, es: 'Canal de comunicación preferido', en: 'Preferred communication channel',
        opts: [o('linkedin', 'LinkedIn', 'LinkedIn'), o('linkedin_whatsapp', 'LinkedIn · WhatsApp', 'LinkedIn · WhatsApp'), o('whatsapp', 'WhatsApp', 'WhatsApp'), o('email', 'Correo', 'Email')] },
      { id: 'wpp', tipo: 'text', req: false, es: 'Número de WhatsApp (si lo elegiste)', en: 'WhatsApp number (if you chose it)', ph: '+34 ...' },
      { id: 'idioma', tipo: 'select', req: false, es: 'Idioma en el que prefieres que nos comuniquemos', en: 'Preferred language',
        opts: [o('es', 'Español', 'Español'), o('en', 'English', 'English')] },
    ] },
  { id: 's3', titulo: T('Accesos', 'Access'),
    intro: T('Usaremos estos accesos solo para ejecutar tu piloto. Para tu seguridad, te recomendamos usar un acceso dedicado o cambiar las contraseñas al terminar. Si tienes verificación en dos pasos, dinos cómo te pedimos el código.',
      'We will use these credentials only to run your pilot. For your security, we recommend using a dedicated login or changing the passwords afterwards. If you have two-step verification, tell us how to ask you for the code.'),
    campos: [
      { id: 'liUrl', tipo: 'url', req: true, es: 'Perfil de LinkedIn', en: 'LinkedIn profile', ph: 'https://www.linkedin.com/in/...' },
      { id: 'liUser', tipo: 'text', req: true, es: 'Usuario o correo de acceso a LinkedIn', en: 'LinkedIn login (email or username)' },
      { id: 'liPass', tipo: 'secret', req: true, sensible: true, es: 'Contraseña de LinkedIn', en: 'LinkedIn password' },
      { id: 'li2fa', tipo: 'text', req: false, es: 'Verificación en dos pasos de LinkedIn', en: 'LinkedIn two-step verification', ayuda: T('¿La tienes activa? ¿Cómo te pedimos el código?', 'Is it on? How should we ask you for the code?') },
      { id: 'salesnav', tipo: 'select', req: true, es: '¿Tienes LinkedIn Sales Navigator?', en: 'Do you have LinkedIn Sales Navigator?',
        opts: [o('tengo', 'Sí, ya tengo', 'Yes, I already have it'),
          o('anadir', 'No, quiero añadirlo (opcional: US$50/mes con 60 % de descuento, se suma a la factura)', 'No, I want to add it (optional: US$50/month at 60% off, added to the invoice)'),
          o('no', 'No, no lo quiero', 'No, I do not want it')] },
      { id: 'mailEstado', tipo: 'select', req: true, es: 'Correo de envío que nos asignas', en: 'Sending mailbox you assign to us', ayuda: T('El buzón desde el que escribiremos a tus prospectos.', 'The mailbox we will write to your prospects from.'),
        opts: [o('creado', 'Ya está creado (lo escribo abajo)', 'Already created (I enter it below)'), o('despues', 'Lo creo y lo envío después', 'I will create it and send it later')] },
      { id: 'mailUser', tipo: 'email', req: false, es: 'Dirección del correo asignado', en: 'Assigned mailbox address' },
      { id: 'mailPass', tipo: 'secret', req: false, sensible: true, es: 'Contraseña del correo asignado', en: 'Assigned mailbox password' },
      { id: 'mailProv', tipo: 'select', req: false, es: 'Proveedor del correo', en: 'Mailbox provider',
        opts: [o('google', 'Google Workspace', 'Google Workspace'), o('microsoft', 'Microsoft 365', 'Microsoft 365'), o('otro', 'Otro', 'Other')] },
      { id: 'mailNotas', tipo: 'long', req: false, es: 'Notas del correo', en: 'Mailbox notes', ayuda: T('Verificación en dos pasos, servidor, límites de envío u otro dato útil.', 'Two-step verification, server, sending limits or anything useful.') },
      { id: 'calendario', tipo: 'url', req: true, es: 'Enlace para agendar reuniones contigo', en: 'Link to book meetings with you', ph: 'https://', ayuda: T('Calendly, Google Calendar u otro.', 'Calendly, Google Calendar or similar.') },
    ] },
  { id: 's4', titulo: T('Quién atiende las reuniones', 'Who takes the meetings'),
    campos: [
      { id: 'atiende', tipo: 'text', req: true, es: 'Nombre de quien atenderá las reuniones', en: 'Name of the person who will take the meetings' },
      { id: 'atiendeEmail', tipo: 'email', req: true, es: 'Correo de esa persona', en: 'That person email' },
      { id: 'disp', tipo: 'long', req: true, es: 'Días y horas en que se pueden atender reuniones', en: 'Days and hours when meetings can be taken', ej: T('Ejemplo: Martes a jueves, 10:00–13:00', 'Example: Tuesday to Thursday, 10:00–13:00') },
      { id: 'excluir', tipo: 'long', req: false, es: 'Empresas que NO debemos contactar', en: 'Companies we must NOT contact', ayuda: T('Clientes actuales, competidores o cualquier empresa que prefieras dejar fuera.', 'Current clients, competitors or any company you prefer to leave out.') },
    ] },
  { id: 's5', titulo: T('Acuerdos', 'Agreements'),
    intro: T('Marca cada punto para confirmar que lo entiendes.', 'Tick each point to confirm you understand it.'),
    campos: [
      { id: 'a1', tipo: 'check', req: true, es: 'Apruebo el enfoque inicial (mensajes y empresas objetivo) en un máximo de 48 horas desde que me lo envíen.', en: 'I will approve the initial approach (messages and target companies) within 48 hours of receiving it.' },
      { id: 'a2', tipo: 'check', req: true, es: 'Confirmo el objetivo del piloto: 3 reuniones cualificadas con decisores en 30 días.', en: 'I confirm the pilot goal: 3 qualified meetings with decision makers in 30 days.' },
      { id: 'a3', tipo: 'check', req: true, es: 'Entiendo qué es una reunión cualificada: aceptada y con fecha, con un cargo de decisión de una empresa de mi cliente ideal que ha dicho por escrito que quiere hablar. Si no se presenta y no se reagenda en 7 días, no cuenta.', en: 'I understand what a qualified meeting is: accepted and dated, with a decision maker at a company in my ideal client profile who has said in writing they want to talk. If they do not show up and it is not rescheduled within 7 days, it does not count.' },
      { id: 'a4', tipo: 'check', req: true, es: 'Entiendo que no se garantizan respuestas, reuniones ni ventas, y que yo llevo las reuniones, las propuestas y el cierre.', en: 'I understand that replies, meetings and sales are not guaranteed, and that I handle the meetings, proposals and closing.' },
      { id: 'a5', tipo: 'check', req: true, es: 'Me comprometo a responder a cada reunión en menos de 48 horas.', en: 'I commit to responding to each meeting within 48 hours.' },
      { id: 'a6', tipo: 'check', req: true, es: 'Autorizo a NovaCentrax a contactar en mi nombre, por LinkedIn y correo, a los cargos acordados en la propuesta.', en: 'I authorise NovaCentrax to contact, on my behalf, via LinkedIn and email, the roles agreed in the proposal.' },
      { id: 'a7', tipo: 'check', req: true, es: 'Autorizo a NovaCentrax a usar los accesos que indico arriba solo para ejecutar este piloto.', en: 'I authorise NovaCentrax to use the credentials I provide above only to run this pilot.' },
      { id: 'comentarios', tipo: 'long', req: false, es: '¿Algo más que debamos saber?', en: 'Anything else we should know?' },
    ] },
];

const CAMPOS = SECCIONES.flatMap(s => s.campos.map(c => ({ ...c, seccion: s.id })));
const POR_ID = Object.fromEntries(CAMPOS.map(c => [c.id, c]));
const ACUERDOS = CAMPOS.filter(c => c.tipo === 'check').map(c => c.id);          // a1–a7
const SENSIBLES = CAMPOS.filter(c => c.sensible).map(c => c.id);                 // liPass, mailPass
const OBLIGATORIOS = CAMPOS.filter(c => c.req).map(c => c.id);

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const MAX = { text: 300, long: 2000, url: 500, email: 200, select: 60, secret: 300 };

// Limpia un valor según su tipo (nunca lanza): texto recortado, selects solo con opciones válidas
function limpiar(c, v) {
  if (c.tipo === 'check') return v === true || v === 'true' || v === 1;
  let s = String(v == null ? '' : v).replace(/\r\n/g, '\n');
  if (c.tipo !== 'long') s = s.replace(/\n+/g, ' ');
  s = c.tipo === 'secret' ? s.slice(0, MAX.secret) : s.trim().slice(0, MAX[c.tipo] || 300);
  if (c.tipo === 'select') return c.opts.some(x => x.v === s) ? s : '';
  return s;
}
// Errores de formato de UN valor ya limpio ('' si es válido o está vacío)
function errorFormato(c, v) {
  if (c.tipo === 'email' && v && !EMAIL_RE.test(v)) return 'email';
  if (c.tipo === 'url' && v && !URL_RE.test(v)) return 'url';
  return '';
}
const vacio = (c, v) => (c.tipo === 'check' ? v !== true : !String(v == null ? '' : v).trim());
// Campos obligatorios sin completar y errores de formato; `r` = respuestas en claro, `ac` = acuerdos marcados {a1:true}
function validar(r, ac) {
  const faltan = [], formato = {};
  for (const c of CAMPOS) {
    const val = c.tipo === 'check' ? !!(ac && ac[c.id]) : (r || {})[c.id];
    if (c.req && vacio(c, val)) faltan.push(c.id);
    const f = c.tipo === 'check' ? '' : errorFormato(c, String(val == null ? '' : val).trim());
    if (f) formato[c.id] = f;
  }
  return { faltan, formato, ok: !faltan.length && !Object.keys(formato).length };
}
// Progreso = % de obligatorios completos
function progreso(r, ac) {
  let n = 0;
  for (const id of OBLIGATORIOS) { const c = POR_ID[id]; if (!vacio(c, c.tipo === 'check' ? !!(ac && ac[id]) : (r || {})[id])) n++; }
  return Math.round(n * 100 / OBLIGATORIOS.length);
}
const publico = () => SECCIONES;   // el esquema no contiene datos privados

module.exports = { SECCIONES, CAMPOS, POR_ID, ACUERDOS, SENSIBLES, OBLIGATORIOS, EMAIL_RE, URL_RE, limpiar, errorFormato, validar, progreso, publico };
