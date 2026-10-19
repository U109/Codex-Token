param($Mode, $ReportPath, [switch]$Quiet, $InstallRoot)
# 测试替身只写固定结果，用于确认经过完整性校验的脚本确实被执行。
[IO.File]::WriteAllText($ReportPath, '{"passed":true,"stubExecuted":true}')
exit 0
