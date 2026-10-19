using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// 只模拟目录限定的停止信号，不启动宿主，也不连接调试端口。
class FakeHelper
{
    static string Signal(string root)
    {
        using (var sha = SHA256.Create())
            return @"Local\CtInstallerFixture-"
                + BitConverter
                    .ToString(
                        sha.ComputeHash(
                            Encoding.UTF8.GetBytes(
                                Path.GetFullPath(root)
                                    .TrimEnd(Path.DirectorySeparatorChar)
                                    .ToUpperInvariant()
                            )
                        )
                    )
                    .Replace("-", "");
    }

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--hold")
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            using (var e = new EventWaitHandle(false, EventResetMode.ManualReset, Signal(root)))
            {
                File.WriteAllText(Path.Combine(root, "helper-ready.fixture"), "ready");
                return e.WaitOne(45000) ? 0 : 9;
            }
        }
        if (args.Length != 3 || args[0] != "--stop" || args[1] != "--root")
            return 8;
        if (File.Exists(Path.Combine(args[2], "fail-stop.fixture")))
            return 7;
        try
        {
            using (var e = EventWaitHandle.OpenExisting(Signal(args[2])))
                e.Set();
        }
        catch (WaitHandleCannotBeOpenedException) { }
        return 0;
    }
}
