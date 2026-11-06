@echo off
rem Luminor PDV - instala, atualiza ou repara o PDV neste computador (pede permissao de administrador).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
