# Nova Activity — Browser Extension (Fase 2)

Cliente de la **Fase 2** del Time Tracking de Nova. Envía a Nova el tiempo real
de uso por **sitio web / pestaña activa**, asociándolo con la tarea que estás
cronometrando. Es el primer consumidor del contrato `POST /api/timer/ingest`
que ya existe en el backend.

> Honesto por diseño: la web app de Nova **no** detecta apps ni websites. Esa
> actividad real solo llega desde esta extensión (Fase 2) o el Desktop Agent
> (Fase 3). Si no instalas ninguna, Nova muestra un *empty state*, no datos falsos.

## Qué envía (y qué NO)

Envía, por cada segmento de navegación ≥ 15s:

- `website_domain` (ej. `docs.google.com`)
- `window_title` (título de la pestaña)
- `started_at`, `ended_at`, `duration_s`
- `source: "browser_extension"`, `activity_type: "website_usage"`
- `task_id` de la tarea que tengas cronometrando en Nova (si hay timer activo)

**No** lee el contenido de las páginas, **no** hace keylogging, **no** toma
capturas. Solo dominio + título + tiempo. El *idle* se mide con la API real del
navegador (`chrome.idle`), no asumiendo "Nova está activa".

## Instalar (modo desarrollador)

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo de desarrollador**.
3. **Cargar descomprimida** → selecciona esta carpeta `extension/`.
4. Inicia sesión en Nova en este navegador (la extensión reutiliza tu sesión).
5. Abre el popup: debe decir **Conectado**.

> Falta agregar iconos (`action.default_icon`); Chrome usa uno por defecto.
> Para producción, añade `icons/16,48,128.png` al `manifest.json`.

## Autenticación (token de extensión · recomendado)

1. En Nova → **Time Tracking** → card *Fuentes de actividad* → botón **Conectar**
   en "Browser Extension". Genera un token (`nova_ext_…`) que se muestra una vez.
2. Pégalo en el popup de la extensión (campo **Token de Nova**) y guarda.
3. La extensión envía `Authorization: Bearer <token>` en cada request.

El token se valida contra la tabla `ext_tokens` (se guarda solo su hash sha256) y
es **independiente de cookies** — funciona aunque la sesión web caduque.

> Alternativa sin token: si no pegas token, la extensión cae a la **cookie de
> sesión** de Nova (`credentials: 'include'` + `host_permissions`). Puede fallar
> si la cookie es `SameSite=Lax`; por eso el token es lo recomendado.

## Arquitectura

```
Extensión (este folder)                Nova backend (ya existe)
─────────────────────────              ─────────────────────────
background.js  ─ chrome.tabs ─┐
              ─ chrome.idle  ─┤ arma segmentos
              ─ chrome.alarms ┘ y los manda  ──►  POST /api/timer/ingest
popup.*       ─ estado/toggle                     (source=browser_extension,
                                                   activity_type=website_usage)
                                                  ▼
                                          time_entries (source, activity_type, metadata)
                                                  ▼
                                          Dashboard Time Tracking de Nova
```

## Roadmap

- **Fase 1 — Web (hecho):** timer manual + dashboard + modelo multi-fuente.
- **Fase 2 — Browser Extension (este scaffold):** dominio activo + idle → `ingest`.
- **Fase 3 — Desktop Agent:** app/ventana activa + idle real del sistema →
  mismo `POST /api/timer/ingest` con `source: "desktop_agent"`,
  `activity_type: "app_usage"`.

## Privacidad

Los datos viajan solo a tu instancia de Nova (`apiBase`, configurable en el
popup). Puedes desactivar el envío con el switch en cualquier momento; los
segmentos pendientes quedan en `chrome.storage.local` hasta que reconectes.
