# PROMPT — Elevación visual Nova v2 → nivel "referencia" (ejecutar por secciones)

> **Cómo usarlo:** en Claude Code di "lee UI_UPGRADE_PROMPT.md y ejecútalo" e indica al final la sección:
> `SECCIÓN: Dashboard` (o Contactos, Empresas, Secuencias, Detalle de secuencia, Tareas comerciales, Campañas, Clientes outbound, Plantillas, Reportes, Inbox, Configuración, Ficha de contacto, Barra de tarea).

---

## Rol

Actúa como **dueño de este SaaS y diseñador-desarrollador frontend senior** (nivel Linear / Attio / Notion / Stripe). Nova ya funciona; tu trabajo NO es agregar funciones — es llevar la sección indicada al nivel visual de las referencias que Jenny aprobó (abajo). Cada pantalla debe poder ponerse al lado de esas referencias sin dar vergüenza.

## EL OBJETIVO — ADN de las referencias aprobadas por Jenny (2026-07-09)

Jenny compartió 5 interfaces que definen el estándar (helpdesk tipo Kirridesk, reporting POS, dashboard cripto, consola de base de datos, checklist de documentos hipotecarios). Su ADN común — **estas son las 12 leyes; todo cambio se justifica contra ellas**:

1. **Base neutra y silenciosa.** El lienzo es blanco/gris clarísimo; las tarjetas son blancas con **hairlines** (`rgba(11,30,58,.06–.08)`) y sombras apenas perceptibles. El gris hace el 90% del trabajo; el color es escaso y por eso significa algo.
2. **Un solo acento, con disciplina.** El color de marca aparece SOLO en: acción primaria, estado activo de navegación, links/números clave y estados positivos. Nunca en fondos grandes, nunca varios colores compitiendo. En Nova: verde `#00804C` (acción/activo), navy `#0A2540` (titulares/números), y NADA más salvo semánticos puntuales.
3. **Jerarquía por tamaño y peso, no por color.** Números grandes (18–22px, 700–800, navy) + **labels pequeñas en uppercase muted** (10.5–11.5px, 600–700, tracking .05–.08em, `#8A94A6`). Esa pareja "número grande / label chiquita" es EL patrón de las referencias.
4. **Filas y densidad compactas.** Filas de lista/tabla 44–52px, alineadas a una grilla de 4/8px. Nada de cajas infladas ni aire arbitrario. (Regla ya validada por Jenny: lista plana ~50px.)
5. **Listas planas, no cajas sueltas.** Grupos = UN contenedor blanco r12–16 con filas separadas por hairlines. El estado de una fila es una **barra fina de 2px** al borde o un punto de color — jamás un borde de color alrededor de toda la caja ("grotesco", palabra de Jenny).
6. **Estados como texto + punto, no como bloque.** "Verified" verde, "Pending" ámbar, "Upload required" rojo — texto pequeño semibold con puntito, o chip MUY suave (fondo tinte + texto oscuro). Nunca texto blanco sobre color chillón.
7. **Acciones secundarias silenciosas.** "Ver detalles ›" pequeño y gris en la esquina del header de la tarjeta; acciones por fila = **píldoras tintadas** (fondo `#F3F5F7` o tinte del acento al 8–12%, texto oscuro, icono 12–14px, alto 26–30px) o iconos ghost que aparecen al hover.
8. **Label–value en dos columnas** para detalles (ficha, paneles): label muted a la izquierda (12px `#8A94A6`), valor a la derecha (13–13.5px, 600, navy), filas de ~32px con hairline opcional. Nada de formularios gigantes para LEER datos.
9. **Data-viz sobrio e integrado:** barras de distribución segmentadas (h8–10, r999, colores de una misma rampa, con leyenda de puntos + % debajo), anillos/donuts finos, sparklines — siempre acompañados del número grande. Sin gráficas-juguete.
10. **Iconografía única y consistente:** un solo set outline (en Nova ya existe `NI(name)` estilo Lucide — úsalo SIEMPRE; **prohibido introducir emojis nuevos en UI crónica**; migra los que encuentres en la sección: ⚠✓✕📞🔗⏰ → NI o CSS). Iconos 13–16px, en chips cuadrados r7–9 con tinte suave cuando encabezan algo.
11. **Sidebar/nav con grupos etiquetados** (label uppercase muted), ítem activo = **píldora de fondo suave** (no solo color de texto), iconos alineados, contadores como chips discretos.
12. **Todo estado tiene diseño:** hover (tinte 3–5%), focus (ring suave del acento), activo (hundido leve), vacío (icono + frase + acción), cargando (skeleton shimmer suave, no texto "Cargando…" pelado cuando sea fácil evitarlo).

