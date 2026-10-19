using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// 安装器也是已安装的启动入口。先验证内嵌载荷，再交由管理脚本执行具体操作。
internal static class CdpSetup
{
    private const string AppId = "org.codextoken.cdp";
    private const string InstallPrompt =
        "是否安装 Codex Token？已安装时将自动升级。\n\n非官方扩展，安装包未签名，不修改 Codex "
        + "原程序。\n运行时将启用仅限本机的调试端口。";
    private const string InstallCompleteMessage =
        "安装完成。\n\n请完全退出 Codex，再从“Codex Token”快捷方式启动。";

    private static string Q(string value)
    {
        if (value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            throw new Exception("路径包含不支持的字符。");
        return "\"" + value + "\"";
    }

    private static string Explain(string code)
    {
        switch (code)
        {
            case "close-codex-first":
                return "请先完全退出所有官方 Codex 窗口，再打开“Codex "
                    + "Token”快捷方式。助手不会强制关闭你正在使用的 Codex。";
            case "official-codex-not-found":
                return "未找到当前用户注册的官方 Codex。通用安装包不限制 Codex "
                    + "版本；请先确认官方客户端可以正常打开。";
            case "runtime-capability-discovery-unavailable":
                return "已启动原版 Codex，但未识别到 Token "
                    + "增强所需的界面能力。增强已停用，原版可继续使用；无需改版本号或修改官方文件。";
            case "unowned-install-root":
                return "安装目录包含无法确认归属的文件，未自动覆盖。请检查目录后重试。";
            case "install-in-progress":
                return "此目录正在安装或卸载 Codex Token，请等待完成后重试。";
            case "helper-stop-failed":
            case "helper-still-running":
                return "旧版 Token 助手暂时无法停止，原安装文件已保留。请完全退出 Codex 后重试安装。";
            case "install-rollback-failed":
                return "更新未完成，部分恢复操作失败。请保留诊断报告及安装目录旁的备份，以便检查。";
            case "helper-already-running":
                return "Token 助手已在运行，请不要重复启动。需要重新加载时，请先退出 Codex。";
            case "official-cdp-page-not-ready-restart-required":
                return "未能连接官方 Codex 的本机调试页面。请完全退出 Codex "
                    + "后重试；本机版本的正式启动兼容性仍需验收。";
            case "runtime-react-core-contract-mismatch":
                return "宿主 React "
                    + "核心导出与适配不匹配。这是助手适配问题，不是安装权限问题；请使用已修正适配的"
                    + "新版助手。";
            case "runtime-parser-contract-mismatch":
            case "runtime-react-dom-contract-mismatch":
                return "宿主消息解析器或渲染器导出与适配不匹配。请使用对应宿主版本的新版助手。";
            case "runtime-shared-module-load-failed":
                return "未能加载宿主共享模块。请保留诊断报告，以便检查模块路径与页面加载状态。";
            case "runtime-collector-init-failed":
            case "runtime-observer-init-failed":
                return "助手统计采集或界面观察器初始化失败。请保留诊断报告；无需改动官方程序或权限。";
            default:
                return "操作没有完成。错误代码：" + code + "。官方程序与登录配置未被安装器修改。";
        }
    }

    // 内嵌清单是完整性校验的依据，不能信任已安装目录中可被修改的清单。
    private static void VerifyPayload(string root)
    {
        // 执行 PowerShell 前，以内嵌清单校验完整性，不信任安装目录中可修改的清单。
        string expected;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload"))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
        using (var reader = new StreamReader(zip.GetEntry("manifest.json").Open()))
            expected = reader.ReadToEnd();
        if (File.ReadAllText(Path.Combine(root, "manifest.json")) != expected)
            throw new Exception("payload-integrity-check-failed");
        var manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(expected);
        foreach (var entry in (Dictionary<string, object>)manifest["payloadFiles"])
        {
            string file = Path.GetFullPath(Path.Combine(root, entry.Key));
            if (
                !file.StartsWith(
                    root + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase
                )
                || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0
            )
                throw new Exception("payload-integrity-check-failed");
            using (var input = File.OpenRead(file))
            using (var sha = SHA256.Create())
            {
                string hash = BitConverter
                    .ToString(sha.ComputeHash(input))
                    .Replace("-", "")
                    .ToLowerInvariant();
                if (hash != (string)entry.Value)
                    throw new Exception("payload-integrity-check-failed");
            }
        }
    }

    private static void Cleanup(string root)
    {
        string target = Path.GetFullPath(root),
            parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        if (
            !String.Equals(
                Path.GetDirectoryName(target),
                parent,
                StringComparison.OrdinalIgnoreCase
            )
            || !Path.GetFileName(target).StartsWith("CodexTokenCdpSetup-", StringComparison.Ordinal)
        )
            return;
        if ((File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
            return;
        foreach (
            string file in Directory.GetFileSystemEntries(target, "*", SearchOption.AllDirectories)
        )
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                return;
        Directory.Delete(target, true);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = false,
            uninstall = false,
            check = false;
        string target = null,
            report = null,
            extracted = null;
        try
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "/quiet")
                    quiet = true;
                else if (args[i] == "/uninstall")
                    uninstall = true;
                else if (args[i] == "/check")
                    check = true;
                else if (args[i] == "/test-root" && i + 1 < args.Length)
                {
                    target = Path.GetFullPath(args[++i]);
                    check = true;
                }
                else if (args[i] == "/report" && i + 1 < args.Length)
                    report = Path.GetFullPath(args[++i]);
                else
                    throw new Exception("不支持的安装器参数。");
            }
            Application.EnableVisualStyles();
            string self = Assembly.GetExecutingAssembly().Location,
                root = Path.GetDirectoryName(self);
            bool installed = false;
            string owner = Path.Combine(root, "package.owner.json");
            var json = new JavaScriptSerializer();
            if (File.Exists(owner))
            {
                var marker = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(owner));
                installed =
                    marker.ContainsKey("applicationId") && (string)marker["applicationId"] == AppId;
            }
            if (uninstall && !installed)
                throw new Exception("这不是已安装的 CDP 启动器。");
            string mode =
                uninstall ? "Uninstall"
                : check ? "Check"
                : installed ? "Launch"
                : "Install";
            if (installed && target == null)
                target = root;
            if (
                mode == "Install"
                && !quiet
                && MessageBox.Show(
                    InstallPrompt,
                    "Codex Token 安装",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information
                ) != DialogResult.Yes
            )
                return 2;
            if (report == null)
                report = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    @"CodexToken\Logs\setup-cdp-" + Guid.NewGuid().ToString("N") + ".json"
                );
            Directory.CreateDirectory(Path.GetDirectoryName(report));
            string engine;
            if (installed)
                engine = Path.Combine(root, "Manage.ps1");
            else
            {
                extracted = Path.Combine(
                    Path.GetTempPath(),
                    "CodexTokenCdpSetup-" + Guid.NewGuid().ToString("N")
                );
                Directory.CreateDirectory(extracted);
                using (
                    Stream stream = Assembly
                        .GetExecutingAssembly()
                        .GetManifestResourceStream("Payload")
                )
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var entry in zip.Entries)
                    {
                        string file = Path.GetFullPath(Path.Combine(extracted, entry.FullName));
                        if (
                            !file.StartsWith(
                                extracted + Path.DirectorySeparatorChar,
                                StringComparison.OrdinalIgnoreCase
                            )
                            || !names.Add(file)
                            || entry.Length > 2 * 1024 * 1024
                            || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000
                        )
                            throw new Exception("安装载荷路径无效。");
                        Directory.CreateDirectory(Path.GetDirectoryName(file));
                        using (var input = entry.Open())
                        using (var output = File.Create(file))
                            input.CopyTo(output);
                    }
                }
                engine = Path.Combine(extracted, "Manage.ps1");
            }
            VerifyPayload(installed ? root : extracted);
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    @"WindowsPowerShell\v1.0\powershell.exe"
                ),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = !uninstall,
                RedirectStandardError = !uninstall,
            };
            start.EnvironmentVariables.Remove("PSModulePath");
            start.Arguments =
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "
                + Q(engine)
                + " -Quiet -Mode "
                + mode
                + " -ReportPath "
                + Q(report);
            if (target != null)
                start.Arguments += " -InstallRoot " + Q(target);
            if (mode == "Install")
                start.Arguments += " -Bootstrap " + Q(self);
            if (uninstall)
                start.Arguments += " -WaitPid " + Process.GetCurrentProcess().Id;
            using (var process = new Process { StartInfo = start })
            {
                process.Start();
                if (uninstall)
                    return 0; // 所有权检查通过后，清理脚本会等待当前启动器退出。
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                stdout.GetAwaiter().GetResult();
                stderr.GetAwaiter().GetResult();
                if (process.ExitCode != 0)
                {
                    string code = "cdp-install-or-launch-failed";
                    if (File.Exists(report))
                    {
                        var failure = json.Deserialize<Dictionary<string, object>>(
                            File.ReadAllText(report)
                        );
                        if (failure.ContainsKey("errorCode"))
                            code = failure["errorCode"] as string;
                    }
                    if (!quiet)
                        MessageBox.Show(
                            Explain(code) + "\n\n诊断报告：" + report,
                            "Codex Token",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                    return process.ExitCode;
                }
            }
            if (!quiet && mode == "Install")
                MessageBox.Show(
                    InstallCompleteMessage,
                    "Codex Token 安装",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            return 0;
        }
        catch
        {
            if (report != null)
                try
                {
                    File.WriteAllText(
                        report,
                        "{\"passed\":false,\"errorCode\":\"setup-bootstrap-or-"
                            + "integrity-failed\",\"officialFilesWritten\":false}",
                        new UTF8Encoding(false)
                    );
                }
                catch { }
            if (!quiet)
                MessageBox.Show(
                    "安装器未完成操作。未主动修改官方 Codex，请检查诊断报告。",
                    "Codex Token",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            return 1;
        }
        finally
        {
            if (extracted != null)
                try
                {
                    Cleanup(extracted);
                }
                catch { }
        }
    }
}
