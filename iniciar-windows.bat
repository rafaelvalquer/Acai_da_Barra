@echo off
cd /d "%~dp0"
node --version >nul 2>&1
if errorlevel 1 (
  echo Instale Node.js 22 LTS ou superior antes de iniciar.
  pause
  exit /b 1
)
echo Iniciando Luminor PDV...
start "" "http://127.0.0.1:3187"
node src\server.js
pause