## Sistema de diseño Nova v2 (tokens de referencia)

- **Lienzo:** `#F6F5EF` (Praxeti, ya existente) usado QUIETO; superficies `#fff`; superficies secundarias `#F8F9FA`.
- **Texto:** titulares/números `#0A2540` · cuerpo `#33475B` · secundario `#5B6B7B` · muted/labels `#8A94A6`.
- **Hairline:** `rgba(11,30,58,.06)` (divisores) · `.08` (bordes de tarjeta) · `.12` (bordes de control).
- **Tipografía:** Plus Jakarta Sans. Título de sección 20–22px/800 · card-title 13–14px/700 · body 13–13.5px/500 · label uppercase 10.5–11.5px/600–700 tracking .06em · número-stat 18–22px/800 tabular.
- **Radios:** 999px píldoras/controles chicos · 8–10px inputs/botones · 12–16px tarjetas · sombra tarjeta `0 1px 2px rgba(11,30,58,.04), 0 6px 18px rgba(11,30,58,.05)`.
- **Semánticos (texto/punto/chip suave):** ok `#15803D`/bg `#E7F8EF` · alerta `#B45309`/`#FEF3C7` · error `#C4342B`/`#FDECEA` · info `#0369A1`/`#E0F2FE`.
- **Transiciones:** `.15s ease` en todo lo interactivo. Hover de fila `#F7FAF8` o `rgba(11,30,58,.03)`.

## Recetario de componentes (specs listas para copiar)

1. **Stat strip / KPI:** fila de 3–5 stats separadas por hairlines verticales; cada stat = label uppercase muted arriba + número 20px/800 navy (+ sub-dato 11px muted o delta verde/rojo con signo). Padding 12–14px.
2. **Card con header silencioso:** header = título 13px/700 + acción "Ver más ›" 12px `#8A94A6` a la derecha (hover → navy); cuerpo con padding 14–16px; hairline entre header y cuerpo solo si hay lista dentro.
3. **Label–value grid:** `grid-template-columns: 130px 1fr; row-gap: 9px` — label muted, valor semibold navy; valores accionables (email, URL) en verde `#006B3F` con hover underline.
4. **Tabla/lista plana:** contenedor r14 hairline; thead labels uppercase 10.5px muted; filas 44–48px hover tinte; números alineados a la derecha tabular; acciones por fila = píldoras tintadas o iconos ghost al hover; paginación al pie ("Mostrando X–Y de N" + ‹ ›) — ya existe patrón en Contactos, replicarlo.
5. **Barra de distribución:** contenedor h8–10 r999 bg `#EEF1F4`; segmentos con la rampa del verde (`#00804C→#74C365→#DBE64C`) o semánticos; leyenda debajo: punto 7px + label 12px + valor 12px/700.
6. **Chip de estado:** punto 6–7px + texto 11.5px/600 del color semántico oscuro; o píldora bg tinte + texto oscuro, h20–22.
7. **Píldora de acción por fila:** h26–28, r999, bg tinte 8–12%, texto 12px/700 oscuro del tinte, icono NI 12px; hover → tinte 16%.
8. **Nav/tabs activos:** píldora bg `rgba(0,128,76,.08)` + texto `#006B3F`/700 (o navy); inactivo gris `#5B6B7B` con hover navy. Contadores = chip 18px r999 bg `rgba(11,30,58,.06)`.
9. **Vacío:** icono NI 20px en círculo tinte + frase 13px + subfrase muted + botón/acción; máx ~120px de alto (Jenny: sin altos excesivos).
10. **Skeleton:** bloques `#EEF1F4` r8 con shimmer (gradiente animado 1.2s) reemplazando texto/tarjetas mientras carga — al menos en la primera carga de la sección.
11. **Panel de detalle/preview (fichas):** cabecera con avatar/nombre/chips → stat strip → secciones "Detalles" (label-value) → actividad como timeline con puntos conectados y hora muted (referencia Kirridesk).

