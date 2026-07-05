# Publicar en la Chrome Web Store — checklist

Estado: **funciona cargada "unpacked"** y es **técnicamente publicable**. Falta
sobre todo el papeleo de la tienda (cuenta, política de privacidad, listing).

## ✅ Ya listo (técnico)
- Manifest V3 válido.
- **Iconos** 16/32/48/128 (`icons/`, generados con `node icons/make-icons.js`).
- Sin código remoto (MV3 lo prohíbe): solo hace `fetch` de datos a tu API, no ejecuta scripts externos.
- Permisos mínimos: `tabs`, `idle`, `storage`, `alarms` + `host_permissions` solo a `https://api.kiwoc.com/*`.
- Auth por token (no depende de cookies).

## ⛔ Lo que falta para subirla

### 1. Cuenta de desarrollador (una vez)
- Regístrate en el **Chrome Web Store Developer Dashboard** y paga el fee único de **US$5**.

### 2. Política de privacidad (OBLIGATORIA)
Usas el permiso `tabs` (lees URLs/dominios) → Google exige una **URL pública de
política de privacidad**. Debe decir, como mínimo:
- Qué recoges: **dominio, título de pestaña y tiempo** de uso (no contenido, no keystrokes, no capturas).
- Para qué: registrar tu tiempo de trabajo en tu propia instancia de Nova.
- Dónde va: solo a tu servidor Nova (`api.kiwoc.com`); no se vende ni se comparte.
- Que se puede desactivar y borrar.
> Puedes alojarla en `kiwoc.com/privacy-extension` o una página de Notion pública.

### 3. Declaración de prácticas de datos (en el dashboard)
- **Single purpose:** "Registrar el tiempo de trabajo por sitio web en Nova".
- Categoría de datos: *Web history* (dominios visitados). Marca: no se vende, uso solo para la funcionalidad.
- Justifica cada permiso (sobre todo `tabs` y el host remoto).

### 4. Recursos del listing
- **Nombre** y **descripción** (corta + detallada).
- **Al menos 1 screenshot** 1280×800 o 640×400 (sirve el popup + el dashboard de Nova).
- Icono de tienda 128×128 (ya lo tienes).
- (Opcional) tile promocional 440×280.
- Idioma, categoría (*Productivity*).

### 5. Empaquetado y envío
- Sube un **ZIP** de esta carpeta (sin `make-icons.js` ni `*.md` si quieres, no estorban).
- Sube → **Enviar a revisión**. Google la revisa (días). El permiso `tabs` y el host
  remoto reciben escrutinio: ten lista la justificación y la política de privacidad.

### 6. Antes de enviar (recomendado)
- Sube `version` en `manifest.json` en cada release (ej. `0.1.0` → `1.0.0`).
- **Token por usuario:** hoy cada quien pega su token desde Nova (bien para uso interno).
  Para distribución pública conviene un **flujo OAuth/login dentro del popup** en vez de
  pegar token a mano (mejora futura).

## ¿Hace falta publicarla?
Para **uso interno del equipo** NO necesitas la tienda: cárgala *unpacked* o
distribúyela como ZIP / `.crx` por **política de empresa**. La Web Store solo es
necesaria si quieres instalación pública de un clic.
