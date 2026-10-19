using System;
using System.IO;
using System.Reflection;
using System.Threading;

// 验证停止操作只影响指定安装目录，不触发其他目录或旧版全局信号。
class ScopedStopTest
{
    static int Main(string[] args)
    {
        string a = Path.Combine(args[0], "Install A"),
            b = Path.Combine(args[0], "Install B");
        if (
            RuntimeProgram.StopName(a)
            != RuntimeProgram.StopName(a.ToUpperInvariant() + Path.DirectorySeparatorChar)
        )
            return 1;
        if (RuntimeProgram.StopName(a) == RuntimeProgram.StopName(b))
            return 2;
        using (
            var first = new EventWaitHandle(
                false,
                EventResetMode.ManualReset,
                RuntimeProgram.StopName(a)
            )
        )
        using (
            var second = new EventWaitHandle(
                false,
                EventResetMode.ManualReset,
                RuntimeProgram.StopName(b)
            )
        )
        using (
            var legacy = new EventWaitHandle(
                false,
                EventResetMode.ManualReset,
                RuntimeProgram.SessionName("stop")
            )
        )
        {
            var main = typeof(RuntimeProgram).GetMethod(
                "Main",
                BindingFlags.NonPublic | BindingFlags.Static
            );
            int code = (int)
                main.Invoke(null, new object[] { new string[] { "--stop", "--root", a } });
            if (code != 0 || !first.WaitOne(0) || second.WaitOne(0) || legacy.WaitOne(0))
                return 3;
            first.Reset();
            code = (int)main.Invoke(null, new object[] { new string[] { "--stop" } });
            if (code == 0 || first.WaitOne(0) || second.WaitOne(0) || legacy.WaitOne(0))
                return 4;
        }
        return 0;
    }
}
