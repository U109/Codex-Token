$ErrorActionPreference = 'Stop'
# 只返回测试目录中的合成宿主信息，不查询本机真实安装。
function Get-AppxPackage {
    param($Name)

    [pscustomobject]@{
        Version           = $env:CT_CDP_HOST_VERSION
        InstallLocation   = $env:CT_CDP_OFFICIAL
        PackageFullName   = 'test'
        PackageFamilyName = 'OpenAI.Codex_test'
    }
}

function Get-AppxPackageManifest {
    param($Package)

    [xml]@'
<Package>
  <Applications>
    <Application Id="App" Executable="app/ChatGPT.exe" />
    <Application Id="Runner" Executable="app/resources/runner.exe" />
  </Applications>
</Package>
'@
}

$options = @{
    Mode        = $env:CT_CDP_MODE
    InstallRoot = $env:CT_CDP_INSTALL
    Bootstrap   = $env:CT_CDP_BOOTSTRAP
    ReportPath  = $env:CT_CDP_REPORT
    Quiet       = $true
}
if ($env:CT_CDP_WITH_INTEGRATION -ne '1') {
    $options.NoIntegration = $true
}
& $env:CT_CDP_MANAGER @options
exit $LASTEXITCODE
