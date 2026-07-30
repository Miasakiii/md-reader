# Build MD Reader release assets for GitHub Release (Windows)
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$PackageJsonPath = Join-Path $Root "package.json"
$Package = Get-Content -Raw -Path $PackageJsonPath | ConvertFrom-Json
$PackageVersion = [string]$Package.version
if ([string]::IsNullOrWhiteSpace($PackageVersion)) {
    throw "Version not found in: $PackageJsonPath"
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $PackageVersion
} elseif ($Version -ne $PackageVersion) {
    throw "Requested version $Version does not match package.json version $PackageVersion"
}

Write-Host "==> Building frontend and Tauri (NSIS only)..."
$env:CARGO_TARGET_DIR = Join-Path $Root "src-tauri\target"
npm run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE"
}

$PortableSrc = Join-Path $Root "src-tauri\target\release\md-reader.exe"
if (-not (Test-Path $PortableSrc)) {
    throw "Portable exe not found: $PortableSrc"
}

$NsisDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
$SetupCandidates = @(
    Get-ChildItem -Path $NsisDir -File -Filter "*_${Version}_*-setup.exe"
)
if ($SetupCandidates.Count -ne 1) {
    $CandidateNames = ($SetupCandidates | ForEach-Object Name) -join ", "
    throw "Expected exactly one NSIS setup for version $Version in ${NsisDir}; found $($SetupCandidates.Count): $CandidateNames"
}
$SetupSrc = $SetupCandidates[0]

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
3. 可通过打开对话框或拖入窗口读取 .md / .markdown / .txt / .tex / .log；.log 始终只读
4. 安装版仅注册 .md / .markdown / .txt 系统文件关联，不接管 .tex / .log；便携版不会自动注册关联
5. 阅读进度、窗口大小与最近文件会自动保存

系统要求：Windows 10/11（需 WebView2 运行时，通常已安装）

项目主页：https://github.com/Miasakiii/md-reader
"@ | Set-Content -Path $ReadmeTxt -Encoding UTF8

if (Test-Path $PortableZip) { Remove-Item -Force $PortableZip }
Compress-Archive -Path $PortableExe, $ReadmeTxt -DestinationPath $PortableZip -Force

Write-Host ""
Write-Host "Release assets ready in: $ReleaseDir"
Get-ChildItem $ReleaseDir | Format-Table Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, Length
