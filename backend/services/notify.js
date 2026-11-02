'use strict';
// Avisos emergentes en tiempo real (toasts). La sala del socket es por espacio de trabajo, así que cada aviso
// lleva `para` (id de usuario destinatario) y el navegador descarta los que no son suyos.
let _io = null;
function setIO(io) { _io = io; }
function push(wid, aviso) {
  try { if (_io && wid) _io.to(`ws:${wid}`).emit('notif', Object.assign({ ts: Date.now() }, aviso)); } catch (_) {}
}
module.exports = { setIO, push };
