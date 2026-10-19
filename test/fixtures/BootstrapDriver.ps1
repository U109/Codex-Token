$ErrorActionPreference = 'Stop'
# 通过反射调用安装器入口，验证执行管理脚本前的内嵌载荷完整性检查。
$root = $env:CT_CDP_BOOT_TEST
$assembly = Join-Path $root 'Setup.dll'
if (-not (Test-Path -LiteralPath $assembly)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $root 'payload.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $root 'payload'), $zip)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $compilerArguments = @(
        '/nologo'
        '/codepage:65001'
        '/target:library'
        '/r:System.Windows.Forms.dll'
        '/r:System.IO.Compression.dll'
        '/r:System.IO.Compression.FileSystem.dll'
        '/r:System.Web.Extensions.dll'
        ('/resource:' + $zip + ',Payload')
        ('/out:' + $assembly)
        $env:CT_CDP_SETUP_SOURCE
    )
    & $compiler @compilerArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'compile-failed'
    }
}
$method = ([Reflection.Assembly]::LoadFrom($assembly)).GetType('CdpSetup').GetMethod('Main', [Reflection.BindingFlags]'NonPublic,Static')
$a = [string[]]@('/quiet', '/check', '/report', (Join-Path $root 'check.json'))
$code = $method.Invoke($null, [object[]](, $a))
Write-Output ('result=' + $code)
exit ([int]$code)
