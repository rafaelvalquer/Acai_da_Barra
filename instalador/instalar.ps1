<#
  Luminor PDV - instalação e atualização no computador da loja.

  Como usar: dê dois cliques em instalador\instalar.bat (ou clique com o botão direito neste arquivo >
  "Executar com o PowerShell") e aceite a pergunta do Windows. O mesmo instalador serve para instalar,
  atualizar para uma versão nova e reparar uma instalação existente.

  O que ele faz:
    1. Confere o Node.js (22.16 ou superior).
    2. Prepara a nova versão do programa em uma pasta à parte (os arquivos em uso não são tocados).
    3. Para o PDV em execução e, se já existe um banco de dados, faz um backup "antes da atualização".
    4. Troca o programa (a versão anterior fica guardada em <pasta>.anterior).
    5. Protege C:\ProgramData\LuminorPDV: só o Windows (SYSTEM) e os administradores abrem os dados.
    6. Cria a tarefa "Luminor PDV", que inicia o PDV junto com o Windows, mesmo sem ninguém conectado.
    7. Cria o atalho "Luminor PDV" na área de trabalho e no menu Iniciar.

  Os dados (vendas, produtos, backups, configurações) ficam em C:\ProgramData\LuminorPDV e nunca são
  apagados pelo instalador. Um registro de cada instalação fica em C:\ProgramData\LuminorPDV\logs.

  Opções:
    -Destino <pasta>   onde instalar o programa (padrão: C:\Program Files\LuminorPDV)
    -SemAtalho         não cria os atalhos
#>
[CmdletBinding()]
param(
  [string]$Destino = (Join-Path $env:ProgramFiles 'LuminorPDV'),
  [switch]$SemAtalho
)
$ErrorActionPreference = 'Stop'
$Tarefa = 'Luminor PDV'
$Porta = 3187
$Url = "http://127.0.0.1:$Porta"
$NodeMinimo = [version]'22.16.0'
$Fonte = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$Dados = Join-Path $env:ProgramData 'LuminorPDV'

# Asks Windows for administrator rights and runs again in an elevated window.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($PSBoundParameters.ContainsKey('Destino')) { $argumentos += @('-Destino', "`"$Destino`"") }
  if ($SemAtalho) { $argumentos += '-SemAtalho' }
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $argumentos }
  catch { Write-Host 'O instalador precisa de permissão de administrador do Windows.' -ForegroundColor Red; Read-Host 'Pressione Enter para fechar' | Out-Null }
  exit
}

