using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

namespace Aml.Editor.Plugin.Viewer3D.Bridge;

/// <summary>Where the page finds the files an AML document refers to.</summary>
/// <param name="Folder">The folder the references are relative to.</param>
/// <param name="FileName">The AML file's name in that folder.</param>
public sealed record DocumentLocation(string Folder, string FileName);

/// <summary>
/// Finds the folder the COLLADA references of a document are relative to. For an .aml
/// file it is the file's folder. An .amlx container is unpacked once into a cache folder
/// (keyed by path, size and time), and the folder of its root document is used.
/// </summary>
public static class DocumentSource
{
    public static string CacheRoot { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AmlViewer3D", "amlx");

    /// <summary>The location, or null with the reason for the user.</summary>
    public static DocumentLocation? Resolve(string? filePath, out string? problem)
    {
        problem = null;
        if (string.IsNullOrWhiteSpace(filePath))
        {
            problem = "The document has not been saved yet, so the files it refers to cannot be found. Save it and press Reload.";
            return null;
        }
        if (!File.Exists(filePath))
        {
            problem = $"The document's file was not found: {filePath}";
            return null;
        }
        if (!IsContainer(filePath)) return new DocumentLocation(Path.GetDirectoryName(Path.GetFullPath(filePath))!, Path.GetFileName(filePath));

        try
        {
            return Unpack(filePath);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException)
        {
            problem = $"The container could not be unpacked: {ex.Message}";
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
        catch (IOException)
        {
            return false;
        }
    }

    public static DocumentLocation Unpack(string containerPath)
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

        var rootDocument = RootDocument(zip) ?? throw new InvalidDataException("The container holds no AML document.");
        var full = Path.GetFullPath(Path.Combine(target, rootDocument.Replace('/', Path.DirectorySeparatorChar)));
        return new DocumentLocation(Path.GetDirectoryName(full)!, Path.GetFileName(full));
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
            using var stream = rels.Open();
            var target = XDocument.Load(stream).Root?.Elements()
                .FirstOrDefault(r => ((string?)r.Attribute("Type") ?? "").EndsWith("RootDocument", StringComparison.OrdinalIgnoreCase))
                ?.Attribute("Target")?.Value;
            if (!string.IsNullOrEmpty(target)) return Uri.UnescapeDataString(target.TrimStart('/'));
        }
        var amls = zip.Entries.Where(e => e.FullName.EndsWith(".aml", StringComparison.OrdinalIgnoreCase)).ToList();
        return amls.Count == 1 ? Uri.UnescapeDataString(amls[0].FullName) : null;
    }

    /// <summary>Removes unpacked containers not used for a week.</summary>
    public static void CleanCache()
    {
        try
        {
            if (!Directory.Exists(CacheRoot)) return;
            foreach (var dir in new DirectoryInfo(CacheRoot).GetDirectories())
                if (dir.LastWriteTimeUtc < DateTime.UtcNow.AddDays(-7)) dir.Delete(recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // In use by another editor window; next time.
        }
    }

    private static string Hash(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant();
}
