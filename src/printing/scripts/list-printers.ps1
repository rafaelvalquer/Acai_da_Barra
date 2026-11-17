# Lists the print queues Windows knows for the account this runs under (the scheduled task runs as SYSTEM: a printer
# installed only in one user's profile is not visible here). Reads only; prints JSON on stdout.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $spooler = Get-Service -Name Spooler -ErrorAction SilentlyContinue
  $list = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.Name; default = [bool]$_.Default; driver = [string]$_.DriverName; port = [string]$_.PortName
      status = [int]$_.PrinterStatus; extended = [int]$_.ExtendedPrinterStatus; offline = [bool]$_.WorkOffline; state = [int]$_.PrinterState
      shared = [bool]$_.Shared; network = [bool]$_.Network
    }
  })
  [pscustomobject]@{ ok = $true; spooler = if ($spooler) { [string]$spooler.Status } else { 'Unknown' }; user = [string][Environment]::UserName; printers = $list } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [pscustomobject]@{ ok = $false; code = 'list_failed'; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress
  exit 2
}
