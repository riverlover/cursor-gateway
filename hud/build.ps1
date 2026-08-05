# Build tiny single-file Cursor Usage HUD (.NET Framework 4 + system winsqlite3)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
  $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) { throw "csc.exe (.NET 4) not found" }

$out = Join-Path $here "CursorUsageHud.exe"
& $csc /nologo /optimize+ /target:winexe /platform:anycpu `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  /out:$out `
  (Join-Path $here "Program.cs")

if ($LASTEXITCODE -ne 0) { throw "compile failed" }

$size = (Get-Item $out).Length
Write-Host ("Built: {0}  ({1:N0} bytes / {2:N1} KB)" -f $out, $size, ($size / 1KB))
