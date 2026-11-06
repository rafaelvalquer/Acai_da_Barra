<#
  Luminor PDV - abre o caixa. É o que o atalho "Luminor PDV" executa.
  Espera o PDV responder (logo depois de ligar o computador ele leva alguns segundos para iniciar) e abre o caixa em
  uma janela própria do Microsoft Edge, sem barra de endereço. Sem o Edge, abre no navegador padrão.
#>
param([int]$Porta = 3187, [int]$Espera = 45)
$ErrorActionPreference = 'SilentlyContinue'
$url = "http://127.0.0.1:$Porta"
[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy
function Responde { try { $null = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2; $true } catch { $false } }

$limite = (Get-Date).AddSeconds($Espera)
$pronto = Responde
while (-not $pronto -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 700; $pronto = Responde }
if (-not $pronto) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "O Luminor PDV ainda não respondeu.`n`nSe o computador acabou de ligar, aguarde um minuto e abra de novo.`nSe continuar assim, reinicie o computador ou chame o responsável pelo sistema.",
    'Luminor PDV', 'OK', 'Warning') | Out-Null
  exit 1
}
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Start-Process $edge -ArgumentList "--app=$url", '--start-maximized' }
else { Start-Process $url }
