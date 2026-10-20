using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// 助手以普通用户权限运行，不写宿主文件，不读取凭据或配置，不使用代理，
// 不发起模型请求，不调试浏览器主进程，也不复制 Codex 可执行文件。
internal static class RuntimeProgram
{
    internal const string AppId = "org.codextoken.cdp";
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = 2 * 1024 * 1024,
        RecursionLimit = 100,
    };

    internal static string SessionName(string kind)
    {
        return @"Local\CodexTokenCdp-" + kind + "-" + WindowsIdentity.GetCurrent().User.Value;
    }

    // 停止信号绑定当前用户和安装目录，升级一个实例时不会停止其他目录的助手。
    internal static string StopName(string root)
    {
        string normalized = Path.GetFullPath(root)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .ToUpperInvariant();
        using (var sha = SHA256.Create())
        {
            return SessionName("stop")
                + "-"
                + BitConverter
                    .ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(normalized)))
                    .Replace("-", "");
        }
    }

    internal static Dictionary<string, object> Map(object value)
    {
        return value as Dictionary<string, object>;
    }

    internal static string Text(Dictionary<string, object> value, string key)
    {
        object item;
        return value != null && value.TryGetValue(key, out item) ? item as string : null;
    }

    private static Exception ContractFailure(Dictionary<string, object> health)
    {
        string code = Text(health, "errorCode");
        switch (code)
        {
            case "runtime-parser-contract-mismatch":
            case "runtime-react-core-contract-mismatch":
            case "runtime-react-dom-contract-mismatch":
            case "runtime-shared-module-load-failed":
            case "runtime-collector-init-failed":
            case "runtime-observer-init-failed":
                return new Exception(code);
            case "runtime-capability-discovery-unavailable":
                return new Exception(code);
            default:
                return new Exception("runtime-host-contract-mismatch");
        }
    }

    // 仅将固定状态与计数写入日志，避免保存来自宿主的异常正文或其他对象。
    private static object SafeHealth(Dictionary<string, object> value)
    {
        string state = Text(value, "state");
        if (state != "ready" && state != "loading" && state != "disposed" && state != "unsupported")
            state = "unavailable";
        var safe = new Dictionary<string, object>
        {
            { "state", state },
            { "mode", "app-server-reported" },
        };
        foreach (string key in new[] { "mounted", "notifications" })
        {
            object raw;
            long count;
            if (
                value != null
                && value.TryGetValue(key, out raw)
                && Int64.TryParse(Convert.ToString(raw), out count)
                && count >= 0
                && count <= Int32.MaxValue
            )
                safe[key] = count;
        }
        object ready;
        safe["parserReady"] =
            value != null
            && value.TryGetValue("parserReady", out ready)
            && ready is bool
            && (bool)ready;
        return safe;
    }

    internal static string Hash(string file)
    {
        using (var stream = File.OpenRead(file))
        using (var sha = SHA256.Create())
        {
            return BitConverter
                .ToString(sha.ComputeHash(stream))
                .Replace("-", "")
                .ToLowerInvariant();
        }
    }

    internal static void WriteReport(string file, object value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        string temp = file + ".new";
        File.WriteAllText(temp, Json.Serialize(value), new UTF8Encoding(false));
        File.Copy(temp, file, true);
        File.Delete(temp);
    }

    private static string Child(string root, string relative)
    {
        string value = Path.GetFullPath(Path.Combine(root, relative));
        if (
            !value.StartsWith(
                root + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase
            )
        )
            throw new Exception("unsafe-payload-path");
        return value;
    }

    // 先核对助手载荷与所有权，再读取启动计划；官方文件仅检查位置与存在性。
    internal static Dictionary<string, object> ReadPlan(string root)
    {
        var owner = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(Child(root, "package.owner.json"))
        );
        if (Text(owner, "applicationId") != AppId)
            throw new Exception("unowned-install-root");
        var catalog = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(Child(root, "manifest.json"))
        );
        if (
            Text(catalog, "applicationId") != AppId
            || Text(catalog, "mode") != "cdp-runtime"
            || !catalog.ContainsKey("schemaVersion")
            || !Object.Equals(catalog["schemaVersion"], 6)
            || Text(catalog, "compatibilityMode") != "auto"
        )
            throw new Exception("unsupported-manifest");
        foreach (var entry in Map(catalog["payloadFiles"]))
        {
            if (Hash(Child(root, entry.Key)) != (string)entry.Value)
                throw new Exception("payload-checksum-mismatch");
        }
        var plan = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(Child(root, "launch.json"))
        );
        string exe = Text(plan, "executable"),
            archive = Text(plan, "archive"),
            aumid = Text(plan, "aumid");
        if (
            String.IsNullOrEmpty(exe)
            || String.IsNullOrEmpty(archive)
            || String.IsNullOrEmpty(aumid)
            || !aumid.StartsWith("OpenAI.Codex_", StringComparison.Ordinal)
            || aumid.IndexOf('!') < 0
            || !String.Equals(
                Path.GetFileName(exe),
                "ChatGPT.exe",
                StringComparison.OrdinalIgnoreCase
            )
            || !String.Equals(
                Path.GetFullPath(archive),
                Path.Combine(Path.GetDirectoryName(exe), @"resources\app.asar"),
                StringComparison.OrdinalIgnoreCase
            )
        )
            throw new Exception("invalid-official-host-plan");
        if (!File.Exists(exe) || !File.Exists(archive))
            throw new Exception("official-codex-not-found");
        if (Text(plan, "compatibilityMode") != "auto")
            throw new Exception("invalid-official-host-plan");
        return plan;
    }

    private static bool OfficialRunning(string executable)
    {
        foreach (
            var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable))
        )
        {
            using (process)
            {
                try
                {
                    if (
                        String.Equals(
                            Path.GetFullPath(process.MainModule.FileName),
                            executable,
                            StringComparison.OrdinalIgnoreCase
                        )
                    )
                        return true;
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception)
                {
                    throw new Exception("cannot-check-existing-codex");
                }
            }
        }
        return false;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string report = null;
        try
        {
            if (args.Length == 3 && args[0] == "--stop" && args[1] == "--root")
            {
                // 测试或其他安装实例不能停止不同目录中的助手。
                try
                {
                    using (var signal = EventWaitHandle.OpenExisting(StopName(args[2])))
                        signal.Set();
                }
                catch (WaitHandleCannotBeOpenedException) { }
                return 0;
            }
#if CDP_TEST_BUILD
            if (args.Length == 5 && args[0] == "--test")
            {
                report = Path.GetFullPath(args[4]);
                using (var stop = new EventWaitHandle(false, EventResetMode.ManualReset))
                {
                    RunPage(
                            new Uri(args[1]),
                            File.ReadAllText(args[2]),
                            report,
                            stop,
                            args[3] == "once"
                        )
                        .GetAwaiter()
                        .GetResult();
                }
                return 0;
            }
#endif
            if (args.Length != 4 || args[0] != "--root" || args[2] != "--report")
                throw new Exception("invalid-runtime-arguments");
            string root = Path.GetFullPath(args[1]).TrimEnd(Path.DirectorySeparatorChar);
            report = Path.GetFullPath(args[3]);
            using (var mutex = new Mutex(false, SessionName("instance")))
            {
                bool acquired;
                try
                {
                    acquired = mutex.WaitOne(0);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }
                if (!acquired)
                {
                    WriteReport(
                        report,
                        new { runtimeConnected = false, errorCode = "helper-already-running" }
                    );
                    return 2;
                }
                try
                {
                    var plan = ReadPlan(root);
                    if (OfficialRunning(Text(plan, "executable")))
                        throw new Exception("close-codex-first");
                    var reserve = new TcpListener(IPAddress.Loopback, 0);
                    reserve.Start();
                    int port = ((IPEndPoint)reserve.LocalEndpoint).Port;
                    reserve.Stop();
                    uint pid = Activate(Text(plan, "aumid"), port);
                    using (
                        var stop = new EventWaitHandle(
                            false,
                            EventResetMode.ManualReset,
                            StopName(root)
                        )
                    )
                    {
                        stop.Reset();
                        Uri endpoint = WaitForPage(port, pid, stop).GetAwaiter().GetResult();
                        using (var localUsage = UsageLogReader.OpenDefault())
                            RunPage(
                                    endpoint,
                                    File.ReadAllText(Child(root, "runtime.js")),
                                    report,
                                    stop,
                                    false,
                                    localUsage
                                )
                                .GetAwaiter()
                                .GetResult();
                    }
                }
                finally
                {
                    mutex.ReleaseMutex();
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            // 异常文本可能包含宿主响应，只持久化本项目固定错误码，
            // 不记录异常堆栈、脚本源码或对象值。
            string code = error.Message;
            if (!System.Text.RegularExpressions.Regex.IsMatch(code ?? "", "^[a-z][a-z0-9-]{1,90}$"))
                code = "runtime-start-or-connection-failed";
            if (report != null)
                try
                {
                    WriteReport(
                        report,
                        new
                        {
                            runtimeConnected = false,
                            errorCode = code,
                            officialFilesWritten = false,
                            realModelRequests = 0,
                        }
                    );
                }
                catch { }
            return 1;
        }
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ActivationManager { }

    [
        ComImport,
        InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
        Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")
    ]
    private interface IActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId
        );
    }

    private static uint Activate(string aumid, int port)
    {
        var manager = (IActivationManager)new ActivationManager();
        try
        {
            uint pid;
            string flags =
                "--remote-debugging-address=127.0.0.1 --remote-debugging-port="
                + port
                + " --remote-allow-origins=http://127.0.0.1:"
                + port;
            int result = manager.ActivateApplication(aumid, flags, 0, out pid);
            Marshal.ThrowExceptionForHR(result);
            if (pid == 0)
                throw new Exception("official-activation-returned-no-process");
            return pid;
        }
        finally
        {
            Marshal.ReleaseComObject(manager);
        }
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr table,
        ref int size,
        bool order,
        int family,
        int tableClass,
        uint reserved
    );

    // 端点必须是本机回环，且监听进程匹配本次启动的官方应用进程。
    private static bool VerifyListener(int port, uint pid)
    {
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint status = GetExtendedTcpTable(buffer, ref size, false, 2, 5, 0);
            if (status == 122)
                return false; // 两次读取之间表格增大，交由下一轮重试。
            if (status != 0)
                throw new Exception("cannot-verify-debug-listener");
            int count = Marshal.ReadInt32(buffer);
            for (int i = 0; i < count; i++)
            {
                int offset = 4 + i * 24;
                uint rawPort = unchecked((uint)Marshal.ReadInt32(buffer, offset + 8));
                int localPort = (int)(((rawPort & 255) << 8) | ((rawPort >> 8) & 255));
                if (localPort != port || Marshal.ReadInt32(buffer, offset) != 2)
                    continue;
                var address = new IPAddress(unchecked((uint)Marshal.ReadInt32(buffer, offset + 4)));
                if (
                    !IPAddress.Loopback.Equals(address)
                    || unchecked((uint)Marshal.ReadInt32(buffer, offset + 20)) != pid
                )
                    throw new Exception("debug-listener-not-owned-loopback");
                return true;
            }
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static async Task<Uri> WaitForPage(int port, uint pid, EventWaitHandle stop)
    {
        for (int i = 0; i < 150 && !stop.WaitOne(0); i++)
        {
            if (VerifyListener(port, pid))
            {
                try
                {
                    var request = (HttpWebRequest)
                        WebRequest.Create("http://127.0.0.1:" + port + "/json/list");
                    request.Proxy = null;
                    request.Timeout = 1500;
                    request.ReadWriteTimeout = 1500;
                    using (var deadline = new CancellationTokenSource(1500))
                    using (deadline.Token.Register(request.Abort))
                    using (var response = await request.GetResponseAsync())
                    using (var reader = new StreamReader(response.GetResponseStream()))
                    {
                        var targets =
                            Json.DeserializeObject(await reader.ReadToEndAsync()) as object[];
                        if (targets != null)
                            foreach (object item in targets)
                            {
                                var target = Map(item);
                                string url = Text(target, "url"),
                                    websocket = Text(target, "webSocketDebuggerUrl");
                                if (
                                    Text(target, "type") == "page"
                                    && url != null
                                    && url.StartsWith("app://-/", StringComparison.Ordinal)
                                )
                                {
                                    Uri uri;
                                    if (
                                        !Uri.TryCreate(websocket, UriKind.Absolute, out uri)
                                        || uri.Host != "127.0.0.1"
                                        || uri.Port != port
                                        || uri.Scheme != "ws"
                                    )
                                        throw new Exception("invalid-debug-websocket");
                                    return uri;
                                }
                            }
                    }
                }
                catch (WebException) { }
            }
            await Task.Delay(200);
        }
        throw new Exception("official-cdp-page-not-ready-restart-required");
    }

    internal static async Task RunPage(
        Uri endpoint,
        string script,
        string report,
        EventWaitHandle stop,
        bool once,
        UsageLogReader localUsage = null
    )
    {
        if (
            endpoint.Scheme != "ws"
            || endpoint.Host != "127.0.0.1"
            || !endpoint.AbsolutePath.StartsWith("/devtools/page/", StringComparison.Ordinal)
        )
            throw new Exception("nonlocal-or-nonpage-debug-endpoint");
        using (var cdp = new CdpConnection())
        {
            await cdp.Connect(endpoint);
            string registration = null;
            try
            {
                await cdp.Call("Page.enable", new { });
                var registered = await cdp.Call(
                    "Page.addScriptToEvaluateOnNewDocument",
                    new { source = script }
                );
                registration = Text(registered, "identifier");
                if (String.IsNullOrEmpty(registration))
                    throw new Exception("new-document-registration-failed");
                Dictionary<string, object> health = null;
                for (int i = 0; i < 80 && !stop.WaitOne(0); i++)
                {
                    try
                    {
                        var result = await cdp.Call(
                            "Runtime.evaluate",
                            new
                            {
                                expression = script,
                                awaitPromise = true,
                                returnByValue = true,
                            },
                            60000
                        );
                        if (!result.ContainsKey("exceptionDetails"))
                            health = Map(Map(result["result"])["value"]);
                        if (Text(health, "state") == "ready" || Text(health, "state") == "loading")
                            break;
                        if (
                            Text(health, "state") == "unsupported"
                            || Text(health, "state") == "wrong-origin"
                        )
                            throw ContractFailure(health);
                    }
                    catch (CdpCommandException)
                    { /* 初始导航可能销毁执行上下文。 */
                    }
                    await Task.Delay(200);
                }
                if (health == null)
                    throw new Exception("runtime-injection-not-confirmed");
                DateTime readyDeadline = DateTime.UtcNow.AddSeconds(30);
                bool wasReady = false;
                string localSession = null;
                long localBatch = 0;
                DateTime nextReport = DateTime.MinValue;
                for (; ; )
                {
                    Dictionary<string, object> value = null;
                    try
                    {
                        if (localUsage != null)
                            localUsage.Poll();
                        string expression = "globalThis.__ctTokenCdpRuntimeV1?.health() ?? null";
                        if (localUsage != null)
                            expression =
                                "globalThis.__ctTokenCdpRuntimeV1?.exchangeLocalUsage("
                                + Json.Serialize(
                                    new
                                    {
                                        session = localSession,
                                        batchId = localBatch,
                                        records = localUsage.Records,
                                        caughtUp = localUsage.CaughtUp,
                                    }
                                )
                                + ") ?? null";
                        var result = await cdp.Call(
                            "Runtime.evaluate",
                            new { expression = expression, returnByValue = true }
                        );
                        object remote;
                        var remoteObject = result.ContainsKey("result")
                            ? Map(result["result"])
                            : null;
                        if (remoteObject != null && remoteObject.TryGetValue("value", out remote))
                        {
                            value = Map(remote);
                            if (localUsage != null && value != null)
                            {
                                string session = Text(value, "session");
                                object raw;
                                if (!String.IsNullOrEmpty(session) && session.Length <= 100)
                                {
                                    if (session != localSession)
                                    {
                                        localUsage.Reset();
                                        localSession = session;
                                        localBatch++;
                                    }
                                    else if (
                                        value.TryGetValue("ack", out raw)
                                        && raw != null
                                        && Convert.ToInt64(raw) == localBatch
                                    )
                                    {
                                        localUsage.Acknowledge();
                                        localBatch++;
                                    }
                                    if (value.TryGetValue("targets", out raw))
                                        localUsage.SetTargets(raw);
                                }
                                value = value.TryGetValue("health", out raw) ? Map(raw) : null;
                            }
                        }
                    }
                    catch (CdpCommandException)
                    { /* 页面导航可能替换整个 JS 执行环境。 */
                    }
                    catch
                    {
                        if (!cdp.IsOpen && wasReady)
                            break;
                        throw;
                    }
                    bool ready = Text(value, "state") == "ready";
                    if (Text(value, "state") == "unsupported")
                        throw ContractFailure(value);
                    if (!ready && DateTime.UtcNow > readyDeadline)
                        throw new Exception("runtime-injection-not-ready");
                    if (ready)
                    {
                        wasReady = true;
                        readyDeadline = DateTime.UtcNow.AddSeconds(30);
                    }
                    if (once || DateTime.UtcNow >= nextReport)
                    {
                        nextReport = DateTime.UtcNow.AddMilliseconds(1500);
                        WriteReport(
                            report,
                            new
                            {
                                runtimeConnected = true,
                                localUsage = localUsage != null
                                    ? localUsage.Health()
                                    : new { state = "unavailable" },
                                injectionReady = ready,
                                runtimeHealth = SafeHealth(value),
                                officialFilesWritten = false,
                                clientCopied = false,
                                originalProfileUsed = true,
                                realModelRequests = 0,
                                fullOfficialHostAcceptance = false,
                            }
                        );
                    }
                    if (once && ready)
                        break;
                    if (stop.WaitOne(localUsage != null ? 250 : 1500) || !cdp.IsOpen)
                        break;
                }
                if (!once)
                    WriteReport(
                        report,
                        new
                        {
                            runtimeConnected = false,
                            state = "stopped",
                            officialFilesWritten = false,
                            closeCodexToCloseDebugPort = true,
                            realModelRequests = 0,
                            fullOfficialHostAcceptance = false,
                        }
                    );
            }
            finally
            {
                if (cdp.IsOpen)
                {
                    try
                    {
                        if (registration != null)
                            cdp.Call(
                                    "Page.removeScriptToEvaluateOnNewDocument",
                                    new { identifier = registration }
                                )
                                .GetAwaiter()
                                .GetResult();
                    }
                    catch { }
                    try
                    {
                        cdp.Call(
                                "Runtime.evaluate",
                                new { expression = "globalThis.__ctTokenCdpRuntimeV1?.dispose()" }
                            )
                            .GetAwaiter()
                            .GetResult();
                    }
                    catch { }
                }
            }
        }
    }
}

