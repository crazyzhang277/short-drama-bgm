$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$modelSource = $env:FASTER_WHISPER_MODEL
if (-not $modelSource) { throw 'Set FASTER_WHISPER_MODEL to a local faster-whisper small model directory before building.' }
if (-not (Test-Path -LiteralPath (Join-Path $modelSource 'model.bin'))) { throw "Missing faster-whisper model at $modelSource" }
$modelTarget = Join-Path $root 'runtime\model\small'
New-Item -ItemType Directory -Force -Path $modelTarget | Out-Null
if ((Resolve-Path -LiteralPath $modelSource).Path -ne (Resolve-Path -LiteralPath $modelTarget).Path) {
  foreach ($name in @('config.json', 'model.bin', 'README.md', 'tokenizer.json', 'vocabulary.txt')) {
    $source = Join-Path $modelSource $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing model file: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $modelTarget $name) -Force
  }
}
$modelHash = (Get-FileHash -LiteralPath (Join-Path $modelTarget 'model.bin') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($modelHash -ne '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671') { throw 'Unexpected faster-whisper small model hash; refusing to package it.' }
Set-Content -LiteralPath (Join-Path $modelTarget 'SOURCE.txt') -Encoding UTF8 -Value @(
  'Model: Systran/faster-whisper-small',
  'Repository revision: 536b0662742c02347bc0e980a01041f333bce120',
  'License metadata: MIT (see README.md / model card)',
  'model.bin SHA256: 3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'
)

$ffmpegArchive = Join-Path $root 'build\ffmpeg-n9.0.2-45-g1e65c6cd5d-win64-lgpl-shared-9.0.zip'
$ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-03-12-50/ffmpeg-n9.0.2-45-g1e65c6cd5d-win64-lgpl-shared-9.0.zip'
if (-not (Test-Path -LiteralPath $ffmpegArchive)) { Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegArchive }
$ffmpegHash = (Get-FileHash -LiteralPath $ffmpegArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ffmpegHash -ne 'be035a7f1763fdab8430949bed65eab94dc91cbdea1d03607e4ac5403e73ce76') { throw 'FFmpeg archive hash mismatch; refusing to package an unverified build.' }
$ffmpegExtract = Join-Path $root 'build\ffmpeg-n9.0.2-extract'
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force
$ffmpegBin = Get-ChildItem -LiteralPath $ffmpegExtract -Directory | ForEach-Object { Join-Path $_.FullName 'bin' } | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'ffmpeg.exe') } | Select-Object -First 1
if (-not $ffmpegBin) { throw 'FFmpeg archive does not contain a win64 bin directory.' }
$ffmpegTarget = Join-Path $root 'runtime\ffmpeg'
New-Item -ItemType Directory -Force -Path $ffmpegTarget | Out-Null
Get-ChildItem -LiteralPath $ffmpegBin -File | Where-Object { $_.Name -ne 'ffplay.exe' } | Copy-Item -Destination $ffmpegTarget -Force
$ffmpegRoot = Split-Path -Parent $ffmpegBin
Copy-Item -LiteralPath (Join-Path $ffmpegRoot 'LICENSE.txt') -Destination (Join-Path $ffmpegTarget 'LICENSE.txt') -Force
Set-Content -LiteralPath (Join-Path $ffmpegTarget 'SOURCE.txt') -Encoding UTF8 -Value @(
  'FFmpeg: n9.0.2-45-g1e65c6cd5d-20261103, win64 LGPL shared build',
  'Build release: autobuild-2026-11-03-12-50',
  'Source/build recipe: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-03-12-50',
  'Archive: ffmpeg-n9.0.2-45-g1e65c6cd5d-win64-lgpl-shared-9.0.zip',
  'Archive SHA256: be035a7f1763fdab8430949bed65eab94dc91cbdea1d03607e4ac5403e73ce76'
)

$pyinstaller = Join-Path $root '.venv\Scripts\pyinstaller.exe'
if (-not (Test-Path -LiteralPath $pyinstaller)) { throw 'Missing PyInstaller. Install requirements-build.txt first.' }
$builder = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path -LiteralPath $builder)) { throw 'Missing electron-builder. Run npm install first.' }
& $pyinstaller --noconfirm --clean --onedir --collect-data faster_whisper --name bgm-transcriber --specpath (Join-Path $root 'build\pyinstaller') --distpath (Join-Path $root 'runtime\transcriber') --workpath (Join-Path $root 'build\pyinstaller') (Join-Path $root 'tools\transcribe.py')
if ($LASTEXITCODE -ne 0) { throw "faster-whisper sidecar build failed (exit code $LASTEXITCODE)" }

$sidecar = Join-Path $root 'runtime\transcriber\bgm-transcriber\bgm-transcriber.exe'
if (-not (Test-Path -LiteralPath $sidecar)) { throw 'faster-whisper sidecar EXE was not created' }
$vadModel = Join-Path $root 'runtime\transcriber\bgm-transcriber\_internal\faster_whisper\assets\silero_vad_v6.onnx'
if (-not (Test-Path -LiteralPath $vadModel)) { throw 'bundled faster-whisper VAD model is missing' }
& $sidecar --help
if ($LASTEXITCODE -ne 0) { throw 'sidecar EXE self-check failed' }
foreach ($runtimeFile in @('runtime\ffmpeg\ffmpeg.exe', 'runtime\ffmpeg\ffprobe.exe', 'runtime\ffmpeg\LICENSE.txt', 'runtime\ffmpeg\SOURCE.txt', 'runtime\model\small\model.bin', 'runtime\model\small\config.json', 'runtime\model\small\README.md', 'runtime\model\small\SOURCE.txt')) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $runtimeFile))) { throw "Bundled runtime file is missing: $runtimeFile" }
}
& (Join-Path $root 'runtime\ffmpeg\ffmpeg.exe') -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw 'Bundled FFmpeg failed its startup check.' }
& $builder --win
if ($LASTEXITCODE -ne 0) { throw "desktop installer build failed (exit code $LASTEXITCODE)" }
