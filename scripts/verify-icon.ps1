param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
# 直接从最终 EXE 提取十档图标，与已提交的 ICO 像素及透明度逐一比较。
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath
$reportPath = Join-Path $ProjectRoot '.artifacts/icon-report.json'
[IO.File]::WriteAllText($reportPath, '{"passed":false,"status":"running-or-failed"}')
$build = Get-Content -LiteralPath (Join-Path $ProjectRoot 'dist/build-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -Path (Join-Path $PSScriptRoot 'windows/IconResourceProbe.cs')
$iconFile = Join-Path $build.payloadRoot 'CodexToken.ico'
$sourceIcon = Join-Path $ProjectRoot 'assets/codex-token.ico'
if ((Get-FileHash -LiteralPath $iconFile).Hash -ne (Get-FileHash -LiteralPath $sourceIcon).Hash) {
    throw 'packaged-icon-mismatch'
}
$sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
$frames = @()
foreach ($size in $sizes) {
    $reference = [IconResourceProbe]::Extract($iconFile, $size)
    try {
        if ($reference.Width -ne $size -or $reference.Height -ne $size) {
            throw 'native-icon-size-mismatch'
        }
        $center = $reference.GetPixel(($size / 2), ($size / 2))
        if ($reference.GetPixel(0, 0).A -ne 0 -or $center.A -eq 0 -or $center.G -le $center.R) {
            $reference.Save((Join-Path $ProjectRoot '.artifacts/icon-extraction-diagnostic.png'), [Drawing.Imaging.ImageFormat]::Png)
            throw (
                'native-icon-content-or-alpha-mismatch: size=' + $size +
                '; corner=' + $reference.GetPixel(0, 0) + '; center=' + $center
            )
        }
        $referenceHash = [IconResourceProbe]::PixelHash($reference)
        foreach ($program in @($build.installer, (Join-Path $build.payloadRoot 'CodexToken.Runtime.exe'))) {
            $extracted = [IconResourceProbe]::Extract($program, $size)
            try {
                if ([IconResourceProbe]::PixelHash($extracted) -ne $referenceHash) {
                    throw 'embedded-icon-does-not-match-source'
                }
            }
            finally {
                $extracted.Dispose()
            }
        }
        if ($size -eq 48) {
            $reference.Save((Join-Path $ProjectRoot '.artifacts/app-icon-extracted.png'), [Drawing.Imaging.ImageFormat]::Png)
        }
        $frames += @{
            size             = $size
            pixelSha256      = $referenceHash
            installerMatches = $true
            runtimeMatches   = $true
        }
    }
    finally {
        $reference.Dispose()
    }
}
$runtimeHash = (Get-FileHash -LiteralPath (Join-Path $build.payloadRoot 'CodexToken.Runtime.exe')).Hash
$report = @{
    passed                               = $true
    checkedAt                            = [DateTimeOffset]::UtcNow.ToString('o')
    sizes                                = $sizes
    frames                               = $frames

    nativeWindowsIconExtractionExercised = $true

    iconSha256                           = (Get-FileHash -LiteralPath $iconFile).Hash.ToLowerInvariant()

    installerSha256                      = (Get-FileHash -LiteralPath $build.installer).Hash.ToLowerInvariant()

    runtimeSha256                        = $runtimeHash.ToLowerInvariant()

    officialFilesChanged                 = $false
    executablesLaunched                  = $false
}
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
'Application icon: all 10 sizes match the source in both final Windows executables.'
