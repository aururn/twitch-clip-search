$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExtension = Join-Path $taskRoot 'extension'
$taskOutput = Join-Path $taskRoot 'dist'
$taskManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $taskExtension 'manifest.json') | ConvertFrom-Json
$taskArchiveName = 'twitch-clip-search-' + $taskManifest.version + '.zip'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
Compress-Archive -Path @((Join-Path $taskExtension '*'), (Join-Path $taskRoot 'LICENCE')) -DestinationPath (Join-Path $taskOutput $taskArchiveName) -Force
Write-Output (Join-Path $taskOutput $taskArchiveName)
