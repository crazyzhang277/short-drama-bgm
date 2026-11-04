$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

function Get-Sha256([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

$modelSource = $env:FASTER_WHISPER_MODEL
if (-not $modelSource) {
  $modelParts = Get-ChildItem -LiteralPath (Join-Path $root 'models') -Filter 'faster-whisper-small.zip.part*' -File | Sort-Object Name
  if (-not $modelParts) { throw 'Bundled faster-whisper model archive parts are missing.' }
  $modelArchive = Join-Path $root 'build\faster-whisper-small.zip'
  $archiveStream = [IO.File]::Create($modelArchive)
  try {
    foreach ($part in $modelParts) {
      $partStream = [IO.File]::OpenRead($part.FullName)
      try { $partStream.CopyTo($archiveStream) } finally { $partStream.Dispose() }
    }
  } finally { $archiveStream.Dispose() }
  $modelExtract = Join-Path $root ('build\model-source-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -LiteralPath $modelArchive -DestinationPath $modelExtract
  $modelSource = $modelExtract
}
if (-not (Test-Path -LiteralPath (Join-Path $modelSource 'model.bin'))) { throw 'The faster-whisper small model directory is missing model.bin.' }
$modelTarget = Join-Path $root 'runtime\model\small'
New-Item -ItemType Directory -Force -Path $modelTarget | Out-Null
if ((Resolve-Path -LiteralPath $modelSource).Path -ne (Resolve-Path -LiteralPath $modelTarget).Path) {
  foreach ($name in @('config.json', 'model.bin', 'README.md', 'tokenizer.json', 'vocabulary.txt')) {
    $source = Join-Path $modelSource $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing model file: $name" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $modelTarget $name) -Force
  }
}
$expectedModelHashes = @{
  'config.json' = 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828'
  'model.bin' = '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'
  'README.md' = '329373481008c7c38654aff8ecdcf0163c211557cc7ba8e2ef6f2f84b4f75ec8'
  'tokenizer.json' = 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab'
  'vocabulary.txt' = '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913'
}
foreach ($name in $expectedModelHashes.Keys) {
  $modelFile = Join-Path $modelTarget $name
  if (-not (Test-Path -LiteralPath $modelFile)) { throw "Bundled model file is missing: $name" }
  $actualHash = (Get-Sha256 $modelFile)
  if ($actualHash -ne $expectedModelHashes[$name]) { throw "Unexpected faster-whisper model file hash: $name" }
}
Set-Content -LiteralPath (Join-Path $modelTarget 'SOURCE.txt') -Encoding UTF8 -Value @(
  'Model: Systran/faster-whisper-small',
  'Repository revision: 536b0662742c02347bc0e980a01041f333bce120',
  'Model card declares MIT; original openai/whisper-small model card declares Apache-2.0 (see THIRD_PARTY_NOTICES.md)',
  'model.bin SHA256: 3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'
)

$ffmpegArchive = Join-Path $root 'build\ffmpeg-n9.0.2-45-g1e65c6cd5d-win64-lgpl-shared-9.0.zip'
$ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-03-12-50/ffmpeg-n9.0.2-45-g1e65c6cd5d-win64-lgpl-shared-9.0.zip'
if (-not (Test-Path -LiteralPath $ffmpegArchive)) { Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegArchive }
$ffmpegHash = (Get-Sha256 $ffmpegArchive)
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
