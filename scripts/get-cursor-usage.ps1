<#
.SYNOPSIS
  Read local Cursor login JWT and fetch current-period usage from the official API.

.DESCRIPTION
  1. Loads cursorAuth/accessToken from %APPDATA%\Cursor\User\globalStorage\state.vscdb
  2. POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
  3. Prints a short summary and the raw JSON body

.PARAMETER Raw
  Only print the raw JSON response (no summary).

.PARAMETER DbPath
  Override path to state.vscdb.

.EXAMPLE
  .\scripts\get-cursor-usage.ps1

.EXAMPLE
  .\scripts\get-cursor-usage.ps1 -Raw
#>
[CmdletBinding()]
param(
  [switch]$Raw,
  [string]$DbPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $DbPath) {
  $DbPath = Join-Path $env:APPDATA "Cursor\User\globalStorage\state.vscdb"
}

if (-not (Test-Path -LiteralPath $DbPath)) {
  throw "Cursor state DB not found: $DbPath`nSign in to Cursor IDE first."
}

function Get-CursorDbValue {
  param(
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$Key
  )

  $sqlite3 = Get-Command sqlite3 -ErrorAction SilentlyContinue
  if ($sqlite3) {
    $value = & $sqlite3.Source $Database "SELECT value FROM ItemTable WHERE key = '$Key';" 2>$null
    if ($LASTEXITCODE -ne 0) {
      throw "sqlite3 failed reading key '$Key' from $Database"
    }
    return ($value | Out-String).Trim()
  }

  $python = Get-Command python, python3, py -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($python) {
    $py = @'
import sqlite3, sys
db, key = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
row = con.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
con.close()
sys.stdout.write(row[0] if row and row[0] is not None else "")
'@
    $tmp = [System.IO.Path]::GetTempFileName() + ".py"
    try {
      Set-Content -LiteralPath $tmp -Value $py -Encoding UTF8
      $value = & $python.Source $tmp $Database $Key 2>&1
      if ($LASTEXITCODE -ne 0) {
        throw "python sqlite read failed: $value"
      }
      return ($value | Out-String).Trim()
    } finally {
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
  }

  throw "Need sqlite3 or python on PATH to read $Database"
}

function ConvertFrom-JwtPayload {
  param([Parameter(Mandatory)][string]$Jwt)

  $parts = $Jwt.Split(".")
  if ($parts.Count -lt 2) { throw "Invalid JWT format" }

  $payload = $parts[1].Replace("-", "+").Replace("_", "/")
  switch ($payload.Length % 4) {
    2 { $payload += "==" }
    3 { $payload += "=" }
  }

  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
  return $json | ConvertFrom-Json
}

function ConvertFrom-UnixMs {
  param([string]$Ms)
  if ([string]::IsNullOrWhiteSpace($Ms)) { return $null }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Ms).ToLocalTime().DateTime
}

$jwt = Get-CursorDbValue -Database $DbPath -Key "cursorAuth/accessToken"
if ([string]::IsNullOrWhiteSpace($jwt)) {
  throw "cursorAuth/accessToken is empty. Sign in to Cursor IDE first."
}

$email = Get-CursorDbValue -Database $DbPath -Key "cursorAuth/cachedEmail"
$membership = Get-CursorDbValue -Database $DbPath -Key "cursorAuth/stripeMembershipType"
$claims = ConvertFrom-JwtPayload -Jwt $jwt

$uri = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
$headers = @{
  "Content-Type"  = "application/json"
  "Authorization" = "Bearer $jwt"
}

try {
  $response = Invoke-WebRequest -Uri $uri -Method POST -Headers $headers -Body "{}" -TimeoutSec 30 -UseBasicParsing
} catch {
  throw "Usage API request failed: $($_.Exception.Message)"
}

$bodyText = $response.Content
$usage = $bodyText | ConvertFrom-Json

if (-not $Raw) {
  $cycleStart = ConvertFrom-UnixMs $usage.billingCycleStart
  $cycleEnd = ConvertFrom-UnixMs $usage.billingCycleEnd
  $exp = if ($claims.exp) {
    [DateTimeOffset]::FromUnixTimeSeconds([int64]$claims.exp).ToLocalTime().DateTime
  } else { $null }

  Write-Host "Cursor Usage"
  Write-Host ("=" * 48)
  Write-Host ("Email (cached) : {0}" -f $(if ($email) { $email } else { "(unknown)" }))
  Write-Host ("Membership     : {0}" -f $(if ($membership) { $membership } else { "(unknown)" }))
  Write-Host ("JWT sub        : {0}" -f $claims.sub)
  if ($exp) { Write-Host ("JWT expires    : {0:yyyy-MM-dd HH:mm:ss}" -f $exp) }
  if ($cycleStart -and $cycleEnd) {
    Write-Host ("Billing cycle  : {0:yyyy-MM-dd HH:mm} -> {1:yyyy-MM-dd HH:mm}" -f $cycleStart, $cycleEnd)
  }
  Write-Host ("Display        : {0}" -f $usage.displayMessage)
  Write-Host ("Auto message   : {0}" -f $usage.autoModelSelectedDisplayMessage)
  Write-Host ("API message    : {0}" -f $usage.namedModelSelectedDisplayMessage)
  if ($usage.planUsage) {
    Write-Host ("totalPercent   : {0}%" -f $usage.planUsage.totalPercentUsed)
    Write-Host ("autoPercent    : {0}%" -f $usage.planUsage.autoPercentUsed)
    Write-Host ("apiPercent     : {0}%" -f $usage.planUsage.apiPercentUsed)
    if ($null -ne $usage.planUsage.totalSpend) {
      Write-Host ("totalSpend     : {0}" -f $usage.planUsage.totalSpend)
    }
    if ($null -ne $usage.planUsage.bonusSpend) {
      Write-Host ("bonusSpend     : {0}" -f $usage.planUsage.bonusSpend)
    }
  }
  Write-Host ("HTTP           : {0}" -f $response.StatusCode)
  Write-Host ""
  Write-Host "Raw JSON"
  Write-Host ("-" * 48)
}

try {
  $bodyText | ConvertFrom-Json | ConvertTo-Json -Depth 20
} catch {
  $bodyText
}
