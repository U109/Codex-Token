using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// 只读匹配线程的 rollout 文件。扫描经过正文所在的字节，但只解码候选用量和回合配置行；
// 传出及持有的记录均重新构造成白名单元数据，不记录原始行、正文、路径或异常文本。
internal sealed class UsageLogReader : IDisposable
{
    private const long SafeInteger = 9007199254740991L;
    private const int MaxLine = 64 * 1024;
    private static readonly string[] Fields =
    {
        "totalTokens",
        "inputTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
    };
    private static readonly string[] RawFields =
    {
        "total_tokens",
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
    };
    private static readonly Regex FileName = new Regex(
        @"^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );
    private static readonly Regex Id = new Regex(
        @"^[\w.:-]{1,200}$",
        RegexOptions.CultureInvariant
    );
    private static readonly byte[] Marker = Encoding.ASCII.GetBytes("\"token_usage_record\"");
    private static readonly byte[] ContextMarker = Encoding.ASCII.GetBytes("\"turn_context\"");
    private static readonly Regex ModelId = new Regex(
        @"^[\w./:-]{1,200}$",
        RegexOptions.CultureInvariant
    );
    private readonly JavaScriptSerializer json = new JavaScriptSerializer
    {
        MaxJsonLength = MaxLine,
        RecursionLimit = 20,
    };
    private readonly string[] roots;
    private readonly Dictionary<string, long> targets = new Dictionary<string, long>(
        StringComparer.Ordinal
    );
    private readonly Dictionary<string, Cursor> files = new Dictionary<string, Cursor>(
        StringComparer.OrdinalIgnoreCase
    );
    private readonly Queue<string> directories = new Queue<string>();
    private readonly List<object> records = new List<object>();
    private readonly List<string> caughtUp = new List<string>();
    private readonly HashSet<string> reportedCaughtUp = new HashSet<string>(StringComparer.Ordinal);
    private IEnumerator<string> entries;
    private DateTime nextScan = DateTime.MinValue,
        nextRecentScan = DateTime.MinValue;
    private bool scanning,
        unavailable;
    private int nextFile;
    private long bytesRead,
        validRecords,
        rejectedRecords;

    private sealed class Cursor : IDisposable
    {
        internal string Path,
            ThreadId,
            Identity;
        internal long Offset,
            InitialEnd,
            LineStart;
        internal byte[] Anchor = new byte[0];
        internal MemoryStream Line = new MemoryStream();
        internal readonly Dictionary<string, string> TurnModels = new Dictionary<string, string>(
            StringComparer.Ordinal
        );
        internal bool Oversized,
            AtEnd,
            Missing;

        public void Dispose()
        {
            Line.Dispose();
        }

        internal void Reset(string identity, long length)
        {
            Identity = identity;
            Offset = 0;
            InitialEnd = length;
            LineStart = 0;
            Anchor = new byte[0];
            Line.SetLength(0);
            TurnModels.Clear();
            Oversized = false;
            AtEnd = false;
        }
    }

    internal UsageLogReader(string codexHome)
    {
        string home = Path.GetFullPath(codexHome);
        roots = new[] { Path.Combine(home, "sessions"), Path.Combine(home, "archived_sessions") };
    }

    internal static UsageLogReader OpenDefault()
    {
        try
        {
            return new UsageLogReader(DefaultHome());
        }
        catch (ArgumentException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    internal static string DefaultHome()
    {
        string configured = Environment.GetEnvironmentVariable("CODEX_HOME");
        return String.IsNullOrWhiteSpace(configured)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".codex"
            )
            : Path.GetFullPath(configured);
    }

    internal void SetTargets(object raw)
    {
        var list = raw as IEnumerable;
        if (list == null)
            return;
        var next = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (object item in list)
        {
            var value = item as Dictionary<string, object>;
            object revision;
            string thread = Text(value, "threadId");
            long number;
            if (next.Count >= 128)
                break;
            if (
                thread != null
                && Id.IsMatch(thread)
                && value.TryGetValue("revision", out revision)
                && Integer(revision, out number)
            )
                next[thread] = number;
        }
        bool changed =
            next.Count != targets.Count
            || next.Any(pair => !targets.ContainsKey(pair.Key) || targets[pair.Key] != pair.Value);
        if (!changed)
            return;
        foreach (var pair in files.ToArray())
        {
            long revision;
            if (
                !next.TryGetValue(pair.Value.ThreadId, out revision)
                || !targets.ContainsKey(pair.Value.ThreadId)
                || targets[pair.Value.ThreadId] != revision
            )
            {
                pair.Value.Dispose();
                files.Remove(pair.Key);
                reportedCaughtUp.Remove(pair.Value.ThreadId);
            }
        }
        targets.Clear();
        foreach (var pair in next)
            targets.Add(pair.Key, pair.Value);
        StartScan();
        nextRecentScan = DateTime.MinValue;
    }

    // ACK 前保留同一批；页面导航丢失响应后可以原样重送，接收端按 responseId 幂等。
    internal object[] Records
    {
        get { return records.ToArray(); }
    }
    internal string[] CaughtUp
    {
        get { return caughtUp.ToArray(); }
    }
    internal bool HasPending
    {
        get { return records.Count > 0 || caughtUp.Count > 0; }
    }

    internal void Acknowledge()
    {
        records.Clear();
        caughtUp.Clear();
    }

    internal object Health()
    {
        return new
        {
            state = unavailable ? "unavailable"
            : targets.Count == 0 ? "idle"
            : "watching",
            watchedFiles = files.Count,
            bytesRead = bytesRead,
            usageRecords = validRecords,
            rejectedRecords = rejectedRecords,
        };
    }

    internal void Reset()
    {
        foreach (var file in files.Values)
            file.Dispose();
        files.Clear();
        targets.Clear();
        records.Clear();
        caughtUp.Clear();
        reportedCaughtUp.Clear();
        if (entries != null)
            entries.Dispose();
        entries = null;
        directories.Clear();
        scanning = false;
        nextScan = DateTime.MinValue;
        nextRecentScan = DateTime.MinValue;
    }

    private static bool Regular(string path, bool directory)
    {
        var attributes = File.GetAttributes(path);
        return (attributes & FileAttributes.ReparsePoint) == 0
            && ((attributes & FileAttributes.Directory) != 0) == directory;
    }

    private void StartScan()
    {
        if (entries != null)
            entries.Dispose();
        entries = null;
        directories.Clear();
        scanning = true;
        unavailable = false;
        foreach (string root in roots)
        {
            try
            {
                if (Directory.Exists(root) && Regular(root, true))
                    directories.Enqueue(root);
            }
            catch (IOException)
            {
                unavailable = true;
            }
            catch (UnauthorizedAccessException)
            {
                unavailable = true;
            }
        }
        if (directories.Count == 0)
        {
            scanning = false;
            unavailable = true;
        }
        nextScan = DateTime.UtcNow.AddSeconds(5);
    }

    private void Notice(string path)
    {
        var match = FileName.Match(Path.GetFileName(path));
        if (
            !match.Success
            || !targets.ContainsKey(match.Groups[1].Value)
            || files.ContainsKey(path)
        )
            return;
        if (files.Count >= 512)
        {
            unavailable = true;
            return;
        }
        if (Regular(path, false))
        {
            files.Add(path, new Cursor { Path = path, ThreadId = match.Groups[1].Value });
            reportedCaughtUp.Remove(match.Groups[1].Value);
        }
    }

    private void Discover()
    {
        // 新聊天先查今天的目录；其他日期和归档以有界目录遍历补齐。
        if (DateTime.UtcNow >= nextRecentScan)
        {
            nextRecentScan = DateTime.UtcNow.AddSeconds(1);
            foreach (
                DateTime date in new[] { DateTime.Now, DateTime.UtcNow, DateTime.Now.AddDays(-1) }
            )
            {
                string folder = Path.Combine(
                    roots[0],
                    date.ToString("yyyy"),
                    date.ToString("MM"),
                    date.ToString("dd")
                );
                try
                {
                    if (Directory.Exists(folder) && Regular(folder, true))
                        foreach (
                            string path in Directory
                                .EnumerateFiles(folder, "rollout-*.jsonl")
                                .Take(4096)
                        )
                            Notice(path);
                }
                catch (IOException)
                {
                    unavailable = true;
                }
                catch (UnauthorizedAccessException)
                {
                    unavailable = true;
                }
            }
        }
        if (!scanning && DateTime.UtcNow >= nextScan)
            StartScan();
        for (int budget = 0; scanning && budget < 512; budget++)
        {
            try
            {
                if (entries == null)
                {
                    if (directories.Count == 0)
                    {
                        scanning = false;
                        break;
                    }
                    entries = Directory
                        .EnumerateFileSystemEntries(directories.Dequeue())
                        .GetEnumerator();
                }
                if (!entries.MoveNext())
                {
                    entries.Dispose();
                    entries = null;
                    continue;
                }
                string path = entries.Current;
                var attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    continue;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    // rollout 的目录层级有上限，不能被异常目录树拖成无限扫描。
                    if (
                        directories.Count < 8192
                        && roots.Any(root =>
                            path.StartsWith(
                                root + Path.DirectorySeparatorChar,
                                StringComparison.OrdinalIgnoreCase
                            )
                            && path.Substring(root.Length)
                                .Count(c => c == Path.DirectorySeparatorChar) <= 4
                        )
                    )
                        directories.Enqueue(path);
                    else
                        unavailable = true;
                }
                else
                    Notice(path);
            }
            catch (IOException)
            {
                unavailable = true;
                if (entries != null)
                    entries.Dispose();
                entries = null;
            }
            catch (UnauthorizedAccessException)
            {
                unavailable = true;
                if (entries != null)
                    entries.Dispose();
                entries = null;
            }
        }
    }

    internal void Poll()
    {
        if (HasPending || targets.Count == 0)
            return;
        Discover();
        var cursors = files.Values.ToArray();
        int budget = 2 * 1024 * 1024;
        var watch = Stopwatch.StartNew();
        int visited = 0;
        while (
            cursors.Length > 0
            && budget > 0
            && records.Count < 128
            && watch.ElapsedMilliseconds < 50
        )
        {
            var cursor = cursors[nextFile++ % cursors.Length];
            if (nextFile > 1000000)
                nextFile = 0;
            int consumed = Read(cursor, Math.Min(budget, 256 * 1024));
            budget -= consumed;
            if (consumed > 0 || !cursor.AtEnd)
                reportedCaughtUp.Remove(cursor.ThreadId);
            if (
                ++visited >= cursors.Length
                && cursors.All(file => file.AtEnd || file.Identity == null)
            )
                break;
            // 不可读文件或已到 EOF 的文件不能使循环忙等。
            if (visited >= cursors.Length && consumed == 0)
                break;
        }
        foreach (var cursor in cursors.Where(file => file.Missing))
        {
            files.Remove(cursor.Path);
            reportedCaughtUp.Remove(cursor.ThreadId);
            cursor.Dispose();
        }
        cursors = cursors.Where(file => !file.Missing).ToArray();
        if (!scanning && !unavailable)
            foreach (string thread in targets.Keys)
            {
                var matching = cursors.Where(file => file.ThreadId == thread).ToArray();
                if (
                    matching.Length > 0
                    && matching.All(file => file.AtEnd)
                    && reportedCaughtUp.Add(thread)
                )
                    caughtUp.Add(thread);
            }
    }

    private int Read(Cursor cursor, int budget)
    {
        if (cursor.Missing)
            return 0;
        try
        {
            if (!Regular(cursor.Path, false))
            {
                cursor.AtEnd = false;
                return 0;
            }
            using (
                var stream = new FileStream(
                    cursor.Path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete
                )
            )
            {
                string identity = FileIdentity(stream);
                long length = stream.Length;
                if (
                    cursor.Identity != identity
                    || length < cursor.Offset
                    || !AnchorMatches(stream, cursor)
                )
                    cursor.Reset(identity, length);
                stream.Position = cursor.Offset;
                var buffer = new byte[Math.Min(64 * 1024, budget)];
                int consumed = 0;
                while (consumed < budget && records.Count < 128)
                {
                    int read = stream.Read(buffer, 0, Math.Min(buffer.Length, budget - consumed));
                    if (read == 0)
                        break;
                    // 消费完整读取块，达到批上限时不再读取下一块。一个块最多约 100 个真实用量行。
                    // 为保持严格 128 条上限，多出来的行留待下一次从该字节偏移读取。
                    for (int i = 0; i < read; i++)
                    {
                        byte value = buffer[i];
                        cursor.Offset++;
                        consumed++;
                        bytesRead++;
                        if (value == 10)
                        {
                            if (!cursor.Oversized)
                                ParseLine(cursor);
                            cursor.Line.SetLength(0);
                            cursor.Oversized = false;
                            cursor.LineStart = cursor.Offset;
                            if (records.Count >= 128)
                                break;
                        }
                        else if (!cursor.Oversized)
                        {
                            if (cursor.Line.Length >= MaxLine)
                            {
                                cursor.Line.SetLength(0);
                                cursor.Oversized = true;
                            }
                            else
                                cursor.Line.WriteByte(value);
                        }
                    }
                }
                SaveAnchor(stream, cursor);
                cursor.AtEnd =
                    cursor.Offset >= stream.Length && cursor.Line.Length == 0 && !cursor.Oversized;
                return consumed;
            }
        }
        catch (FileNotFoundException)
        {
            cursor.AtEnd = false;
            cursor.Missing = true;
            return 0;
        }
        catch (DirectoryNotFoundException)
        {
            cursor.AtEnd = false;
            cursor.Missing = true;
            return 0;
        }
        catch (IOException)
        {
            cursor.AtEnd = false;
            unavailable = true;
            return 0;
        }
        catch (UnauthorizedAccessException)
        {
            cursor.AtEnd = false;
            unavailable = true;
            return 0;
        }
    }

    private void ParseLine(Cursor cursor)
    {
        byte[] bytes = cursor.Line.GetBuffer();
        int length = (int)cursor.Line.Length;
        if (!Contains(bytes, length, Marker) && !Contains(bytes, length, ContextMarker))
            return;
        try
        {
            string text = new UTF8Encoding(false, true)
                .GetString(bytes, 0, length)
                .TrimStart('\uFEFF');
            var row = json.DeserializeObject(text) as Dictionary<string, object>;
            string type = Text(row, "type");
            if (type != "token_usage_record" && type != "turn_context")
                return;
            object raw;
            var payload = row.TryGetValue("payload", out raw)
                ? raw as Dictionary<string, object>
                : null;
            if (type == "turn_context")
            {
                // 只记录该文件内先于请求出现、具有精确 turn_id 的模型，不借用其他回合或当前选择。
                string turn = Text(payload, "turn_id"),
                    model = Text(payload, "model");
                if (turn == null || !Id.IsMatch(turn))
                    return;
                if (model == null || !ModelId.IsMatch(model))
                    cursor.TurnModels.Remove(turn);
                else if (cursor.TurnModels.Count < 10000 || cursor.TurnModels.ContainsKey(turn))
                    cursor.TurnModels[turn] = model;
                return;
            }
            var clean = CleanRecord(payload, cursor, cursor.LineStart < cursor.InitialEnd);
            if (clean == null)
            {
                rejectedRecords++;
                return;
            }
            records.Add(clean);
            validRecords++;
        }
        catch (ArgumentException)
        {
            rejectedRecords++;
        }
        catch (InvalidOperationException)
        {
            rejectedRecords++;
        }
    }

    private static object CleanRecord(
        Dictionary<string, object> payload,
        Cursor cursor,
        bool replay
    )
    {
        string thread = Text(payload, "thread_id"),
            turn = Text(payload, "turn_id"),
            response = Text(payload, "response_id");
        if (
            thread != cursor.ThreadId
            || turn == null
            || response == null
            || !Id.IsMatch(turn)
            || !Id.IsMatch(response)
        )
            return null;
        Dictionary<string, long> usage = Counts(payload, "usage"),
            turnTotal = Counts(payload, "turn_token_usage"),
            total = Counts(payload, "thread_token_usage");
        if (
            usage == null
            || turnTotal == null
            || total == null
            || Fields.Any(field =>
                usage[field] > turnTotal[field] || turnTotal[field] > total[field]
            )
        )
            return null;
        string model;
        cursor.TurnModels.TryGetValue(turn, out model);
        return new
        {
            threadId = thread,
            turnId = turn,
            responseId = response,
            usage = usage,
            checkpoint = new { total = total, turnTotal = turnTotal },
            model = model == null ? null : new { id = model, basis = "turn-context" },
            replay = replay,
        };
    }

    private static bool Contains(byte[] bytes, int length, byte[] marker)
    {
        for (int i = 0; i <= length - marker.Length; i++)
        {
            int j = 0;
            while (j < marker.Length && bytes[i + j] == marker[j])
                j++;
            if (j == marker.Length)
                return true;
        }
        return false;
    }

    private static Dictionary<string, long> Counts(Dictionary<string, object> parent, string name)
    {
        object raw;
        var values =
            parent != null && parent.TryGetValue(name, out raw)
                ? raw as Dictionary<string, object>
                : null;
        if (values == null)
            return null;
        var result = new Dictionary<string, long>();
        for (int i = 0; i < Fields.Length; i++)
        {
            long number;
            if (!values.TryGetValue(RawFields[i], out raw) || !Integer(raw, out number))
                return null;
            result.Add(Fields[i], number);
        }
        if (
            result["totalTokens"] != result["inputTokens"] + result["outputTokens"]
            || result["cachedInputTokens"] + result["cacheWriteInputTokens"] > result["inputTokens"]
            || result["reasoningOutputTokens"] > result["outputTokens"]
        )
            return null;
        return result;
    }

    private static bool Integer(object raw, out long number)
    {
        number = 0;
        if (!(raw is int || raw is long || raw is decimal || raw is double))
            return false;
        try
        {
            decimal value = Convert.ToDecimal(raw);
            if (value < 0 || value > SafeInteger || Decimal.Truncate(value) != value)
                return false;
            number = (long)value;
            return true;
        }
        catch (OverflowException)
        {
            return false;
        }
    }

    private static string Text(Dictionary<string, object> value, string name)
    {
        object raw;
        return value != null && value.TryGetValue(name, out raw) ? raw as string : null;
    }

    // 文件身份识别替换；偏移前的短字节锚点识别原文件截断后快速重写到更长长度。
    private static bool AnchorMatches(FileStream stream, Cursor cursor)
    {
        if (cursor.Anchor.Length == 0)
            return true;
        stream.Position = cursor.Offset - cursor.Anchor.Length;
        var bytes = new byte[cursor.Anchor.Length];
        return stream.Read(bytes, 0, bytes.Length) == bytes.Length
            && bytes.SequenceEqual(cursor.Anchor);
    }

    private static void SaveAnchor(FileStream stream, Cursor cursor)
    {
        int length = (int)Math.Min(64, cursor.Offset);
        stream.Position = cursor.Offset - length;
        cursor.Anchor = new byte[length];
        if (stream.Read(cursor.Anchor, 0, length) != length)
            cursor.Anchor = new byte[0];
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation,
            Access,
            Write;
        internal uint Volume,
            SizeHigh,
            SizeLow,
            Links,
            IndexHigh,
            IndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation info);

    private static string FileIdentity(FileStream stream)
    {
        FileInformation info;
        if (!GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(), out info))
            throw new IOException();
        return info.Volume
            + ":"
            + info.IndexHigh
            + ":"
            + info.IndexLow
            + ":"
            + info.Creation.dwHighDateTime
            + ":"
            + info.Creation.dwLowDateTime;
    }

    public void Dispose()
    {
        Reset();
    }
}
