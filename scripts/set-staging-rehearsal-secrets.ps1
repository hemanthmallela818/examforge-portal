$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$environmentFile = Join-Path $repositoryRoot '.env.rehearsal.local'

if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw "Missing $environmentFile. Create the guarded rehearsal file before adding secrets."
}

function Read-SecretText {
  param([Parameter(Mandatory)][string]$Prompt)

  $secureValue = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secureValue.Dispose()
  }
}

function Set-EnvironmentEntry {
  param(
    [Parameter(Mandatory)][string[]]$Lines,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "$Name must be a non-empty, single-line value."
  }

  $prefix = "$Name="
  $found = $false
  $updated = foreach ($line in $Lines) {
    if ($line.StartsWith($prefix, [StringComparison]::Ordinal)) {
      $found = $true
      "$prefix$Value"
    }
    else {
      $line
    }
  }

  if (-not $found) {
    $updated += "$prefix$Value"
  }

  return $updated
}

$serviceRoleKey = $null
$adminAccessToken = $null
try {
  $serviceRoleKey = Read-SecretText 'Paste the jee-staging service_role key'
  $adminAccessToken = Read-SecretText 'Paste the staging application administrator AAL2 access token'

  $lines = @(Get-Content -LiteralPath $environmentFile)
  $lines = @(Set-EnvironmentEntry -Lines $lines -Name 'REHEARSAL_SUPABASE_SERVICE_ROLE_KEY' -Value $serviceRoleKey)
  $lines = @(Set-EnvironmentEntry -Lines $lines -Name 'REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN' -Value $adminAccessToken)
  Set-Content -LiteralPath $environmentFile -Value $lines -Encoding utf8

  Write-Output 'Stored both staging rehearsal secrets in the ignored local environment file.'
}
finally {
  Remove-Variable serviceRoleKey, adminAccessToken -ErrorAction SilentlyContinue
}
