# Syncs the build-time reference DLLs from the local game install into lib/.
#
# These 17 DLLs are compile-time references only (the csproj's <HintPath>s point
# into $(GameDir)\BepInEx\{core,interop}). They are never shipped — the release
# contains only AC27Approach.dll — but a GitHub Actions runner needs them on disk
# to compile, so they are vendored here and committed. The game's interop DLLs
# change with each playtest patch; run this after the game updates and commit the
# refreshed files.
#
# Usage:  powershell -File sync-refs.ps1 [GameDir]   (default: the standard install path)

param([string]$GameDir = 'D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest')

$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot 'lib\BepInEx'
New-Item -ItemType Directory -Force (Join-Path $lib 'core'), (Join-Path $lib 'interop') | Out-Null

$coreRefs = @('BepInEx.Core', 'BepInEx.Unity.IL2CPP', '0Harmony', 'Il2CppInterop.Common', 'Il2CppInterop.Runtime')
$interopRefs = @('GroundATC.Core', 'R3', 'VContainer', 'Unity.Mathematics', 'AnyPath', 'UnityEngine',
    'UnityEngine.CoreModule', 'UnityEngine.PhysicsModule', 'Il2Cppmscorlib', 'Il2CppSystem',
    'Il2CppSystem.Core', 'Stateless')

$missing = @()
foreach ($n in $coreRefs) {
    $src = Join-Path $GameDir "BepInEx\core\$n.dll"
    if (-not (Test-Path -LiteralPath $src)) { $missing += $src; continue }
    Copy-Item -LiteralPath $src -Destination (Join-Path $lib 'core') -Force
}
foreach ($n in $interopRefs) {
    $src = Join-Path $GameDir "BepInEx\interop\$n.dll"
    if (-not (Test-Path -LiteralPath $src)) { $missing += $src; continue }
    Copy-Item -LiteralPath $src -Destination (Join-Path $lib 'interop') -Force
}

if ($missing.Count -gt 0) {
    Write-Error "Missing reference DLLs under $GameDir :`n  $($missing -join "`n  ")"
}
$total = $coreRefs.Count + $interopRefs.Count
Write-Host "Synced $($total - $missing.Count)/$total reference DLLs into $lib"
