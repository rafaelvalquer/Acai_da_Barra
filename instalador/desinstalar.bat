@echo off
rem Luminor PDV - remove o programa deste computador. Os dados em C:\ProgramData\LuminorPDV sao mantidos.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desinstalar.ps1" %*
