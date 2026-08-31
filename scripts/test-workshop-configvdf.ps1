# Test Workshop upload locally via configVdf — no TOTP, matches CI path
param(
  [string]$Username = $env:STEAM_USERNAME,
  [string]$ConfigVdfBase64 = $env:STEAM_CONFIG_VDF,
  [string]$SteamCmd = 'steamcmd',
  [string]$Vdf = '.github/workflows/upload_mod.vdf',
  [switch]$DryRun
)
if (-not $Username) { Write-Error 'Set STEAM_USERNAME or -Username'; exit 1 }
if (-not $ConfigVdfBase64) { Write-Error 'Set STEAM_CONFIG_VDF or -ConfigVdfBase64 (base64 of config.vdf)'; exit 1 }
if (-not (Get-Command $SteamCmd -ErrorAction SilentlyContinue)) {
  foreach ($p in @("$env:USERPROFILE\steamcmd\steamcmd.exe", 'C:\steamcmd\steamcmd.exe', "$HOME\steamcmd\steamcmd.sh")) {
    if (Test-Path $p) { $SteamCmd = $p; break }
  }
}
Write-Host ('Using steamcmd: ' + $SteamCmd)
Write-Host ('Username: ' + $Username)
$steamHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
$cfgDir = Join-Path $steamHome 'Steam\config'
if (-not (Test-Path $cfgDir)) { $cfgDir = Join-Path (Split-Path $SteamCmd) 'config' }
if (-not (Test-Path $cfgDir)) { $cfgDir = 'config' }
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfgPath = Join-Path $cfgDir 'config.vdf'
try {
  [IO.File]::WriteAllBytes($cfgPath, [Convert]::FromBase64String($ConfigVdfBase64))
  Write-Host ('Wrote config.vdf to ' + $cfgPath + ' (' + [IO.File]::ReadAllBytes($cfgPath).Length + ' bytes)')
} catch {
  Set-Content -Path $cfgPath -Value $ConfigVdfBase64
  Write-Host ('Wrote config.vdf raw to ' + $cfgPath)
}
if ($DryRun) {
  Write-Host ('DryRun: would run: ' + $SteamCmd + ' +login ' + $Username + ' +workshop_build_item ' + $Vdf + ' +quit')
  exit 0
}
if (-not (Test-Path $Vdf)) {
  Write-Host ('VDF not found at ' + $Vdf + ' -- generating minimal one for test')
  $ws = 'steam-workshop-content'
  if (-not (Test-Path $ws)) { New-Item -ItemType Directory -Force -Path $ws | Out-Null; Copy-Item 'release/AC27EditorWorkshop.exe' "$ws/AC27Editor.exe" -ErrorAction SilentlyContinue; Copy-Item 'release/AC27Editor.exe' "$ws/AC27Editor.exe" -ErrorAction SilentlyContinue }
  $content = (Resolve-Path $ws).Path
  $vdfLines = @(
    '"workshopitem"',
    '{',
    '    "appid"           "4004140"',
    '    "publishedfileid" "3793213548"',
    ('    "contentfolder"   "{0}"' -f $content),
    '    "visibility"      "0"',
    '    "changenote"      "Local test via configVdf"',
    '}'
  )
  Set-Content -Path $Vdf -Value ($vdfLines -join [Environment]::NewLine)
  Write-Host ('Generated ' + $Vdf)
}
Write-Host ('Running: ' + $SteamCmd + ' +login ' + $Username + ' +workshop_build_item ' + $Vdf + ' +quit')
& $SteamCmd '+login' $Username '+workshop_build_item' $Vdf '+quit'
exit $LASTEXITCODE
