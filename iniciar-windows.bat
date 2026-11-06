@echo off
rem Luminor PDV - inicio manual, sem instalar. Mantenha esta janela aberta enquanto usar o caixa.
rem Na loja, prefira instalador\instalar.bat: o PDV passa a iniciar sozinho com o Windows e os dados ficam
rem protegidos em C:\ProgramData\LuminorPDV.
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto semnode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)"
if errorlevel 1 goto nodeantigo

rem Ja esta aberto (pelo instalador ou por outra janela)? Entao so abre o caixa.
powershell.exe -NoProfile -Command "try{Invoke-RestMethod http://127.0.0.1:3187/api/health -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}"
if not errorlevel 1 goto jaaberto

node -e "require.resolve('pg');require.resolve('hash-wasm')" >nul 2>&1
if not errorlevel 1 goto iniciar
echo Instalando os componentes do PDV. Precisa de internet, so na primeira vez...
call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 goto semcomponentes

:iniciar
echo Iniciando Luminor PDV... Mantenha esta janela aberta enquanto usar o caixa.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0instalador\abrir-pdv.ps1"
node src\main.js
pause
exit /b

:jaaberto
echo O Luminor PDV ja esta em execucao. Abrindo o caixa...
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0instalador\abrir-pdv.ps1"
exit /b 0

:semnode
echo Instale o Node.js 22 LTS ou superior (https://nodejs.org) antes de iniciar.
pause
exit /b 1

:nodeantigo
echo Este Node.js e antigo. Instale o Node.js 22.16 LTS ou superior (https://nodejs.org).
pause
exit /b 1

:semcomponentes
echo Nao foi possivel instalar os componentes. Confira a internet e tente de novo.
pause
exit /b 1
