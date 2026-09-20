# Portal del cliente — rediseño v2 (guardado, NO en vivo)

Modelo guardado el 2026-09-20 para seguir trabajándolo más adelante.

- Archivos de esta carpeta: `portal.js`, `portal.css`, `portal.html` (versión v2 completa).
- También en git: tag `portal-v2-rediseno` y rama `portal-v2`.
- Ruta de backend que usa (ya está en producción, inofensiva): `GET /api/portal/series` (serie diaria para minigráficos y gráfico de actividad).
- Versión en vivo = tag `portal-v1-antes-rediseno`.

Para volver a publicarlo: copiar estos 3 archivos a `frontend/`, subir los `?v=` en portal.html y `npx wrangler deploy`.

Pendiente de decidir: meta mensual de toques (tarjeta "72 %"), selector de fechas real, "AI Insights" (no existe), radio de esquinas.
