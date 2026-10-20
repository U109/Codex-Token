using System;
using System.IO;
using System.Threading;

internal static class UsageTransportTest
{
    private static int Main(string[] args)
    {
        try
        {
            using (var reader = new UsageLogReader(args[1]))
            using (var stop = new EventWaitHandle(false, EventResetMode.ManualReset))
                RuntimeProgram
                    .RunPage(
                        new Uri(args[0]),
                        "({state:'ready'})",
                        Path.Combine(args[1], "report.json"),
                        stop,
                        false,
                        reader
                    )
                    .GetAwaiter()
                    .GetResult();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