## Proceso obligatorio (en este orden)

1. **LEE antes de tocar:** localiza el render de la sección en `frontend/app.js` (función `_v<Sección>` o equivalente) y TODAS sus clases en `frontend/style.css`. Inventario completo de lo que muestra (estados incluidos).
2. **Audita contra las 12 leyes:** lista numerada de defectos con severidad (alta/media/baja) y qué ley rompen. Caza específicamente: emojis en UI, cajas con borde de color, alturas infladas, labels sin jerarquía, colores fuera de token, estados faltantes (hover/focus/vacío/carga), inline styles repetidos (3+ → clase), grises cálidos heredados (#8a837a, #EDEBE6, #1c1a17…).
3. **Plan priorizado** (8–20 cambios): qué → ley que restaura → dónde (clase/función). Pulido profundo, misma estructura funcional.
4. **Ejecuta TODO:** CSS al FINAL de `style.css` en un bloque comentado `/* ═══ <SECCIÓN> — elevación v2 ═══ */` (la cascada gana); markup solo visual en `app.js`.
5. **Verifica y despliega** (checklist abajo) y reporta.

## Restricciones técnicas (romper esto = fallo)

- **Cero cambios de comportamiento:** cada `onclick="LeadManagerModule.x(...)"`, id `lm-*` y `data-*` sigue idéntico. Solo clases, markup decorativo y CSS.
- Un solo `app.js` + `style.css` + `index.html`. **Sin frameworks, CDNs ni build steps nuevos.**
- **NUNCA editar con PowerShell Get/Set-Content** (corrompe UTF-8). Edit tool o Node.
- Clases compartidas (`.btn`, `.clients-table`, `.lm-*`, `.seq-task`, `.cp-*`): `grep` de usos ANTES de tocarlas; si el cambio no aplica a todos los usos, crea variante con scope de la sección.
- NO tocar el CSS de informes PDF (`_rptCss`, `_seqReportHtml`, `_cmpReportHtml`) ni el login SVG.
- Emojis: se eliminan de la UI de la sección reemplazándolos por `NI()`/CSS, EXCEPTO donde son contenido (mensajes escritos por la usuaria).

## Checklist de cierre (obligatorio)

1. `node --check frontend/app.js` ✅ y grep de que no quedó ningún onclick/id roto.
2. Bump en `index.html`: `app.js?v=YYYYMMDD<letra>` y `style.css?v=` si tocaste CSS.
3. `git add -A && git commit -m "UI <Sección> v2: <resumen>"` **y `git push`** (siempre, sin preguntar).
4. `npx wrangler deploy` + `curl` confirmando que la versión nueva y el CSS nuevo responden.
5. Reporte a Jenny en español: defectos encontrados (con la ley) → qué cambió → qué mirar con Ctrl+F5.

## Criterio de "terminado"

Pon mentalmente la sección al lado de las referencias (helpdesk/POS/cripto/DB/checklist): ¿misma calma, misma jerarquía, mismo cuidado en chips, iconos y estados? Si algo se ve "funcional pero tosco" — cajas de colores, emoji suelto, fila gorda, label sin jerarquía — **no está terminado**.

---

**SECCIÓN:** _(escribir aquí, p. ej. "Dashboard")_
