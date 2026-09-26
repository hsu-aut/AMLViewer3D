// Plugin-wide log. Every line goes to the Log tab and to a file under
// %TEMP%\aml3d-viewer\, so a problem can be investigated after the editor was
// closed, and a user can send the file instead of describing a blank panel.
//
// The writer stays open with AutoFlush, so a crash still leaves the tail on disk.

using System.IO;
using System.Text;

namespace Aml.Editor.Plugin.Viewer3D.Diagnostics;

public static class PluginLog
{
    private const long MaxBytes = 5 * 1024 * 1024;

    private static readonly object Gate = new();
    private static StreamWriter? _writer;

    /// <summary>Every emitted line, for the Diagnostics tab.</summary>
    public static event Action<string>? OnLine;

    public static string LogDirectory => Path.Combine(Path.GetTempPath(), "aml3d-viewer");

    private static string? _filePath;

    /// <summary>The file written to: the shared one, or one of this process while another editor holds it.</summary>
    public static string FilePath => _filePath ?? Path.Combine(LogDirectory, "aml3d-viewer.log");

    public static bool DebugEnabled { get; set; }

    public static void Init()
    {
        lock (Gate)
        {
            if (_writer != null) return;
            try
            {
                Directory.CreateDirectory(LogDirectory);
                // The editor holds one document per process, so two editors may run at once;
                // the second one writes a file of its own instead of none.
                _writer = Open(Path.Combine(LogDirectory, "aml3d-viewer.log"))
                          ?? Open(Path.Combine(LogDirectory, $"aml3d-viewer-{Environment.ProcessId}.log"));
                _writer?.WriteLine($"==== plugin start {DateTime.Now:yyyy-MM-dd HH:mm:ss} ====");
            }
            catch
            {
                // No file log; the tab still works.
                _writer = null;
            }
        }
    }

    private static StreamWriter? Open(string path)
    {
        try
        {
            // One previous file is kept; older history is not worth the disk.
            if (File.Exists(path) && new FileInfo(path).Length > MaxBytes)
                File.Move(path, path + ".old", overwrite: true);
            var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
            _filePath = path;
            return new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public static void Shutdown()
    {
        lock (Gate)
        {
            try { _writer?.Dispose(); } catch { /* shutting down anyway */ }
            _writer = null;
        }
    }

    public static void Info(string message) => Emit("INFO ", message);

    public static void Warn(string message) => Emit("WARN ", message);

    public static void Debug(string message)
    {
        if (DebugEnabled) Emit("DEBUG", message);
    }

    public static void Error(string message, Exception? ex = null)
    {
        Emit("ERROR", message);
        if (ex != null) Emit("ERROR", "  " + ex);
    }

    private static void Emit(string level, string message)
    {
        // A line from the page may contain line breaks; keep one record per line.
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] [{level}] {message.Replace("\r", "").Replace("\n", " | ")}";
        lock (Gate)
        {
            try { _writer?.WriteLine(line); } catch { _writer = null; }
        }
        try { OnLine?.Invoke(line); } catch { /* a UI handler must not break logging */ }
    }
}
