<#
  Luminor PDV - remove o programa deste computador.

  Como usar: dê dois cliques em instalador\desinstalar.bat e aceite a pergunta do Windows.

  Remove a tarefa de início automático, os atalhos e a pasta do programa. Os DADOS NÃO SÃO APAGADOS: vendas,
  produtos, backups e configurações continuam em C:\ProgramData\LuminorPDV, prontos para uma nova instalação.

  Opções:
    -Destino <pasta>   pasta do programa (padrão: a que a tarefa "Luminor PDV" usa, ou C:\Program Files\LuminorPDV)
#>
[CmdletBinding()]
param([string]$Destino)
$ErrorActionPreference = 'Stop'
$Tarefa = 'Luminor PDV'
$Dados = Join-Path $env:ProgramData 'LuminorPDV'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Destino) { $argumentos += @('-Destino', "`"$Destino`"") }
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $argumentos }
  catch { Write-Host 'A remoção precisa de permissão de administrador do Windows.' -ForegroundColor Red; Read-Host 'Pressione Enter para fechar' | Out-Null }
  exit
}
function Fim([int]$codigo) { Read-Host "`nPressione Enter para fechar" | Out-Null; exit $codigo }

$tarefaAtual = Get-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue
if (-not $Destino) {
  $Destino = if ($tarefaAtual -and $tarefaAtual.Actions[0].WorkingDirectory) { $tarefaAtual.Actions[0].WorkingDirectory } else { Join-Path $env:ProgramFiles 'LuminorPDV' }
}
$Destino = [IO.Path]::GetFullPath($Destino).TrimEnd('\')

Write-Host 'Luminor PDV - remoção do programa' -ForegroundColor Magenta
Write-Host "   Programa: $Destino"
Write-Host "   Os dados continuam em $Dados (não são apagados)."
$resposta = Read-Host "`nRemover o Luminor PDV deste computador? Digite S para confirmar"
if ($resposta -notmatch '^\s*[sS]') { Write-Host 'Nada foi alterado.'; Fim 0 }

# Stops the PDV: clean stop first (the launcher sees tmp\parar-pdv and lets the PDV close the database), then the task
# and any process left.
$pasta = $Destino.ToLowerInvariant()
function Processos-Pdv {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($pasta) })
}
$pedido = Join-Path $Dados 'tmp\parar-pdv'
if ((Processos-Pdv).Count -gt 0 -and (Test-Path (Split-Path $pedido))) {
  Set-Content -Path $pedido -Value (Get-Date -Format o)
  $limite = (Get-Date).AddSeconds(20)
  while ((Processos-Pdv).Count -gt 0 -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }
}
if ($tarefaAtual) { Stop-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue }
foreach ($p in Processos-Pdv) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item $pedido -Force -ErrorAction SilentlyContinue
if ($tarefaAtual) { Unregister-ScheduledTask -TaskName $Tarefa -Confirm:$false; Write-Host '   Início automático removido.' -ForegroundColor Green }

foreach ($local in [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms')) {
  $atalho = Join-Path $local 'Luminor PDV.lnk'
  if (Test-Path $atalho) { Remove-Item $atalho -Force }
}
Write-Host '   Atalhos removidos.' -ForegroundColor Green

# Only a folder that is really the installed PDV is removed (never a development copy or another folder).
Set-Location $env:SystemRoot
$ehPrograma = (Test-Path (Join-Path $Destino 'src\launcher.js')) -and (Test-Path (Join-Path $Destino 'package.json')) -and -not (Test-Path (Join-Path $Destino '.git'))
if ($ehPrograma -and -not $Destino.StartsWith($Dados, [StringComparison]::OrdinalIgnoreCase)) {
  foreach ($p in $Destino, "$Destino.novo", "$Destino.anterior") { if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
  Write-Host "   Pasta do programa removida ($Destino)." -ForegroundColor Green
} elseif (Test-Path $Destino) {
  Write-Host "   A pasta $Destino não foi removida: ela não parece ser uma instalação do Luminor PDV." -ForegroundColor Yellow
}

Write-Host "`nPronto. Os dados continuam em $Dados." -ForegroundColor Green
Write-Host '   Para instalar de novo, rode o instalador: as vendas, os produtos e os backups serão encontrados.'
Fim 0
