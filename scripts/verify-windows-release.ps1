param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$SetupExe,

    [Parameter(Mandatory = $true)]
    [string]$PortableExe
)

$ErrorActionPreference = "Stop"

function Assert-ProductVersion {
    param(
        [string]$Label,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label not found: $Path"
    }

    $ActualVersion = [string](Get-Item -LiteralPath $Path).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($ActualVersion)) {
        throw "$Label has no ProductVersion: $Path"
    }
    if ($ActualVersion -ne $Version) {
        throw "$Label ProductVersion $ActualVersion does not match expected $Version`: $Path"
    }

    Write-Host "Verified $Label ProductVersion: $ActualVersion"
}

Assert-ProductVersion -Label "Setup" -Path $SetupExe
Assert-ProductVersion -Label "Portable executable" -Path $PortableExe
