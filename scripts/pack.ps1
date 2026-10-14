$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExtension = Join-Path $taskRoot 'extension'
$taskOutput = Join-Path $taskRoot 'dist'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
Compress-Archive -Path (Join-Path $taskExtension '*') -DestinationPath (Join-Path $taskOutput 'clip-scout-1.0.0.zip') -Force
Write-Output (Join-Path $taskOutput 'clip-scout-1.0.0.zip')
