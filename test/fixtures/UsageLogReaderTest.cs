using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class UsageLogReaderTest
{
    private const string Thread = "11111111-1111-4111-8111-111111111111";
    private const string Other = "22222222-2222-4222-8222-222222222222";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = 1024 * 1024,
    };
    private static int assertions;

    private static void Check(bool condition, string code)
    {
        assertions++;
        if (!condition)
            throw new Exception(code);
    }

    private static object Counts(int multiplier)
    {
        return new
        {
            total_tokens = 1100 * multiplier,
            input_tokens = 1000 * multiplier,
            cached_input_tokens = 500 * multiplier,
            cache_write_input_tokens = 0,
            output_tokens = 100 * multiplier,
            reasoning_output_tokens = 50 * multiplier,
        };
    }

    private static string Row(string response, int cumulative, string thread = Thread)
    {
        return Json.Serialize(
                new
                {
                    type = "token_usage_record",
                    payload = new
                    {
                        thread_id = thread,
                        turn_id = "turn-1",
                        response_id = response,
                        usage = Counts(1),
                        turn_token_usage = Counts(cumulative),
                        thread_token_usage = Counts(cumulative),
                        text = "PRIVATE_中文_BODY",
                        credentials = "PRIVATE_KEY",
                    },
                }
            ) + "\n";
    }

    private static string Rollout(
        string folder,
        string thread = Thread,
        string stamp = "2026-10-20T09-53-01"
    )
    {
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, "rollout-" + stamp + "-" + thread + ".jsonl");
    }

    private static void Targets(UsageLogReader reader, long revision = 0, bool other = false)
    {
        reader.SetTargets(
            new object[]
            {
                new Dictionary<string, object> { { "threadId", Thread }, { "revision", revision } },
                new Dictionary<string, object>
                {
                    { "threadId", other ? Other : Thread },
                    { "revision", revision },
                },
            }
        );
    }

    private static object[] Read(UsageLogReader reader, int minimum = 1)
    {
        for (int i = 0; i < 100 && reader.Records.Length < minimum; i++)
            reader.Poll();
        return reader.Records;
    }

    private static Dictionary<string, object> Map(object value)
    {
        return Json.DeserializeObject(Json.Serialize(value)) as Dictionary<string, object>;
    }

    private static string Response(object value)
    {
        return (string)Map(value)["responseId"];
    }

    private static long Bytes(UsageLogReader reader)
    {
        return Convert.ToInt64(Map(reader.Health())["bytesRead"]);
    }

    private static void Append(string file, string text)
    {
        File.AppendAllText(file, text, new UTF8Encoding(false));
    }

    private static void Drain(UsageLogReader reader)
    {
        reader.Acknowledge();
        reader.Poll();
        reader.Acknowledge();
    }

    private static int Main(string[] args)
    {
        try
        {
            string home = Path.GetFullPath(args[0]);
            string folder = Path.Combine(home, "sessions", "2026", "10", "20");
            string file = Rollout(folder);
            Directory.CreateDirectory(home);
            File.WriteAllText(Path.Combine(home, "auth.json"), "PRIVATE_AUTH_NEVER_READ");
            string priorHome = Environment.GetEnvironmentVariable("CODEX_HOME");
            Environment.SetEnvironmentVariable("CODEX_HOME", home);
            Check(UsageLogReader.DefaultHome() == home, "codex-home-override");
            Environment.SetEnvironmentVariable("CODEX_HOME", priorHome);

            string first = Row("r1", 1);
            byte[] encoded = Encoding.UTF8.GetBytes(first);
            int unicode = Array.IndexOf(encoded, (byte)0xe4);
            Check(unicode > 0, "unicode-fixture");
            File.WriteAllBytes(file, encoded.Take(unicode + 1).ToArray());
            using (var reader = new UsageLogReader(home))
            {
                Targets(reader);
                reader.Poll();
                Check(reader.Records.Length == 0, "partial-line-held");
                Check(reader.CaughtUp.Length == 0, "partial-line-not-caught-up");
                using (var stream = new FileStream(file, FileMode.Append, FileAccess.Write))
                    stream.Write(encoded, unicode + 1, encoded.Length - unicode - 1);
                var rows = Read(reader);
                Check(rows.Length == 1 && Response(rows[0]) == "r1", "split-utf8-assembled");
                Check((bool)Map(rows[0])["replay"], "initial-fragment-is-replay");
                string safe = Json.Serialize(rows);
                Check(
                    !safe.Contains("PRIVATE_")
                        && !safe.Contains("credentials")
                        && !safe.Contains(home),
                    "metadata-only"
                );
                long bytes = Bytes(reader);
                reader.Poll();
                Check(
                    reader.Records.Length == 1 && Bytes(reader) == bytes,
                    "unacknowledged-batch-retained"
                );
                Drain(reader);
                long baseline = Bytes(reader);
                string second = Row("r2", 2).Replace("\n", "\r\n");
                Append(file, second);
                rows = Read(reader);
                Check(rows.Length == 1 && Response(rows[0]) == "r2", "append-only-new-record");
                Check(!(bool)Map(rows[0])["replay"], "append-is-live");
                Check(
                    Bytes(reader) - baseline == Encoding.UTF8.GetByteCount(second),
                    "no-rescan-on-append"
                );
                Drain(reader);
                baseline = Bytes(reader);
                reader.Poll();
                Check(Bytes(reader) == baseline, "idle-no-log-rescan");
                Drain(reader);

                // 超长正文、嵌套假类型、无效用量、错误线程和损坏 JSON 都不进入白名单。
                Append(
                    file,
                    new string('x', 80 * 1024)
                        + "\n"
                        + "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_usage_record\"}}\n"
                        + Row("bad-count", 3)
                            .Replace("\"input_tokens\":1000", "\"input_tokens\":-1")
                        + Row("bad-cache", 3)
                            .Replace("\"cached_input_tokens\":500", "\"cached_input_tokens\":5000")
                        + Row("bad-fraction", 3)
                            .Replace("\"output_tokens\":100", "\"output_tokens\":100.5")
                        + Row("bad-safe-integer", 3)
                            .Replace("\"total_tokens\":1100", "\"total_tokens\":9007199254740992")
                        + Row("wrong-thread", 3, Other)
                        + "{\"type\":\"token_usage_record\",\"payload\":\n"
                        + Row("r3", 3)
                );
                rows = Read(reader);
                Check(
                    rows.Length == 1 && Response(rows[0]) == "r3",
                    "invalid-and-body-rows-excluded"
                );
                Check(
                    Convert.ToInt64(Map(reader.Health())["rejectedRecords"]) >= 6,
                    "fixed-invalid-row-diagnostic"
                );
                Drain(reader);

                // 原地截短后立刻重写到更长长度，不能只根据文件长度继续旧偏移。
                string rewritten = Row("rewrite-1", 1) + Row("rewrite-2", 2);
                rewritten =
                    rewritten + new string('z', (int)new FileInfo(file).Length + 100) + "\n";
                File.WriteAllText(file, rewritten, new UTF8Encoding(false));
                rows = Read(reader);
                Check(
                    rows.Length == 2
                        && Response(rows[0]) == "rewrite-1"
                        && Response(rows[1]) == "rewrite-2",
                    "truncate-and-regrow-anchor"
                );
                Check((bool)Map(rows[0])["replay"], "rewritten-history-not-timed");
                Drain(reader);

                File.Move(file, Path.Combine(home, "replaced.old"));
                File.WriteAllText(file, Row("replacement", 1), new UTF8Encoding(false));
                rows = Read(reader);
                Check(
                    rows.Length == 1 && Response(rows[0]) == "replacement",
                    "replaced-file-identity"
                );
                Drain(reader);

                string recentFolder = Path.Combine(
                    home,
                    "sessions",
                    DateTime.Now.ToString("yyyy"),
                    DateTime.Now.ToString("MM"),
                    DateTime.Now.ToString("dd")
                );
                string rotated = Rollout(recentFolder, Thread, "2030-01-01T00-00-00");
                File.WriteAllText(rotated, "\uFEFF" + Row("rotated", 2), new UTF8Encoding(false));
                System.Threading.Thread.Sleep(1100);
                rows = Read(reader);
                Check(
                    rows.Any(row => Response(row) == "rotated"),
                    "new-rollout-discovered-without-target-change"
                );
                Drain(reader);

                File.Delete(rotated);
                reader.Poll();
                Check(
                    reader.CaughtUp.Contains(Thread),
                    "removed-rollout-does-not-block-new-file-catchup"
                );
                Drain(reader);

                string archived = Rollout(Path.Combine(home, "archived_sessions"), Other);
                File.WriteAllText(archived, Row("archived", 1, Other), new UTF8Encoding(false));
                Targets(reader, 0, true);
                rows = Read(reader);
                Check(
                    rows.Any(row => Response(row) == "archived"),
                    "archived-exact-thread-discovered"
                );
                Drain(reader);

                // 一批最多 128 条，达到限制后仍保留下一行起始偏移。
                for (int i = 4; i <= 303; i++)
                    Append(file, Row("bulk-" + i, i));
                var seen = new HashSet<string>();
                for (int pass = 0; pass < 20 && seen.Count < 300; pass++)
                {
                    reader.Poll();
                    rows = reader.Records;
                    Check(rows.Length <= 128, "bounded-batch");
                    foreach (var row in rows)
                        if (Response(row).StartsWith("bulk-"))
                            Check(seen.Add(Response(row)), "no-byte-loss-or-repeat");
                    reader.Acknowledge();
                }
                Check(seen.Count == 300, "all-batches-read");
                long incrementalBytes = Bytes(reader);
                Targets(reader, 1, true);
                rows = Read(reader);
                Check(
                    rows.Any(row => Response(row) == "replacement"),
                    "new-visible-turn-replays-selected-thread"
                );
                Check(Bytes(reader) > incrementalBytes, "replay-cursor-reset");
                reader.Reset();
                Targets(reader, 0);
                rows = Read(reader);
                Check(
                    rows.Any(row => Response(row) == "replacement"),
                    "page-reload-or-restart-backfill"
                );
                Console.WriteLine(
                    Json.Serialize(
                        new
                        {
                            passed = true,
                            assertions = assertions,
                            sample = rows.First(),
                            health = reader.Health(),
                        }
                    )
                );
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
