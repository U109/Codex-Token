# 安装事务由本脚本统一管理：准备和校验 -> 停止同目录助手 -> 替换 -> 更新入口。
# 替换失败恢复旧文件及入口；所有递归操作都要求确认工具所有权和路径边界。
param(
    [ValidateSet('Install', 'Launch', 'Uninstall', 'Check')][string]$Mode = 'Check',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexToken'),
    [string]$Bootstrap,
    [string]$ReportPath,
    [int]$WaitPid = 0,
    [switch]$Quiet,
    [switch]$NoIntegration,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$appId = 'org.codextoken.cdp'
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexTokenCdp'
$stage = $null
$installMutex = $null
$ownsInstallMutex = $false

function Full {
    param(
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'empty-path'
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Child {
    param(
        [string]$Root,
        [string]$Name
    )

    $rootPath = Full $Root
    $value = Full (Join-Path $rootPath $Name)
    if (-not $value.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'unsafe-payload-path'
    }
    return $value
}

function No-Reparse {
    param(
        [string]$Path
    )

    $item = Get-Item -LiteralPath (Full $Path) -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'reparse-path-not-supported'
        }
        $item = $item.Parent
    }
}

function Json-Write {
    param(
        [string]$Path,
        $Value
    )

    [IO.File]::WriteAllText((Full $Path), ($Value | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
}

function Owner {
    param(
        [string]$Root
    )

    No-Reparse $Root
    try {
        $owner = Get-Content -LiteralPath (Child $Root 'package.owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw 'unowned-install-root'
    }
    if ($owner.applicationId -ne $appId -or $owner.mode -ne 'cdp-runtime') {
        throw 'unowned-install-root'
    }
    return $owner
}

function Assert-OwnedTree {
    param(
        [string]$Root,
        [string]$Parent
    )

    $target = Full $Root
    if ([IO.Path]::GetDirectoryName($target) -ne (Full $Parent)) {
        throw 'unsafe-cleanup-target'
    }
    $null = Owner $target
    # 递归删除前拒绝嵌套链接，路径不交给其他 Shell 处理，
    # 也不删除 Codex 档案、聊天数据或官方文件。
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($target)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'reparse-cleanup-target'
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
            }
        }
    }
}

function Remove-Owned {
    param(
        [string]$Root,
        [string]$Parent
    )

    $target = Full $Root
    Assert-OwnedTree $target $Parent
    Remove-Item -LiteralPath $target -Recurse -Force
}

function Move-Owned {
    param(
        [string]$Root,
        [string]$Destination,
        [string]$Parent
    )

    $source = Full $Root
    $target = Full $Destination
    Assert-OwnedTree $source $Parent
    if ([IO.Path]::GetDirectoryName($target) -ne (Full $Parent)) {
        throw 'unsafe-install-move'
    }
    No-Reparse $Parent
    # Directory.Move 在目标已存在时拒绝移动，不会把源目录嵌入目标；
    # 两个已校验的绝对路径必须位于同一父目录。
    [IO.Directory]::Move($source, $target)
}

function Stop-Helper {
    param(
        [string]$Root,
        [string]$StopExecutable
    )

    $stopOptions = @{
        FilePath     = $StopExecutable
        ArgumentList = @('--stop', '--root', ('"' + $Root + '"'))
        WindowStyle  = 'Hidden'
        PassThru     = $true
        Wait         = $true
    }
    $stopper = Start-Process @stopOptions
    if ($stopper.ExitCode -ne 0) {
        throw 'helper-stop-failed'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $active = @(Get-Process -Name CodexToken.Runtime -ErrorAction SilentlyContinue | Where-Object {
                $_.Path -eq (Child $Root 'CodexToken.Runtime.exe')
            })
        if ($active.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'helper-still-running'
}

function Copy-ExtraFiles {
    param(
        [string]$Root,
        [string]$Destination,
        $Catalog
    )

    $ownedNames = @(
        'CodexToken.exe'
        'CodexToken.Runtime.exe'
        'Manage.ps1'
        'runtime.js'
        'README.txt'
        'manifest.json'
        'package.owner.json'
        'launch.json'
    )
    $ownedNames += @($Catalog.payloadFiles.PSObject.Properties.Name)
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        if ($item.Name -notin $ownedNames) {
            Copy-Item -LiteralPath $item.FullName -Destination (Child $Destination $item.Name) -Recurse -Force
        }
    }
}

function Payload {
    param(
        [string]$Root
    )

    No-Reparse $Root
    $catalog = Get-Content -LiteralPath (Child $Root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
        $catalog.applicationId -ne $appId -or
        $catalog.mode -ne 'cdp-runtime' -or
        $catalog.schemaVersion -ne 6 -or
        $catalog.compatibilityMode -ne 'auto'
    ) {
        throw 'unsupported-manifest'
    }
    foreach ($entry in $catalog.payloadFiles.PSObject.Properties) {
        $file = Child $Root $entry.Name
        No-Reparse $file
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
            throw 'payload-checksum-mismatch'
        }
    }
    return $catalog
}

function Host-Plan {
    $candidates = @()
    # 版本和宿主指纹仅用于诊断，不作为启用条件；使用已注册的官方包，不读取其他位置的副本档案。
    foreach ($package in @(Get-AppxPackage -Name OpenAI.Codex | Sort-Object {
                try {
                    [version]$_.Version
                }
                catch {
                    [version]'0.0'
                }
            } -Descending)) {
        $exe = Child $package.InstallLocation 'app\ChatGPT.exe'
        $archive = Child $package.InstallLocation 'app\resources\app.asar'
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
            continue
        }
        $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
        $applications = @($manifest.Package.Applications.Application | Where-Object {
                $_.Executable.Replace('/', '\') -eq 'app\ChatGPT.exe'
            })
        if ($applications.Count -ne 1 -or $applications[0].Id -notmatch '^[A-Za-z0-9._-]{1,80}$') {
            throw 'unsupported-package-activation'
        }
        $candidates += @{
            executable        = $exe
            archive           = $archive

            aumid             = ($package.PackageFamilyName + '!' + $applications[0].Id)

            packageVersion    = [string]$package.Version

            compatibilityMode = 'auto'
        }
    }
    if ($candidates.Count -eq 0) {
        throw 'official-codex-not-found'
    }
    return $candidates[0]
}

function Get-IntegrationState {
    param(
        [string]$Root,
        [string[]]$Directories = @(
            [Environment]::GetFolderPath('Desktop')
            [Environment]::GetFolderPath('Programs')
        ),
        [string]$UninstallKey = $registryPath
    )

    $shell = New-Object -ComObject WScript.Shell
    $links = @()
    foreach ($directory in $Directories) {
        $file = Join-Path $directory 'Codex Token.lnk'
        $exists = Test-Path -LiteralPath $file
        if ($exists) {
            No-Reparse $file
            if ($shell.CreateShortcut($file).TargetPath -ne (Child $Root 'CodexToken.exe')) {
                throw 'shortcut-already-owned-by-another-install'
            }
        }
        $links += @{
            path       = $file
            existed    = $exists
            bytes      = $(if ($exists) {
                    [IO.File]::ReadAllBytes($file)
                }
                else {
                    $null
                })
            attributes = $(if ($exists) {
                    [IO.File]::GetAttributes($file)
                }
                else {
                    $null
                })
        }
    }
    $registryExists = Test-Path -LiteralPath $UninstallKey
    $values = @()
    if ($registryExists) {
        if ((Get-ItemProperty -LiteralPath $UninstallKey).InstallLocation -ne $Root) {
            throw 'uninstall-entry-already-owned-by-another-install'
        }
        $key = Get-Item -LiteralPath $UninstallKey
        foreach ($name in $key.GetValueNames()) {
            $values += @{
                name  = $name
                value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                kind  = $key.GetValueKind($name)
            }
        }
    }
    return @{
        links           = $links
        registryPath    = $UninstallKey
        registryExisted = $registryExists
        values          = $values
    }
}

function Restore-Integration {
    param(
        [string]$Root,
        $State
    )

    Remove-Integration $Root @($State.links | ForEach-Object {
            Split-Path -Parent $_.path
        }) $State.registryPath
    foreach ($link in $State.links) {
        if ($link.existed) {
            if (Test-Path -LiteralPath $link.path) {
                throw 'shortcut-already-owned-by-another-install'
            }
            [IO.File]::WriteAllBytes($link.path, [byte[]]$link.bytes)
            [IO.File]::SetAttributes($link.path, $link.attributes)
        }
    }
    if ($State.registryExisted) {
        if (Test-Path -LiteralPath $State.registryPath) {
            throw 'uninstall-entry-already-owned-by-another-install'
        }
        $key = New-Item -Path $State.registryPath -Force
        foreach ($value in $State.values) {
            $key.SetValue($value.name, $value.value, $value.kind)
        }
    }
}

function Set-Integration {
    param(
        [string]$Root,
        [string]$Version,
        [string[]]$Directories = @(
            [Environment]::GetFolderPath('Desktop')
            [Environment]::GetFolderPath('Programs')
        ),
        [string]$UninstallKey = $registryPath
    )

    $shell = New-Object -ComObject WScript.Shell
    foreach ($directory in $Directories) {
        $file = Join-Path $directory 'Codex Token.lnk'
        if ((Test-Path -LiteralPath $file) -and $shell.CreateShortcut($file).TargetPath -ne (Child $Root 'CodexToken.exe')) {
            throw 'shortcut-already-owned-by-another-install'
        }
        $shortcut = $shell.CreateShortcut($file)
        $shortcut.TargetPath = Child $Root 'CodexToken.exe'
        $shortcut.WorkingDirectory = $Root
        $shortcut.Description = '启动官方 Codex，并加载非官方 Token 运行时增强'
        $shortcut.IconLocation = (Child $Root 'CodexToken.ico') + ',0'
        $shortcut.Save()
    }
    if ((Test-Path -LiteralPath $UninstallKey) -and (Get-ItemProperty -LiteralPath $UninstallKey).InstallLocation -ne $Root) {
        throw 'uninstall-entry-already-owned-by-another-install'
    }
    New-Item -Path $UninstallKey -Force | Out-Null
    foreach ($entry in @{
            DisplayName     = 'Codex Token（CDP 运行时增强）'
            DisplayVersion  = $Version

            Publisher       = 'Codex Token（非官方）'
            InstallLocation = $Root

            UninstallString = ('"' + (Child $Root 'CodexToken.exe') + '" /uninstall')

            DisplayIcon     = (Child $Root 'CodexToken.ico') + ',0'

            NoModify        = 1
            NoRepair        = 1
        }.GetEnumerator()) {
        Set-ItemProperty -LiteralPath $UninstallKey -Name $entry.Key -Value $entry.Value
    }
}

function Remove-Integration {
    param(
        [string]$Root,
        [string[]]$Directories = @(
            [Environment]::GetFolderPath('Desktop')
            [Environment]::GetFolderPath('Programs')
        ),
        [string]$UninstallKey = $registryPath
    )

    $shell = New-Object -ComObject WScript.Shell
    foreach ($directory in $Directories) {
        $file = Join-Path $directory 'Codex Token.lnk'
        if ((Test-Path -LiteralPath $file) -and $shell.CreateShortcut($file).TargetPath -eq (Child $Root 'CodexToken.exe')) {
            Remove-Item -LiteralPath $file -Force
        }
    }
    if ((Test-Path -LiteralPath $UninstallKey) -and (Get-ItemProperty -LiteralPath $UninstallKey).InstallLocation -eq $Root) {
        Remove-Item -LiteralPath $UninstallKey -Force
    }
}

try {
    $InstallRoot = Full $InstallRoot
    if ($Mode -in @('Install', 'Uninstall')) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $rootBytes = [Text.Encoding]::UTF8.GetBytes($InstallRoot.ToUpperInvariant())
            $rootHash = [BitConverter]::ToString($sha.ComputeHash($rootBytes)).Replace('-', '')
        }
        finally {
            $sha.Dispose()
        }
        $lockName = 'Local\CodexTokenCdp-manage-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value + '-' + $rootHash
        $installMutex = New-Object Threading.Mutex($false, $lockName)
        try {
            $ownsInstallMutex = $installMutex.WaitOne(0)
        }
        catch [Threading.AbandonedMutexException] {
            $ownsInstallMutex = $true
        }
        if (-not $ownsInstallMutex) {
            throw 'install-in-progress'
        }
    }
    if (-not $ReportPath) {
        $logs = Join-Path $env:LOCALAPPDATA 'CodexToken\Logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $ReportPath = Join-Path $logs ('cdp-' + [Guid]::NewGuid().ToString('N') + '.json')
    }
    if ($Mode -eq 'Uninstall') {
        $owner = Owner $InstallRoot
        # Runtime 使用 GUI 子系统，Windows PowerShell 通过 & 调用时不会等待，
        # 因此 $LASTEXITCODE 可能为空或仍是上次的值。
        Stop-Helper $InstallRoot (Child $InstallRoot 'CodexToken.Runtime.exe')
        if ($WaitPid -gt 0) {
            Wait-Process -Id $WaitPid -ErrorAction SilentlyContinue
        }
        if ($owner.integrated) {
            Remove-Integration $InstallRoot
        }
        Remove-Owned $InstallRoot ([IO.Path]::GetDirectoryName($InstallRoot))
        $result = @{
            passed                     = $true
            mode                       = 'Uninstall'
            officialFilesWritten       = $false
            profileDeleted             = $false
            closeCodexToCloseDebugPort = $true
        }
    }
    else {
        $payloadRoot = if ($Mode -eq 'Launch') {
            $InstallRoot
        }
        else {
            $PSScriptRoot
        }
        $catalog = Payload $payloadRoot
        $plan = Host-Plan
        if ($DryRun -or $Mode -eq 'Check') {
            $result = @{
                passed                         = $true
                mode                           = 'Check'
                integrationMode                = 'cdp-runtime'
                packageVersion                 = $plan.packageVersion

                compatibilityMode              = 'auto'
                versionGateEnabled             = $false
                officialFingerprintGateEnabled = $false

                officialFilesWritten           = $false
                clientCopied                   = $false
                profileReused                  = $true
                runtimeLaunched                = $false
                featureVerified                = $false
            }
        }
        elseif ($Mode -eq 'Install') {
            $parent = [IO.Path]::GetDirectoryName($InstallRoot)
            $previousOwner = $null
            if (Test-Path -LiteralPath $InstallRoot) {
                $previousOwner = Owner $InstallRoot
                Assert-OwnedTree $InstallRoot $parent
            }
            if (-not $Bootstrap -or -not (Test-Path -LiteralPath $Bootstrap -PathType Leaf)) {
                throw 'missing-installer-bootstrap'
            }
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            No-Reparse $parent
            $stage = Child $parent ('.CodexTokenCdp-stage-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $stage | Out-Null
            Json-Write (Child $stage 'package.owner.json') @{
                applicationId = $appId
                mode          = 'cdp-runtime'
                version       = $catalog.releaseVersion
                integrated    = ((-not $NoIntegration) -or $previousOwner.integrated)
            }
            foreach ($entry in $catalog.payloadFiles.PSObject.Properties) {
                Copy-Item -LiteralPath (Child $payloadRoot $entry.Name) -Destination (Child $stage $entry.Name)
            }
            Copy-Item -LiteralPath (Child $payloadRoot 'manifest.json') -Destination (Child $stage 'manifest.json')
            Copy-Item -LiteralPath (Full $Bootstrap) -Destination (Child $stage 'CodexToken.exe')
            Json-Write (Child $stage 'launch.json') $plan
            if ($previousOwner) {
                Copy-ExtraFiles $InstallRoot $stage $catalog
            }
            $null = Payload $stage
            $integrationState = if (-not $NoIntegration) {
                Get-IntegrationState $InstallRoot
            }
            else {
                $null
            }
            $backup = $null
            $newPlaced = $false
            $integrationChanged = $false
            try {
                if ($previousOwner) {
                    # 使用已验证的新助手发送限定安装目录的停止信号，不能调用旧版的全局停止信号。
                    Stop-Helper $InstallRoot (Child $payloadRoot 'CodexToken.Runtime.exe')
                    $backupPath = Child $parent ('.CodexTokenCdp-backup-' + [Guid]::NewGuid().ToString('N'))
                    Move-Owned $InstallRoot $backupPath $parent
                    $backup = $backupPath
                }
                Move-Owned $stage $InstallRoot $parent
                $stage = $null
                $newPlaced = $true
                if (-not $NoIntegration) {
                    $integrationChanged = $true
                    Set-Integration $InstallRoot $catalog.releaseVersion
                }
            }
            catch {
                $installError = $_
                try {
                    if ($newPlaced) {
                        Remove-Owned $InstallRoot $parent
                    }
                    if ($backup) {
                        Move-Owned $backup $InstallRoot $parent
                        $backup = $null
                    }
                    if ($integrationChanged) {
                        Restore-Integration $InstallRoot $integrationState
                    }
                }
                catch {
                    throw 'install-rollback-failed'
                }
                throw $installError
            }
            $backupRetained = $false
            if ($backup) {
                # 提交后的清理失败不能破坏可用的新安装，也不能从已被部分删除的备份回滚。
                try {
                    Remove-Owned $backup $parent
                    $backup = $null
                }
                catch {
                    $backupRetained = $true
                }
            }
            $result = @{
                passed                                = $true
                mode                                  = 'Install'
                integrationMode                       = 'cdp-runtime'
                installRoot                           = $InstallRoot

                upgraded                              = ($null -ne $previousOwner)
                previousVersion                       = $previousOwner.version
                installedVersion                      = $catalog.releaseVersion
                backupRetained                        = $backupRetained

                packageVersion                        = $plan.packageVersion
                compatibilityMode                     = 'auto'
                versionGateEnabled                    = $false
                officialFingerprintGateEnabled        = $false

                officialFilesWritten                  = $false
                clientCopied                          = $false
                runtimeLaunched                       = $false
                featureVerified                       = $false
                requiresOriginalCodexExitBeforeLaunch = $true
            }
        }
        else {
            $null = Owner $InstallRoot
            Json-Write (Child $InstallRoot 'launch.json') $plan
            $runtimeReportName = 'runtime-' + [Guid]::NewGuid().ToString('N') + '.json'
            $runtimeReport = Join-Path ([IO.Path]::GetDirectoryName((Full $ReportPath))) $runtimeReportName
            $runtime = Child $InstallRoot 'CodexToken.Runtime.exe'
            $runtimeOptions = @{
                FilePath     = $runtime
                WindowStyle  = 'Hidden'
                PassThru     = $true
                ArgumentList = @(
                    '--root'
                    ('"' + $InstallRoot + '"')
                    '--report'
                    ('"' + $runtimeReport + '"')
                )
            }
            $process = Start-Process @runtimeOptions
            $deadline = [DateTime]::UtcNow.AddSeconds(70)
            $state = $null
            do {
                if (Test-Path -LiteralPath $runtimeReport) {
                    try {
                        $state = Get-Content -LiteralPath $runtimeReport -Raw -Encoding UTF8 | ConvertFrom-Json
                    }
                    catch {
                    }
                    if ($state.injectionReady -or $state.errorCode) {
                        break
                    }
                }
                if ($process.HasExited) {
                    break
                }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $state.injectionReady) {
                $code = if ($state.errorCode) {
                    [string]$state.errorCode
                }
                else {
                    'runtime-start-timeout-see-log'
                }
                throw $code
            }
            $result = @{
                passed               = $true
                mode                 = 'Launch'
                runtimeConnected     = $true
                injectionReady       = $true

                runtimeReport        = $runtimeReport
                officialFilesWritten = $false
                clientCopied         = $false
                featureVerified      = $false
            }
        }
    }
    Json-Write $ReportPath $result
    $result | ConvertTo-Json -Compress
    exit 0
}
catch {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        try {
            Remove-Owned $stage ([IO.Path]::GetDirectoryName($stage))
        }
        catch {
        }
    }
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^[a-z][a-z0-9-]{1,90}$') {
        $code = 'cdp-install-or-launch-failed'
    }
    $failure = @{
        passed               = $false
        errorCode            = $code
        mode                 = $Mode
        officialFilesWritten = $false
        clientCopied         = $false
    }
    if ($ReportPath) {
        try {
            Json-Write $ReportPath $failure
        }
        catch {
        }
    }
    $failure | ConvertTo-Json -Compress
    exit 1
}
finally {
    if ($ownsInstallMutex) {
        $installMutex.ReleaseMutex()
    }
    if ($installMutex) {
        $installMutex.Dispose()
    }
}
