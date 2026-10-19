param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
# 使用最终载荷在工作区内验证安装、覆盖升级与卸载；不修改真实快捷方式或注册表。
# 需要本机已安装官方 Codex。不会启动新的官方实例或发送模型请求。
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath
$build = Get-Content -LiteralPath (Join-Path $ProjectRoot 'dist\build-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$parent = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot '.artifacts')).ProviderPath
$target = [IO.Path]::GetFullPath((Join-Path $parent ('CodexToken-smoke-' + [Guid]::NewGuid().ToString('N'))))
if ([IO.Path]::GetDirectoryName($target) -ne $parent) {
    throw 'unsafe-smoke-target'
}
$installReport = Join-Path $parent 'cdp-real-install.json'
$upgradeReport = Join-Path $parent 'cdp-real-upgrade.json'
$launchReport = Join-Path $parent 'cdp-existing-instance.json'
$removeReport = Join-Path $parent 'cdp-real-uninstall.json'
$manager = Join-Path $build.payloadRoot 'Manage.ps1'
$summaryPath = Join-Path $ProjectRoot '.artifacts\install-smoke-report.json'
[IO.File]::WriteAllText($summaryPath, '{"passed":false,"status":"running-or-failed"}', (New-Object Text.UTF8Encoding($false)))
$existingHelpers = @(Get-Process -Name CodexToken.Runtime -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

# 管理脚本通过进程退出码返回结果，因此必须在子进程中运行。
function Run-Manager {
    param(
        [string[]]$Arguments
    )

    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Remove('PSModulePath')
    $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $manager + '" ' + ($Arguments -join ' ')
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $null = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    return $process.ExitCode
}
$before = @{}
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object {
    [version]$_.Version
} -Descending | Select-Object -First 1
if (-not $package) {
    throw 'official-codex-not-found'
}
foreach ($relative in @('app\ChatGPT.exe', 'app\resources\app.asar')) {
    $before[$relative] = (Get-FileHash -LiteralPath (Join-Path $package.InstallLocation $relative) -Algorithm SHA256).Hash
}
$guardChecked = $false
$guardCode = $null
try {
    $code = Run-Manager @(
        '-Mode', 'Install', '-NoIntegration', '-Quiet',
        '-InstallRoot', ('"' + $target + '"'),
        '-Bootstrap', ('"' + $build.installer + '"'),
        '-ReportPath', ('"' + $installReport + '"')
    )
    if ($code -ne 0) {
        throw 'real-host-install-preflight-failed'
    }
    # 用同一份已验证的最终载荷覆盖已有安装，保持原安装存在，且不修改真实快捷方式或注册项。
    $extra = Join-Path $target 'upgrade-keep.fixture'
    [IO.File]::WriteAllText($extra, 'KEEP_EXTRA_FILE')
    $oldOwner = Get-Content -LiteralPath (Join-Path $target 'package.owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldOwner.version = '0.4.5-smoke-previous'
    [IO.File]::WriteAllText((Join-Path $target 'package.owner.json'), ($oldOwner | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    [IO.File]::AppendAllText((Join-Path $target 'runtime.js'), '/* 升级应替换这段旧内容。 */')
    $code = Run-Manager @(
        '-Mode', 'Install', '-NoIntegration', '-Quiet',
        '-InstallRoot', ('"' + $target + '"'),
        '-Bootstrap', ('"' + $build.installer + '"'),
        '-ReportPath', ('"' + $upgradeReport + '"')
    )
    if ($code -ne 0) {
        throw 'owned-smoke-upgrade-failed'
    }
    $upgrade = Get-Content -LiteralPath $upgradeReport -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
        -not $upgrade.upgraded -or
        $upgrade.previousVersion -ne '0.4.5-smoke-previous' -or
        $upgrade.installedVersion -ne $build.releaseVersion -or
        $upgrade.backupRetained
    ) {
        throw 'owned-smoke-upgrade-result-mismatch'
    }
    if ([IO.File]::ReadAllText($extra) -ne 'KEEP_EXTRA_FILE') {
        throw 'owned-smoke-extra-file-lost'
    }
    $payloadNames = @(
        'runtime.js', 'Manage.ps1', 'CodexToken.Runtime.exe', 'CodexToken.ico',
        'README.txt', 'LICENSE.txt', 'manifest.json'
    )
    foreach ($leaf in $payloadNames) {
        $installedHash = (Get-FileHash -LiteralPath (Join-Path $target $leaf) -Algorithm SHA256).Hash
        $payloadHash = (Get-FileHash -LiteralPath (Join-Path $build.payloadRoot $leaf) -Algorithm SHA256).Hash
        if ($installedHash -ne $payloadHash) {
            throw 'owned-smoke-upgrade-file-mismatch'
        }
    }
    $installedBootstrapHash = (Get-FileHash -LiteralPath (Join-Path $target 'CodexToken.exe') -Algorithm SHA256).Hash
    $builtBootstrapHash = (Get-FileHash -LiteralPath $build.installer -Algorithm SHA256).Hash
    if ($installedBootstrapHash -ne $builtBootstrapHash) {
        throw 'owned-smoke-upgrade-bootstrap-mismatch'
    }
    $plan = Get-Content -LiteralPath (Join-Path $target 'launch.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $running = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -eq $plan.executable
        })
    # 烟测不启动新的官方实例；仅在确认原程序已运行时调用已安装启动器，验证重复启动保护。
    if ($running.Count -gt 0) {
        $launchOptions = @{
            FilePath     = (Join-Path $target 'CodexToken.exe')
            WindowStyle  = 'Hidden'
            PassThru     = $true
            Wait         = $true
            ArgumentList = @('/quiet', '/report', ('"' + $launchReport + '"'))
        }
        $process = Start-Process @launchOptions
        $result = Get-Content -LiteralPath $launchReport -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($process.ExitCode -eq 0 -or $result.errorCode -notin @('close-codex-first', 'helper-already-running')) {
            throw 'existing-instance-guard-not-confirmed'
        }
        $guardCode = $result.errorCode
        $guardChecked = $true
    }
}
finally {
    if (Test-Path -LiteralPath $target) {
        $manager = Join-Path $target 'Manage.ps1'
        $code = Run-Manager @(
            '-Mode', 'Uninstall', '-Quiet',
            '-InstallRoot', ('"' + $target + '"'),
            '-ReportPath', ('"' + $removeReport + '"')
        )
        if ($code -ne 0 -or (Test-Path -LiteralPath $target)) {
            throw 'owned-smoke-cleanup-failed'
        }
    }
}
foreach ($helperId in $existingHelpers) {
    if (-not (Get-Process -Id $helperId -ErrorAction SilentlyContinue)) {
        throw 'unrelated-helper-stopped-by-smoke'
    }
}
foreach ($relative in $before.Keys) {
    if ((Get-FileHash -LiteralPath (Join-Path $package.InstallLocation $relative) -Algorithm SHA256).Hash -ne $before[$relative]) {
        throw 'official-file-changed'
    }
}
$report = @{
    checkedAt                                  = [DateTimeOffset]::UtcNow.ToString('o')

    installerSha256                            = (Get-FileHash -LiteralPath $build.installer -Algorithm SHA256).Hash.ToLowerInvariant()

    verifierSha256                             = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()

    passed                                     = $true
    realCurrentHostPreflightAndOwnFilesInstall = $true

    embeddedInstalledLauncherExercised         = $guardChecked
    existingOfficialInstanceSafelyRefused      = $guardChecked

    existingInstanceGuardCode                  = $guardCode
    unrelatedHelpersPreserved                  = $true

    assistantInstalledInWorkspaceOnly          = $true
    shellIntegrationChanged                    = $false

    ownedUninstallPassed                       = $true
    officialFilesUnchanged                     = $true
    officialProcessStopped                     = $false

    ownedAutomaticUpgradePassed                = $true
    extraFilesPreservedOnUpgrade               = $true
    installedFilesMatchFinalPayload            = $true

    officialActivationAttempted                = $false
    fullOfficialHostAcceptance                 = $false
    realModelRequests                          = 0
}
[IO.File]::WriteAllText($summaryPath, ($report | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$report | ConvertTo-Json