internal sealed class CdpCommandException : Exception
{
    public CdpCommandException()
        : base("cdp-command-rejected") { }
}

// CDP 命令按递增 ID 匹配异步响应，发送串行化；断线时统一结束所有等待。
internal sealed class CdpConnection : IDisposable
{
    private readonly ClientWebSocket socket = new ClientWebSocket();
    private readonly CancellationTokenSource cancel = new CancellationTokenSource();
    private readonly SemaphoreSlim send = new SemaphoreSlim(1);
    private readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> pending =
        new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
    private int sequence;
    private Task receiver;
    internal bool IsOpen
    {
        get { return socket.State == WebSocketState.Open; }
    }

    internal async Task Connect(Uri endpoint)
    {
        socket.Options.Proxy = null;
        using (var deadline = new CancellationTokenSource(5000))
            await socket.ConnectAsync(endpoint, deadline.Token);
        receiver = Receive();
    }

    internal async Task<Dictionary<string, object>> Call(
        string method,
        object parameters,
        int timeoutMs = 8000
    )
    {
        int id = Interlocked.Increment(ref sequence);
        var completion = new TaskCompletionSource<Dictionary<string, object>>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        lock (pending)
            pending.Add(id, completion);
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(
                RuntimeProgram.Json.Serialize(
                    new
                    {
                        id = id,
                        method = method,
                        @params = parameters,
                    }
                )
            );
            await send.WaitAsync(cancel.Token);
            try
            {
                await socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    cancel.Token
                );
            }
            finally
            {
                send.Release();
            }
            if (
                await Task.WhenAny(completion.Task, Task.Delay(timeoutMs, cancel.Token))
                != completion.Task
            )
                throw new Exception("cdp-command-timeout");
            return await completion.Task;
        }
        finally
        {
            lock (pending)
                pending.Remove(id);
        }
    }

    // 分片合并后再解析，并限制响应大小；无 ID 的宿主事件不在这里保存。
    private async Task Receive()
    {
        var buffer = new byte[8192];
        try
        {
            while (!cancel.IsCancellationRequested && IsOpen)
            {
                using (var stream = new MemoryStream())
                {
                    WebSocketReceiveResult part;
                    do
                    {
                        part = await socket.ReceiveAsync(
                            new ArraySegment<byte>(buffer),
                            cancel.Token
                        );
                        if (part.MessageType == WebSocketMessageType.Close)
                            return;
                        stream.Write(buffer, 0, part.Count);
                        if (stream.Length > 2 * 1024 * 1024)
                            throw new Exception("oversize-debug-response");
                    } while (!part.EndOfMessage);
                    var message = RuntimeProgram.Json.Deserialize<Dictionary<string, object>>(
                        Encoding.UTF8.GetString(stream.ToArray())
                    );
                    object identifier;
                    if (!message.TryGetValue("id", out identifier))
                        continue; // 不保存宿主事件。
                    TaskCompletionSource<Dictionary<string, object>> completion;
                    lock (pending)
                        pending.TryGetValue(Convert.ToInt32(identifier), out completion);
                    if (completion == null)
                        continue;
                    if (message.ContainsKey("error"))
                        completion.TrySetException(new CdpCommandException());
                    else
                    {
                        object result;
                        completion.TrySetResult(
                            message.TryGetValue("result", out result)
                                ? RuntimeProgram.Map(result)
                                : new Dictionary<string, object>()
                        );
                    }
                }
            }
        }
        catch
        { /* 只向调用方返回固定错误，不传递远端响应正文。 */
        }
        finally
        {
            lock (pending)
                foreach (var item in pending.Values)
                    item.TrySetException(new Exception("debug-connection-closed"));
        }
    }

    public void Dispose()
    {
        cancel.Cancel();
        socket.Abort();
        socket.Dispose();
        cancel.Dispose();
    }
}
