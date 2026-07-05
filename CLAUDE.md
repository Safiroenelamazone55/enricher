# Nova / Enricher — Guía del proyecto (Kiwoc)

Plataforma SaaS de Kiwoc ("Nova"): enriquecimiento de leads + Lead Manager (CRM outbound estilo Apollo/Outreach) + módulos de Management (finanzas, tareas, time tracking, oportunidades).

## Arquitectura

- **Frontend**: estático servido por **Cloudflare Workers**. Un solo `frontend/app.js` (IIFE gigante con módulos: `LeadManagerModule`, etc.), `frontend/style.css`, `frontend/index.html`. Sin framework/build — JS vanilla.
- **Backend**: Node/Express + PostgreSQL (`pg`) en un servidor **Vultr `45.32.160.165`** (puerto 3001, PM2 proceso `enricher-backend`). DB = **Supabase** (pooler). `backend/server.js` (rutas) + `backend/db.js` (esquema: corre `CREATE TABLE IF NOT EXISTS` / `ALTER ... ADD COLUMN IF NOT EXISTS` al arrancar).
- **Dominio público**: `enricher.kiwoc.com` (detrás de Cloudflare). El auth es por sesión (cookie).
- **agent/**: agente de escritorio (time tracking, empaquetado a .exe con Node SEA + instalador Inno Setup). **extension/**: extensión de navegador.

## Cómo desplegar

- **Frontend** (NO reinicia backend, NO cierra sesión):
  ```
  cd C:\enricher && npx wrangler deploy
  ```
  **SIEMPRE** subir el `?v=` de `style.css` y `app.js` en `index.html` en cada deploy (cache-bust). Cloudflare cachea en el borde: si un curl no ve el cambio, reintentar con `?v=...&cb=$RANDOM`.

- **Backend** (⚠️ reinicia PM2 → **cierra todas las sesiones, hay que volver a iniciar sesión** — avisar siempre a la usuaria):
  ```
  cd C:\enricher && python deploy_backend.py
  ```
  Sube `server.js`/`db.js`/`package.json` por SFTP y reinicia. Credenciales SSH/DB están en `deploy_backend.py` y `backend/.env` (ambos **gitignored**, no viajan por git — copiar a mano en otro equipo).

## Verificación (app OAuth-gated: no se puede manejar en vivo)

Patrón: editar → `node --check` (+ tests de lógica en scratchpad para motores) → subir `?v=` → deploy → `curl` a la URL pública buscando símbolos/CSS (reintentar con cache-bust fresco por lag del borde).

**Ojo:** Cloudflare devuelve **404 a POST /api desde curl headless** aunque la ruta funcione. Para verificar endpoints POST, ir **directo al origen**: `curl -k -X POST https://45.32.160.165/api/... -H "Host: enricher.kiwoc.com"` → 401 = ruta viva. Inspección de DB/logs vía SSH+node (paramiko).

## Restricciones permanentes (feedback de Jenny)

- **Aditivo**: no romper lo existente. Datos honestos, sin placeholders falsos.
- **NO editar el frontend con PowerShell `Get/Set-Content`** → corrompe UTF-8 (mojibake en acentos). Usar la herramienta Edit o Node.
- **UI nivel "SaaS con capital"**: pulida, con micro-interacciones, popovers propios (no `<select>` nativo cuando se puede), data-viz real (Chart.js ya cargado global).
- **"No alto excesivo"**: modales/paneles compactos, full-width, con `max-height` + scroll interno; pickers propios.
- **Marca**: verde `#00804C` + navy + lima; fuente Plus Jakarta Sans; sidebar navy.
- Los `{{variables}}` de plantillas usan **doble llave**: `{{first_name}}`, `{{company}}`.

## Notas de implementación

- `db.js` usa FK con `ON DELETE CASCADE/SET NULL`, pero **en la DB real algunas quedaron NO ACTION** (los `ALTER IF NOT EXISTS` se saltan si ya existía). Por eso el borrado en lote usa endpoints `POST /api/lm/{contacts,companies}/bulk-delete` (1 request, transacción) en vez de N DELETE — el rate limiter (100 req/min) rechazaba las ráfagas con 429.
- Importación CSV: decodificar el buffer como **UTF-8** antes de SheetJS (`XLSX.read(str,{type:'string'})`), si no asume CP1252 y rompe acentos.
- La memoria persistente de Claude está en `~/.claude/projects/C--email-verifier/memory/` (global, **no** en este repo) — copiarla aparte para llevar el contexto histórico a otro equipo.
