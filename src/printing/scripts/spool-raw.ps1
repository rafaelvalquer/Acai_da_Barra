# Sends bytes, as they are, to a Windows print queue (datatype RAW) through the spooler. Nothing is run from the data:
# the queue name, the document name and the bytes (base64) arrive in environment variables and are only passed to the
# spooler API. Prints one JSON line: {ok:true,jobId} or {ok:false,code,message,win32}.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LuminorRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] bytes, int count, out int written);
}
"@
function Fail($code, $message, $win32) {
  [pscustomobject]@{ ok = $false; code = $code; message = $message; win32 = $win32 } | ConvertTo-Json -Compress
  exit 3
}
$name = $env:LUMINOR_PRINTER; $doc = $env:LUMINOR_JOB; $b64 = $env:LUMINOR_DATA
if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrEmpty($b64)) { Fail 'bad_input' 'Impressora ou dados ausentes.' 0 }
try { $bytes = [Convert]::FromBase64String($b64) } catch { Fail 'bad_input' 'Dados invalidos.' 0 }
if ($bytes.Length -eq 0 -or $bytes.Length -gt 65536) { Fail 'bad_input' 'Tamanho de dados invalido.' 0 }
$h = [IntPtr]::Zero
if (-not [LuminorRawPrinter]::OpenPrinter($name, [ref]$h, [IntPtr]::Zero)) { Fail 'open_failed' 'Nao foi possivel abrir a fila de impressao.' ([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
try {
  $di = New-Object LuminorRawPrinter+DOCINFO
  $di.pDocName = if ($doc) { $doc } else { 'Luminor PDV' }; $di.pDataType = 'RAW'
  $job = [LuminorRawPrinter]::StartDocPrinter($h, 1, $di)
  if ($job -le 0) { Fail 'start_failed' 'O Windows nao aceitou o documento.' ([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  [void][LuminorRawPrinter]::StartPagePrinter($h)
  $written = 0
  $ok = [LuminorRawPrinter]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [void][LuminorRawPrinter]::EndPagePrinter($h)
  [void][LuminorRawPrinter]::EndDocPrinter($h)
  if (-not $ok -or $written -ne $bytes.Length) { Fail 'write_failed' 'O Windows nao aceitou todos os dados.' $err }
  [pscustomobject]@{ ok = $true; jobId = [int]$job; bytes = [int]$written } | ConvertTo-Json -Compress
} finally { [void][LuminorRawPrinter]::ClosePrinter($h) }
