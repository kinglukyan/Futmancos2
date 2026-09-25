@echo off
cd /d "%~dp0.."
node scripts\generate-vapid.js
if errorlevel 1 (
  echo.
  echo Verifique se o Node.js esta instalado no computador.
) else (
  echo.
  echo Copie as tres linhas VAPID para Environment no Render.
)
echo.
pause
