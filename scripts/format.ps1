param([switch]$Check)
# 固定版本的模块保存在忽略目录内，不改变开发者的全局 PowerShell 环境。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $projectRoot '.artifacts/tools/PSScriptAnalyzer/1.25.0/PSScriptAnalyzer.psd1'
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) {
    throw 'Install PSScriptAnalyzer 1.25.0 in .artifacts/tools first; see docs/DEVELOPMENT.md.'
}
Import-Module $modulePath -Force
$ErrorActionPreference = 'Stop'
$settings = Join-Path $projectRoot 'PSScriptAnalyzerSettings.psd1'

function Expand-Statements {
    param(
        [string]$Source
    )

    # PSScriptAnalyzer 不展开哈希表和分号；按解析器位置处理，保留字符串和 for 循环头。
    $tokenRef = [System.Management.Automation.PSReference]::new($null)
    $errorRef = [System.Management.Automation.PSReference]::new($null)
    $ast = [Management.Automation.Language.Parser]::ParseInput($Source, $tokenRef, $errorRef)
    if ($errorRef.Value.Count) {
        throw ($errorRef.Value | Out-String)
    }
    $changes = New-Object 'Collections.Generic.List[object]'
    $loops = $ast.FindAll({
            param($node) $node -is [Management.Automation.Language.ForStatementAst]
        }, $true)
    foreach ($token in $tokenRef.Value) {
        if ($token.Kind -ne 'Semi') {
            continue
        }
        $offset = $token.Extent.StartOffset
        $inHeader = $loops | Where-Object {
            $offset -gt $_.Extent.StartOffset -and $offset -lt $_.Body.Extent.StartOffset
        }
        if (-not $inHeader) {
            $changes.Add(@{
                    Start  = $offset
                    Length = 1
                    Text   = "`n"
                })
        }
    }
    $blocks = $ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.HashtableAst] -or
            $node -is [Management.Automation.Language.ScriptBlockExpressionAst]
        }, $true)
    foreach ($block in $blocks) {
        $openingLength = if ($block -is [Management.Automation.Language.HashtableAst]) {
            2
        }
        else {
            1
        }
        $opening = $block.Extent.StartOffset + $openingLength
        $closing = $block.Extent.EndOffset - 1
        if (-not $Source.Substring($opening, $closing - $opening).Trim()) {
            continue
        }
        if ($Source.Substring($opening) -notmatch '^[\t ]*\r?\n') {
            $changes.Add(@{
                    Start  = $opening
                    Length = 0
                    Text   = "`n"
                })
        }
        if ($Source.Substring(0, $closing) -notmatch '(?:^|\r?\n)[\t ]*$') {
            $changes.Add(@{
                    Start  = $closing
                    Length = 0
                    Text   = "`n"
                })
        }
    }
    # 按偏移量倒序修改，保证尚未处理节点的位置保持有效。
    foreach ($change in ($changes | Sort-Object -Property {
                [int]$_.Start
            } -Descending)) {
        $Source = $Source.Remove($change.Start, $change.Length).Insert($change.Start, $change.Text)
    }
    return $Source
}

$files = @(
    Get-Item -LiteralPath $settings
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1'
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'packaging/windows') -Filter '*.ps1'
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'test/fixtures') -Filter '*.ps1'
)
$changed = @()
$pending = New-Object 'Collections.Generic.List[object]'
foreach ($file in $files) {
    $original = [IO.File]::ReadAllText($file.FullName)
    $expanded = Expand-Statements $original
    $formatted = Invoke-Formatter -ScriptDefinition $expanded -Settings $settings
    $formatted = $formatted.Replace("`r`n", "`n").TrimEnd("`r", "`n") + "`n"
    # 不改动字符串内部的空白；只移除代码行末因格式化残留的空格。
    $tokenRef = [System.Management.Automation.PSReference]::new($null)
    $errorRef = [System.Management.Automation.PSReference]::new($null)
    $null = [Management.Automation.Language.Parser]::ParseInput($formatted, $tokenRef, $errorRef)
    if ($errorRef.Value.Count) {
        throw ($file.Name + ': ' + (($errorRef.Value | ForEach-Object {
                        $_.ErrorId + ' at ' + $_.Extent.StartLineNumber
                    }) -join ', '))
    }
    $strings = @($tokenRef.Value | Where-Object {
            $_.Kind -in @('StringLiteral', 'StringExpandable', 'HereStringLiteral', 'HereStringExpandable')
        })
    $formatted = [regex]::Replace($formatted, '(?m)[\t ]+$', {
            param($match)
            if ($strings | Where-Object {
                    $match.Index -ge $_.Extent.StartOffset -and $match.Index -lt $_.Extent.EndOffset
                }) {
                return $match.Value
            }
            return ''
        })
    # Windows PowerShell 5.1 需要 PS1 的 UTF-8 BOM；配置文件不需要。
    $withBom = $file.Extension -eq '.ps1'
    $encoding = New-Object Text.UTF8Encoding($withBom)
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if ($original -cne $formatted -or $hasBom -ne $withBom) {
        $changed += $file.Name
        if (-not $Check) {
            $pending.Add(@{
                    Path     = $file.FullName
                    Source   = $formatted
                    Encoding = $encoding
                })
        }
    }
}
# 所有解析和计算结束后再写出，执行中的格式化脚本也可以安全地参与本轮整理。
foreach ($change in $pending) {
    [IO.File]::WriteAllText($change.Path, $change.Source, $change.Encoding)
}
if ($Check -and $changed.Count) {
    throw ('Run npm run format to format: ' + ($changed -join ', '))
}
Write-Host ('PowerShell formatting: ' + $files.Count + ' files checked.')
