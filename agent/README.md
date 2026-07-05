# Nova Activity — Desktop Agent (Fase 3)

Programa **local** que corre en tu PC (Windows) en segundo plano y registra en
Nova el tiempo que usas **apps de escritorio** (Figma, VS Code, Photoshop, Word…)
— lo que la extensión del navegador no puede ver. Usa el **mismo** `/timer/ingest`
y el **mismo token** que la extensión.

> No es un APK ni una app móvil. Es un agente de escritorio que corre en la computadora.

## Instalar como aplicación (recomendado)

Lo más simple: un **instalador con asistente** — no necesitas Node ni tocar archivos.

1. Ejecuta **`NovaActivitySetup.exe`** (se genera con `build.ps1`, ver abajo).
2. El asistente te pide **pegar tu token** de Nova (Time Tracking → Fuentes de actividad → Conectar).
3. Listo: queda un **icono en la bandeja del sistema**, **arranca solo con Windows** y aparece en **"Agregar o quitar programas"**.

**Icono de bandeja** (clic derecho):
- **Estado** — monitoreando / timer apagado / en pausa, y cuántos bloques quedan por enviar.
- **Pausar / Reanudar** — detén o retoma el monitoreo cuando quieras.
- **Ver registro (log)** — abre `agent.log`.
- **Abrir Nova** · **Salir**.

Sigue capturando **solo con el timer PRENDIDO** en Nova (y sin pausa manual).

### Generar el instalador (una vez, en la PC de build)
```
powershell -ExecutionPolicy Bypass -File build.ps1
```
Crea `dist\nova-activity.exe` con **Node SEA** (empotra el runtime, sin requerir Node) y, si tienes **Inno Setup** (`winget install JRSoftware.InnoSetup`), compila `Output\NovaActivitySetup.exe`. Requiere internet la primera vez (descarga `postject`).

---

## Cuándo captura (importante)
- **Solo mientras tienes un timer PRENDIDO en Nova.** Si el timer está apagado, el agente
  queda **en pausa**: no monitorea ni envía nada. Al prender el timer, retoma automáticamente
  (revisa el estado cada ~12s). Cada bloque de actividad se asocia a la tarea que estabas
  cronometrando en ese momento.
- **Multi-perfil de Chrome / todas las apps:** como lee la ventana **activa del sistema
  operativo**, ve **cualquier perfil de Chrome** y **cualquier aplicación** — a diferencia de
  la extensión del navegador, que solo ve el perfil donde está instalada. Por eso el agente es
  la solución para quienes trabajan con varios perfiles de Chrome.

## Qué envía (honesto)
Solo: **nombre de la app**, **título de la ventana** y **tiempo activo/idle**.
**Nunca** lee el contenido, ni teclas (keylogging), ni hace capturas de pantalla.
El idle es el **real del sistema** (`GetLastInputInfo`): si te alejas del teclado,
deja de contar.

```
probe.ps1 (Win32: app activa + idle)  ──líneas JSON──►  agent.js
   agent.js  ──POST /api/timer/ingest (source=desktop_agent, app_usage, Bearer token)──►  Nova
```

## Requisitos
- **Node.js 18 o superior** (`node -v`). Descarga: https://nodejs.org
  (Más adelante se puede empaquetar a un `.exe` para no requerir Node — ver abajo.)

## Instalación (modo script — alternativa para desarrolladores)
1. Copia `config.example.json` a **`config.json`**.
2. En Nova → **Time Tracking → Fuentes de actividad → Conectar** → copia tu token.
3. Pega el token en `config.json` (campo `"token"`). Ajusta `apiBase` si hace falta.
4. **Probar** (ventana visible con log): doble clic en **`start.bat`**.
   - Deberías ver `Nova Activity Agent · …` y, al cambiar de app, `enviados N bloque(s)`.
5. **Dejarlo automático** (sin ventana, arranca al iniciar sesión):
   ```
   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
   ```
   Para iniciarlo ya mismo sin reiniciar: doble clic en `run-hidden.vbs`.

## Configuración (`config.json`)
| Campo | Qué es | Default |
|---|---|---|
| `apiBase` | API de Nova | `https://api.kiwoc.com/api` |
| `webUrl` | Web de Nova (botón "Abrir Nova" de la bandeja) | `https://enricher.kiwoc.com` |
| `token` | Tu token de extensión (de Nova → Conectar) | — |
| `pollSeconds` | Cada cuánto mira la app activa | `15` |
| `idleThresholdSeconds` | Segundos sin teclado/ratón = idle | `60` |
| `minSegmentSeconds` | Ignora usos más cortos que esto | `15` |
| `flushSeconds` | Cada cuánto envía a Nova (respaldo) | `60` |
| `tray` | Mostrar el icono en la bandeja del sistema | `true` |

> `config.json` lleva **tu token** — es personal, no lo compartas ni lo subas a git.
> Los bloques sin enviar quedan en `.buffer.json` y se reintentan luego (sobrevive a reinicios).

## Detener / desinstalar
- Detener (modo prueba): `Ctrl+C` en la ventana de `start.bat`.
- Detener el oculto: cierra el proceso **node.exe** en el Administrador de tareas.
- Quitar el autostart:
  ```
  powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
  ```

## Empaquetar a `.exe` (implementado)
Ya está: `build.ps1` empaqueta `agent.js` con **Node SEA** (nativo de Node 20+) en `dist\nova-activity.exe` — no requiere Node en la PC destino. `probe.ps1`, `tray.ps1` e `icon.ico` se distribuyen junto al `.exe`. El instalador (`installer.iss`, Inno Setup) arma `NovaActivitySetup.exe` con página de token, arranque con Windows y desinstalador.

## Mac / Linux (futuro)
La sonda actual es de Windows. Para macOS/Linux se reemplaza `probe.ps1` por el
equivalente (en macOS pide permiso de **Accesibilidad** para leer títulos de ventana);
`agent.js` no cambia.

## Privacidad
Igual que la extensión: solo metadatos de uso (app + título + tiempo), enviados
únicamente a tu Nova (`api.kiwoc.com`). Se puede pausar (cerrar el agente) y los
datos viven en tu propia instancia.
