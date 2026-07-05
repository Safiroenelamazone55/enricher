# Instalar “Nova Activity” (3 pasos)

Esta extensión registra en Nova el tiempo que trabajas por sitio web, asociado a
la tarea que tengas cronometrando. Solo guarda **dominio, título y tiempo** — nunca
el contenido de las páginas, ni contraseñas, ni capturas.

## Pasos

**1. Descomprime** este ZIP en una carpeta (déjala en un lugar fijo, no la borres).

**2. Carga la extensión en Chrome / Edge:**
   1. Abre `chrome://extensions` (en Edge: `edge://extensions`).
   2. Activa **Modo de desarrollador** (interruptor arriba a la derecha).
   3. Clic en **Cargar descomprimida** y elige la carpeta que descomprimiste.
   4. Verás el icono naranja **N** en la barra del navegador.

**3. Conéctala a tu cuenta de Nova:**
   1. Entra a Nova → **Time Tracking** → tarjeta **Fuentes de actividad** → botón **Conectar**.
   2. Copia el token (`nova_ext_…`) que aparece.
   3. Abre el popup de la extensión (icono N) → pega el token en **Token de Nova**.
   4. Activa el interruptor **Enviar actividad web a Nova**.

✅ Listo. El estado debe decir **Conectado** y empezará a sincronizar solo.

## Notas

- **Cada persona usa su propio token** (genera el tuyo desde tu Nova).
- Se envía **automáticamente** (al cambiar de pestaña y cada minuto). El botón
  “Forzar envío ahora” es solo opcional.
- Para **pausar** el registro: apaga el interruptor del popup.
- Solo cuenta cuando **Chrome está enfocado**; si te vas a otra app o el equipo
  queda inactivo, no suma tiempo.
- Chrome puede mostrar al abrir un aviso de “extensiones en modo desarrollador”:
  es normal con extensiones internas, puedes cerrarlo.

¿Dudas? Avisa al equipo de Nova.