$transcricao = $false
function Passo([string]$texto) { Write-Host "`n== $texto" -ForegroundColor Cyan }
function Ok([string]$texto) { Write-Host "   $texto" -ForegroundColor Green }
function Aviso([string]$texto) { Write-Host "   $texto" -ForegroundColor Yellow }
function Fim([int]$codigo) {
  if ($transcricao) { try { Stop-Transcript | Out-Null } catch {} }
  Read-Host "`nPressione Enter para fechar" | Out-Null
  exit $codigo
}
function Falha([string]$texto) {
  Write-Host "`nNão foi possível concluir: $texto" -ForegroundColor Red
  Fim 1
}
# Node processes started from the installed program (the launcher and the PDV itself).
function Processos-Pdv {
  $pasta = $Destino.ToLowerInvariant()
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($pasta) })
}
function Dono-Porta {
  $c = Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $c.OwningProcess } else { $null }
}
function Parar-Pdv {
  # Clean stop first: the launcher sees tmp\parar-pdv, lets the PDV close the database and exits. Ending the task (and
  # any process left) is the fallback.
  $pedido = Join-Path $Dados 'tmp\parar-pdv'
  if ((Processos-Pdv).Count -gt 0) {
    New-Item -ItemType Directory -Force -Path (Split-Path $pedido) | Out-Null
    Set-Content -Path $pedido -Value (Get-Date -Format o)
    $limite = (Get-Date).AddSeconds(20)
    while ((Processos-Pdv).Count -gt 0 -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }
  }
  if (Get-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue
  }
  foreach ($p in Processos-Pdv) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $pedido -Force -ErrorAction SilentlyContinue
}
function Copiar([string]$de, [string]$para, [string[]]$excluir = @()) {
  $argumentos = @($de, $para, '/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($excluir.Count) { $argumentos += '/XD'; $argumentos += $excluir }
  & robocopy @argumentos | Out-Null
  if ($LASTEXITCODE -ge 8) { Falha "falha ao copiar $de para $para (robocopy $LASTEXITCODE)." }
}
function Versao-De([string]$pasta) {
  try { (Get-Content (Join-Path $pasta 'package.json') -Raw | ConvertFrom-Json).version } catch { $null }
}
# Local addresses never go through a proxy; Node's "experimental feature" notices would only confuse the screen.
[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy
$env:NODE_NO_WARNINGS = '1'

New-Item -ItemType Directory -Force -Path (Join-Path $Dados 'logs') | Out-Null
try {
  Start-Transcript -Path (Join-Path $Dados ("logs\instalacao-{0:yyyy-MM-dd-HHmmss}.log" -f (Get-Date))) | Out-Null
  $transcricao = $true
} catch {}

Write-Host 'Luminor PDV - instalação' -ForegroundColor Magenta

# --- 1. Package, destination and Node.js ---------------------------------------------------------------------------
Passo 'Conferindo o pacote e o Node.js'
if (-not (Test-Path (Join-Path $Fonte 'src\main.js')) -or -not (Test-Path (Join-Path $Fonte 'package.json'))) {
  Falha "a pasta $Fonte não parece ser um pacote do Luminor PDV (falta src\main.js)."
}
$versaoNova = Versao-De $Fonte
$Destino = [IO.Path]::GetFullPath($Destino).TrimEnd('\')
if ($Destino.Length -le 3) { Falha 'escolha uma pasta para o programa, não a raiz de um disco.' }
if ($Destino.StartsWith($Dados, [StringComparison]::OrdinalIgnoreCase)) { Falha "o programa não pode ficar dentro da pasta de dados ($Dados)." }
if (Test-Path (Join-Path $Destino '.git')) { Falha "$Destino é uma cópia de desenvolvimento (tem .git). Escolha outra pasta com -Destino." }
$reparar = $Destino -ieq $Fonte
if (-not $reparar -and $Destino.StartsWith("$Fonte\", [StringComparison]::OrdinalIgnoreCase)) { Falha 'a pasta do programa não pode ficar dentro do pacote.' }
$instalado = Test-Path (Join-Path $Destino 'src\main.js')
$versaoAnterior = if ($instalado) { Versao-De $Destino } else { $null }

$comandoNode = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $comandoNode) { Falha 'o Node.js não foi encontrado. Instale o Node.js 22 LTS (https://nodejs.org, instalador para Windows) e rode este instalador de novo.' }
$node = $comandoNode.Source
$versaoNode = [version](((& $node --version) | Out-String).Trim().TrimStart('v'))
if ($versaoNode -lt $NodeMinimo) { Falha "o Node.js $versaoNode é antigo. Instale o Node.js 22 LTS ($NodeMinimo ou superior) e rode o instalador de novo." }
if ($node -like "$env:SystemDrive\Users\*") { Aviso "O Node.js está na pasta de um usuário ($node). Prefira o instalador oficial, que instala para todos os usuários." }
$npm = Join-Path (Split-Path $node) 'npm.cmd'
Ok "Node.js $versaoNode ($node)"
if ($reparar) { Ok "Reparando a instalação em $Destino (versão $versaoNova)" }
elseif ($instalado) { Ok "Atualizando de $versaoAnterior para $versaoNova em $Destino" }
else { Ok "Instalando a versão $versaoNova em $Destino" }

# --- 2. New version in a separate folder ---------------------------------------------------------------------------
$Novo = "$Destino.novo"
$Anterior = "$Destino.anterior"
if (-not $reparar) {
  Passo 'Preparando os arquivos da nova versão'
  if (Test-Path $Novo) { Remove-Item $Novo -Recurse -Force }
  $foraDoPrograma = @('.git', '.claude', '.netlify', 'data', 'dist', 'demo', 'tests', 'apresentacao', 'node_modules') | ForEach-Object { Join-Path $Fonte $_ }
  Copiar $Fonte $Novo $foraDoPrograma
  $lockAtual = Join-Path $Destino 'package-lock.json'
  $lockNovo = Join-Path $Novo 'package-lock.json'
  $mesmasDependencias = (Test-Path (Join-Path $Destino 'node_modules')) -and (Test-Path $lockAtual) -and (Test-Path $lockNovo) -and
    ((Get-FileHash $lockAtual).Hash -eq (Get-FileHash $lockNovo).Hash)
  if ($mesmasDependencias) {
    Copiar (Join-Path $Destino 'node_modules') (Join-Path $Novo 'node_modules')
    Ok 'Componentes reaproveitados da versão instalada.'
  } else {
    Write-Host '   Baixando os componentes (precisa de internet)...'
    Push-Location $Novo
    try { & $npm ci --omit=dev --no-audit --no-fund | Out-Host; $npmOk = $LASTEXITCODE -eq 0 } catch { $npmOk = $false } finally { Pop-Location }
    if (-not $npmOk) {
      if (Test-Path (Join-Path $Fonte 'node_modules')) {
        Aviso 'Sem internet: usando os componentes que vieram no pacote.'
        Copiar (Join-Path $Fonte 'node_modules') (Join-Path $Novo 'node_modules')
      } else { Falha 'não foi possível baixar os componentes. Confira a internet e rode o instalador de novo.' }
    }
  }
  # Loads every module of the new version without starting it.
  Push-Location $Novo
  try { & $node -e "require('./src/main.js');require('./src/launcher.js')"; $carregou = $LASTEXITCODE -eq 0 } finally { Pop-Location }
  if (-not $carregou) { Falha 'a nova versão não carregou (veja a mensagem acima). Nada foi alterado.' }
  Ok 'Nova versão pronta.'
}

# --- 3. Stop the PDV and back up ---------------------------------------------------------------------------------
Passo 'Parando o PDV'
Parar-Pdv
while ($dono = Dono-Porta) {
  $processo = Get-CimInstance Win32_Process -Filter "ProcessId=$dono" -ErrorAction SilentlyContinue
  Aviso "A porta $Porta está em uso por $($processo.Name) (processo $dono)."
  Aviso 'Feche o Luminor PDV que estiver aberto (por exemplo, a janela preta do iniciar-windows.bat).'
  $resposta = Read-Host '   Depois de fechar, pressione Enter. Para cancelar a instalação, digite C'
  if ($resposta -match '^\s*[cC]') { Falha 'instalação cancelada. Nada foi alterado.' }
}
Ok 'PDV parado.'

function Retomar-Anterior {
  if ($instalado -and (Get-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue)) { Start-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue }
}
$banco = Join-Path $Dados 'data\luminor-pdv.sqlite'
if (-not $reparar -and (Test-Path $banco)) {
  Passo 'Backup antes da atualização'
  # The program that knows this database makes the backup: the installed one, or the new one on a first install.
  $cli = if ($instalado -and (Test-Path (Join-Path $Destino 'src\cli\backup.js'))) { Join-Path $Destino 'src\cli\backup.js' } else { Join-Path $Novo 'src\cli\backup.js' }
  & $node $cli --tipo atualizacao | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Retomar-Anterior
    Falha 'o backup antes da atualização não foi feito (veja a mensagem acima). Nada foi alterado e a versão atual continua em uso.'
  }
}

# --- 4. Program swap ---------------------------------------------------------------------------------------------
if (-not $reparar) {
  Passo 'Instalando o programa'
  if (Test-Path $Anterior) { Remove-Item $Anterior -Recurse -Force }
  if (Test-Path $Destino) {
    try { Rename-Item $Destino (Split-Path $Anterior -Leaf) }
    catch { Retomar-Anterior; Falha "a pasta $Destino está em uso (feche janelas e programas abertos nela) e tente de novo. Nada foi alterado." }
  }
  try { Rename-Item $Novo (Split-Path $Destino -Leaf) }
  catch {
    if (Test-Path $Anterior) { Rename-Item $Anterior (Split-Path $Destino -Leaf) }
    Retomar-Anterior
    Falha "não foi possível colocar a nova versão em $Destino. A versão anterior foi mantida."
  }
  if (Test-Path $Anterior) { Ok "Versão anterior guardada em $Anterior" }
  Ok "Programa instalado em $Destino"
}

# --- 5. Data folder: only SYSTEM and the administrators -----------------------------------------------------------
Passo "Protegendo a pasta de dados ($Dados)"
foreach ($sub in 'data', 'backups', 'logs', 'config') { New-Item -ItemType Directory -Force -Path (Join-Path $Dados $sub) | Out-Null }
# SIDs instead of names: S-1-5-18 is SYSTEM and S-1-5-32-544 the Administrators group in any Windows language.
& icacls $Dados /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
& icacls $Dados /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Falha "não foi possível ajustar as permissões de $Dados (icacls $LASTEXITCODE)." }
& icacls (Join-Path $Dados '*') /reset /T /C /Q | Out-Null
Ok 'Somente o Windows (SYSTEM) e os administradores acessam os arquivos. Os funcionários usam o PDV pelo navegador.'

# Database of the version that ran from the package folder (before the permanent data folder): copied once at the
# first start, the original file is only read.
$legado = Join-Path $Fonte 'data\luminor-pdv.sqlite'
if (-not (Test-Path $banco) -and (Test-Path $legado)) {
  $arquivoConfig = Join-Path $Dados 'config\luminor-pdv.env'
  Push-Location $Destino
  try { & $node -e "const c=require('./src/config');c.prepareHome(c.loadConfig())" } finally { Pop-Location }
  $texto = if (Test-Path $arquivoConfig) { Get-Content $arquivoConfig -Raw } else { '' }
  if ($texto -notmatch '(?m)^\s*PDV_LEGACY_SQLITE\s*=') {
    $linhas = "`r`n# Banco da versão anterior, copiado uma única vez na primeira inicialização (o original não é alterado).`r`nPDV_LEGACY_SQLITE=$legado`r`n"
    [IO.File]::AppendAllText($arquivoConfig, $linhas, (New-Object Text.UTF8Encoding $false))
  }
  Ok "As vendas e os produtos de $legado serão copiados na primeira inicialização."
}

# --- 6. Windows task: starts with the computer, as SYSTEM ---------------------------------------------------------
Passo 'Configurando o início automático'
$sistema = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18').Translate([Security.Principal.NTAccount]).Value
$acao = New-ScheduledTaskAction -Execute $node -Argument "`"$Destino\src\launcher.js`"" -WorkingDirectory $Destino
$gatilho = New-ScheduledTaskTrigger -AtStartup
$conta = New-ScheduledTaskPrincipal -UserId $sistema -LogonType ServiceAccount -RunLevel Highest
# Priority 4 is the normal priority of a program (tasks get a lower one by default, which slows the till down).
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4
Register-ScheduledTask -TaskName $Tarefa -Action $acao -Trigger $gatilho -Principal $conta -Settings $ajustes -Force `
  -Description "Luminor PDV: servidor local do caixa ($Url). Criado pelo instalador; para remover use instalador\desinstalar.bat." | Out-Null
Ok "Tarefa ""$Tarefa"" criada: o PDV inicia junto com o Windows."

# --- 7. Shortcuts --------------------------------------------------------------------------------------------------
if (-not $SemAtalho) {
  Passo 'Criando os atalhos'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($pasta in [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms')) {
    $atalho = $shell.CreateShortcut((Join-Path $pasta 'Luminor PDV.lnk'))
    $atalho.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $atalho.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Destino\instalador\abrir-pdv.ps1`""
    $atalho.WorkingDirectory = $Destino
    $atalho.WindowStyle = 7
    $atalho.Description = 'Abrir o caixa do Luminor PDV'
    $atalho.IconLocation = "$Destino\public\favicon.ico,0"
    $atalho.Save()
  }
  Ok 'Atalho "Luminor PDV" na área de trabalho e no menu Iniciar.'
}

# --- 8. Start and check ------------------------------------------------------------------------------------------
Passo 'Iniciando o PDV'
Start-ScheduledTask -TaskName $Tarefa
$saude = $null
$limite = (Get-Date).AddSeconds(90)
while (-not $saude -and (Get-Date) -lt $limite) {
  Start-Sleep -Seconds 1
  try { $saude = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 3 } catch {}
}
if (-not $saude) {
  Aviso "O PDV não respondeu em $Url."
  Aviso "Veja os registros em $Dados\logs (inicializador.log e pdv-<data>.log)."
  if (Test-Path $Anterior) { Aviso "A versão anterior continua guardada em $Anterior; os backups estão em $Dados\backups." }
  Fim 1
}
if ($saude.version -ne $versaoNova) { Aviso "Em execução: versão $($saude.version) (esperada $versaoNova)." }
Ok "Luminor PDV $($saude.version) em execução em $Url"
if ($saude.database -eq 'indisponivel') { Aviso 'O banco na nuvem não respondeu: entre em Configurações > Administração do sistema > Banco de dados.' }

Write-Host "`nPronto!" -ForegroundColor Green
Write-Host "   Abra o caixa pelo atalho ""Luminor PDV"" na área de trabalho."
Write-Host "   Dados e backups: $Dados"
if (-not $instalado) {
  Write-Host '   Primeiro acesso à administração: Configurações > Administração do sistema, usuário admin e senha admin.'
  Write-Host '   O sistema pede uma senha nova na hora; guarde também o código de recuperação que ele mostrar.'
}
Fim 0
