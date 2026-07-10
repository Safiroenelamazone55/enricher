# PROMPT — Elevación visual de Nova a SaaS maduro (ejecutar por secciones)

> **Cómo usarlo:** pega esto en Claude Code (o dile "lee UI_UPGRADE_PROMPT.md") y al final indica la sección:
> `SECCIÓN: Dashboard` (o Contactos, Empresas, Secuencias, Tareas comerciales, Campañas, Clientes outbound, Plantillas, Reportes, Inbox, Configuración, Ficha de contacto, Barra de tarea).

---

## Rol

Actúa como **dueño de este SaaS y desarrollador frontend senior** (nivel Linear/Attio/Stripe). Nova ya funciona — tu trabajo NO es agregar funciones: es subir **drásticamente** el nivel visual y de sensación de producto de la sección indicada, hasta que se vea como un SaaS en etapa madura: claro, trabajado al detalle, balanceado y con micro-interacciones.

## Proceso obligatorio (en este orden)

1. **LEE antes de tocar.** Abre `frontend/app.js` (busca la función `_v<Sección>` / render de la sección) y `frontend/style.css` (sus clases). Haz un inventario de TODO lo que la sección muestra: encabezados, botones, tablas, chips, vacíos, modales, estados.
2. **Audita como dueño exigente.** Lista concreta de defectos, cada uno con severidad (alta/media/baja). Busca específicamente:
   - Jerarquía tipográfica plana (todo del mismo tamaño/peso) · textos que compiten
   - Espaciado inconsistente (paddings/gaps arbitrarios; usa escala 4/8/12/16/24/32)
   - Colores fuera de paleta, grises sucios, bordes duros (#000/#ccc), sombras toscas
   - Botones/inputs sin estados hover/focus/active/disabled · sin transición
   - Tablas: filas apretadas o infladas, headers gritones, celdas sin alineación por tipo (números a la derecha)
   - Iconos mezclados (emoji + SVG sin criterio), tamaños dispares
   - Vacíos/cargando pobres (texto plano en vez de empty-state con icono + acción)
   - Falta de feedback: acciones sin confirmación visual, sin skeletons/spinners
   - Contraste insuficiente (AA mínimo) · targets táctiles < 32px
3. **Propón el plan** (5–15 cambios priorizados) en una tabla corta: qué, por qué, dónde (clase/función). Nada de rediseños totales: es pulido profundo, misma estructura.
4. **Ejecuta TODO el plan** editando `style.css` (preferente) y los template strings de `app.js` (solo clases/markup visual — cuidado abajo).
5. **Verifica y despliega** (checklist al final).

## Sistema de diseño Nova (respetar SIEMPRE)

- **Marca:** verde `#00804C` (primario) · verde oscuro `#006B3F` (hover/links fuertes) · navy `#0A2540` (sidebar/textos titulares) · lima como acento puntual (no fondos grandes).
- **Fondo app:** crema/Praxeti `#F6F5EF` aprox — las tarjetas van blancas sobre él.
- **Tipografía:** Plus Jakarta Sans. Escala sugerida: 22–24 títulos de sección (800), 15–16 subtítulos (700), 13.5–14 cuerpo (500), 11–12 metadatos/labels (600, uppercase tracking 0.04em para labels).
- **Radios:** 8px controles · 12–16px tarjetas/modales. **Sombras:** suaves y en capas (`0 1px 2px rgba(11,30,58,.04), 0 6px 18px rgba(11,30,58,.05)`), nunca negras duras.
- **Bordes:** `rgba(11,30,58,.06–.10)`. **Grises de texto:** `#5b6b7b` secundario, `#8C97A3` terciario.
- **Semánticos:** éxito `#15803D`/`#E7F8EF` · alerta `#B45309`/`#FEF3C7` · error `#C4342B`/`#FDECEA` · info `#0369A1`/`#E0F2FE` (fondo suave + texto oscuro, jamás texto blanco sobre pastel).
- **Micro-interacciones:** `transition: .15s ease` en hover/focus de todo lo clicable; hover de fila = fondo `rgba(0,128,76,.035)`; focus visible (`outline` o ring verde suave); botones con estado activo levemente hundido.
- **Densidad:** tablas cómodas (filas 44–52px), toolbars alineadas a una sola línea de altura, chips compactos.

## Restricciones técnicas (romper esto = fallo)

- **NO cambies comportamiento ni quites funciones**: cada `onclick="LeadManagerModule.x(...)"`, id (`lm-*`), y `data-*` debe seguir funcionando igual. Solo visual.
- Frontend = un solo `app.js` (template strings) + `style.css` + `index.html`. **No introduzcas frameworks, CDNs nuevos ni build steps.**
- **NUNCA edites con PowerShell Get/Set-Content** (corrompe UTF-8/acentos). Usa herramientas de edición o Node.
- CSS: prefiere clases nuevas o ajustar las existentes en `style.css`; evita inflar los inline styles de app.js (si un inline style se repite 3+ veces, conviértelo en clase).
- Cuida las OTRAS secciones: clases compartidas (`.clients-table`, `.btn`, `.lm-*`) afectan a toda la app — si cambias una compartida, revisa dónde más se usa (`grep`) o crea una variante con scope.
- El HTML de informes PDF (`_rptCss`, `_seqReportHtml`, `_cmpReportHtml`) tiene su propio estilo — NO lo toques desde esta tarea.

## Checklist de cierre (obligatorio)

1. `node --check frontend/app.js` en verde.
2. Grep rápido: ningún `onclick` roto ni id renombrado.
3. Bump de versión en `index.html`: `app.js?v=YYYYMMDD<letra>` **y** `style.css?v=` si tocaste CSS.
4. `git add -A && git commit` (mensaje: `UI <Sección>: <resumen>`) **y `git push`** (Jenny lo quiere siempre).
5. `npx wrangler deploy` y verifica con `curl` que la versión nueva responde.
6. Reporta a Jenny en español: lista de defectos encontrados → qué se cambió → qué revisar con Ctrl+F5, sección por sección.

## Criterio de "terminado"

La sección resiste esta pregunta: *"¿Un usuario que paga $99/mes por esto sentiría que el producto es premium?"* — jerarquía clara en 1 vistazo, nada desalineado a ojo, estados vivos (hover/focus/empty/loading), y consistencia total con el sistema de diseño de arriba.

---

**SECCIÓN:** _(escribir aquí, p. ej. "Dashboard")_
