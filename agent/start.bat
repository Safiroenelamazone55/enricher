@echo off
REM start.bat - arranca el agente en primer plano (para probar y ver el log).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado. Instalalo desde https://nodejs.org y vuelve a intentar.
  pause
  exit /b 1
)
echo Iniciando Nova Activity Agent... (Ctrl+C para detener)
node agent.js
echo.
echo El agente se detuvo.
pause
