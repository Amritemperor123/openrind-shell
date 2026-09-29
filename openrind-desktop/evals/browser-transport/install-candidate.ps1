$ErrorActionPreference = 'Stop'
$probeRoot = $PSScriptRoot
$electronRoot = Join-Path $probeRoot 'node_modules/electron'
$version = (Get-Content -Raw -LiteralPath (Join-Path $electronRoot 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected pinned stable Electron version' }
$archiveName = "electron-v$version-win32-x64.zip"
$expected = (Get-Content -Raw -LiteralPath (Join-Path $electronRoot 'checksums.json') | ConvertFrom-Json).$archiveName
if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Missing package-published checksum' }
$outputRoot = Join-Path $probeRoot 'dist'
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$archive = Join-Path $outputRoot $archiveName
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expected) {
  & curl.exe --fail --location --silent --show-error --max-time 180 --output $archive "https://github.com/electron/electron/releases/download/v$version/$archiveName"
  if ($LASTEXITCODE -ne 0) { throw 'Electron download failed' }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expected) { throw 'Electron checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $electronRoot 'dist') -Force
Set-Content -LiteralPath (Join-Path $electronRoot 'path.txt') -Value 'electron.exe' -NoNewline
Write-Output "PASS installed Electron $version from checksum-verified official archive"
