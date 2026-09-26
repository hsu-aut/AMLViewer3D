using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace Aml.Editor.Plugin.Viewer3D.Bridge;

/// <summary>Where the page finds the files an AML document refers to.</summary>
/// <param name="Root">The folder served to the page: the drive of an .aml file, or the unpacked container.</param>
/// <param name="Folder">The document's folder below the root, with '/' separators (empty for the root itself).</param>
/// <param name="FileName">The AML file's name in that folder.</param>
/// <param name="Drive">The drive the root is ("C:"), when a whole drive is served; the page
/// then reads references written as paths on that drive.</param>
public sealed record DocumentLocation(string Root, string Folder, string FileName, string? Drive = null)
{
    /// <summary>The folder on disk the references are relative to.</summary>
    public string FullFolder => Path.Combine(Root, Folder.Replace('/', Path.DirectorySeparatorChar));
}

/// <summary>
/// Finds the folder the COLLADA references of a document are relative to, and what to
/// serve so that they resolve. References may leave the document's folder ("../dae/x.dae"),
/// so for an .aml file the whole drive is served and the document's folder is the base;
/// the page only reads files through this host and cannot navigate elsewhere. An .amlx
/// container is unpacked once into a cache folder (keyed by path, size and time), which
/// is served as a whole; the base is the folder of its root document.
/// </summary>
public static class DocumentSource
{
    public static string CacheRoot { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AmlViewer3D", "amlx");

    /// <summary>The location, or null with the reason for the user. Never throws.</summary>
    public static DocumentLocation? Resolve(string? filePath, out string? problem)
    {
        problem = null;
        try
        {
            if (string.IsNullOrWhiteSpace(filePath))
            {
                problem = "The folder of this document is not known (not saved yet, or opened in a way the editor does not report). Save it and press Reload.";
                return null;
            }
            if (!File.Exists(filePath))
            {
                problem = $"The document's file was not found: {filePath}";
                return null;
            }
            if (IsContainer(filePath)) return Unpack(filePath);

            var full = Path.GetFullPath(filePath);
            var root = Path.GetPathRoot(full)!;
            var folder = Path.GetRelativePath(root, Path.GetDirectoryName(full)!).Replace(Path.DirectorySeparatorChar, '/');
            var drive = root.Length >= 2 && root[1] == ':' ? root[..2].ToUpperInvariant() : null;   // not for a network share
            return new DocumentLocation(root, folder == "." ? "" : folder, Path.GetFileName(full), drive);
        }
        catch (Exception ex)
        {
            problem = $"The document's files could not be prepared: {ex.Message}";
            return null;
        }
    }

    /// <summary>AMLX containers are ZIP files; the name alone is not trusted.</summary>
    public static bool IsContainer(string filePath)
    {
        if (filePath.EndsWith(".amlx", StringComparison.OrdinalIgnoreCase)) return true;
        try
        {
            using var stream = File.OpenRead(filePath);
            Span<byte> head = stackalloc byte[4];
            return stream.Read(head) == 4 && head[0] == (byte)'P' && head[1] == (byte)'K' && head[2] == 3 && head[3] == 4;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    // Resolve runs off the UI thread; a Reload during an unpack must not unpack the same container twice.
    private static readonly object UnpackLock = new();

    public static DocumentLocation Unpack(string containerPath)
    {
        lock (UnpackLock) return UnpackLocked(containerPath);
    }

    private static DocumentLocation UnpackLocked(string containerPath)
    {
        var info = new FileInfo(containerPath);
        var key = Hash($"{info.FullName.ToLowerInvariant()}|{info.Length}|{info.LastWriteTimeUtc.Ticks}");
        var target = Path.Combine(CacheRoot, key);
        var done = Path.Combine(target, ".complete");

        using var zip = ZipFile.OpenRead(containerPath);
        if (!File.Exists(done))
        {
            if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
            Directory.CreateDirectory(target);
            var root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
            foreach (var entry in zip.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) continue;                     // a folder entry
                // Part names in OPC packages are URI-encoded (a space is %20).
                var relative = Uri.UnescapeDataString(entry.FullName).Replace('/', Path.DirectorySeparatorChar);
                var path = Path.GetFullPath(Path.Combine(target, relative));
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;   // no way out of the folder
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                entry.ExtractToFile(path, overwrite: true);
            }
            File.WriteAllText(done, containerPath);
        }
        // Marks the folder as used, so that CleanCache keeps it.
        Directory.SetLastWriteTimeUtc(target, DateTime.UtcNow);

        var rootDocument = RootDocument(zip) ?? throw new InvalidDataException("The container holds no AML document.");
        var parts = rootDocument.TrimStart('/').Split('/');
        return new DocumentLocation(target, string.Join('/', parts[..^1]), parts[^1]);
    }

    /// <summary>
    /// The root document's part name: the target of the RootDocument relationship in
    /// _rels/.rels, else the only .aml file in the container.
    /// </summary>
    public static string? RootDocument(ZipArchive zip)
    {
        var rels = zip.Entries.FirstOrDefault(e => e.FullName.Equals("_rels/.rels", StringComparison.OrdinalIgnoreCase));
        if (rels != null)
        {
            try
            {
                using var stream = rels.Open();
                var target = XDocument.Load(stream).Root?.Elements()
                    .FirstOrDefault(r => ((string?)r.Attribute("Type") ?? "").EndsWith("RootDocument", StringComparison.OrdinalIgnoreCase))
                    ?.Attribute("Target")?.Value;
                if (!string.IsNullOrEmpty(target)) return Uri.UnescapeDataString(target.TrimStart('/'));
            }
            catch (XmlException)
            {
                // A broken relationship part; fall back to the only .aml file.
            }
        }
        var amls = zip.Entries.Where(e => e.FullName.EndsWith(".aml", StringComparison.OrdinalIgnoreCase)).ToList();
        return amls.Count == 1 ? Uri.UnescapeDataString(amls[0].FullName) : null;
    }

    private static bool _cleaned;

    /// <summary>
    /// Once per editor session: removes unpacked containers not used for a week, except
    /// the one in use.
    /// </summary>
    public static void CleanCache(string? inUse = null)
    {
        if (_cleaned) return;
        _cleaned = true;
        RemoveUnused(inUse, TimeSpan.FromDays(7));
    }

    internal static void RemoveUnused(string? inUse, TimeSpan age)
    {
        DirectoryInfo[] dirs;
        try
        {
            if (!Directory.Exists(CacheRoot)) return;
            dirs = new DirectoryInfo(CacheRoot).GetDirectories();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return;
        }
        var used = inUse == null ? null : Path.GetFullPath(inUse) + Path.DirectorySeparatorChar;
        foreach (var dir in dirs)
        {
            if (used != null && used.StartsWith(dir.FullName + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
            if (dir.LastWriteTimeUtc >= DateTime.UtcNow - age) continue;
            try
            {
                dir.Delete(recursive: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // In use by another editor window; next session.
            }
        }
    }

    private static string Hash(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant();
}
