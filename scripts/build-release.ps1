# Build MD Reader release assets for GitHub Release (Windows)
param(
    [string]$Version = "1.1.2"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "==> Building frontend..."
npm run build

Write-Host "==> Building Tauri (NSIS only)..."
$env:CARGO_TARGET_DIR = Join-Path $Root "src-tauri\target"
npm run tauri build -- --bundles nsis

$PortableSrc = Join-Path $Root "src-tauri\target\release\md-reader.exe"
if (-not (Test-Path $PortableSrc)) {
    throw "Portable exe not found: $PortableSrc"
}

$NsisDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
$SetupSrc = Get-ChildItem -Path $NsisDir -Filter "*-setup.exe" | Select-Object -First 1
if (-not $SetupSrc) {
    throw "NSIS setup exe not found in: $NsisDir"
}

$ReleaseDir = Join-Path $Root "release\v$Version"
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null

$PortableExe = Join-Path $ReleaseDir "MD-Reader-$Version-portable.exe"
$PortableZip = Join-Path $ReleaseDir "MD-Reader-$Version-portable.zip"
$SetupExe = Join-Path $ReleaseDir "MD-Reader-$Version-setup.exe"
$ReadmeTxt = Join-Path $ReleaseDir "使用说明.txt"

Copy-Item -Force $PortableSrc $PortableExe
Copy-Item -Force $SetupSrc.FullName $SetupExe

@"
MD Reader v$Version 便携版使用说明
================================

1. 解压后将 MD-Reader-$Version-portable.exe 放到任意文件夹
2. 双击运行，无需安装
3. 可将 .md / .txt 文件拖入窗口，或双击 .md / .txt 文件打开（便携版需手动关联）
4. 阅读进度、窗口大小与最近文件会自动保存

系统要求：Windows 10/11（需 WebView2 运行时，通常已自带）

项目主页：https://github.com/Miasakiii/md-reader
"@ | Set-Content -Path $ReadmeTxt -Encoding UTF8

if (Test-Path $PortableZip) { Remove-Item -Force $PortableZip }
Compress-Archive -Path $PortableExe, $ReadmeTxt -DestinationPath $PortableZip -Force

Write-Host ""
Write-Host "Release assets ready in: $ReleaseDir"
Get-ChildItem $ReleaseDir | Format-Table Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, Length
