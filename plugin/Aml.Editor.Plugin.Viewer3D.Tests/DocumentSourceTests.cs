using System.IO.Compression;
using System.Text;
using Aml.Editor.Plugin.Viewer3D.Bridge;
using Xunit;

namespace Aml.Editor.Plugin.Viewer3D.Tests;

// DocumentSource.CacheRoot is static; the tests of this class run one after the other.
public sealed class DocumentSourceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "aml3d-tests-" + Guid.NewGuid().ToString("N")[..8]);

    public DocumentSourceTests()
    {
        Directory.CreateDirectory(_dir);
        DocumentSource.CacheRoot = Path.Combine(_dir, "cache");
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }

    private string Container(string name, params (string Entry, string Text)[] entries)
    {
        var path = Path.Combine(_dir, name);
        using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
        foreach (var (entry, text) in entries)
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open(), new UTF8Encoding(false));
            writer.Write(text);
        }
        return path;
    }

    private const string Rels =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
        "<Relationship Type=\"http://schemas.automationml.org/container/relationship/RootDocument\" Target=\"/model/plant%20cell.aml\" Id=\"R1\" />" +
        "</Relationships>";

    [Fact]
    public void AnAmlFileIsReadFromItsFolder()
    {
        var file = Path.Combine(_dir, "cell.aml");
        File.WriteAllText(file, "<CAEXFile/>");
        var location = DocumentSource.Resolve(file, out var problem);
        Assert.Null(problem);
        Assert.Equal(new DocumentLocation(_dir, "cell.aml"), location);
    }

    [Fact]
    public void AnUnsavedDocumentHasNoFolder()
    {
        Assert.Null(DocumentSource.Resolve(null, out var problem));
        Assert.Contains("not been saved", problem);
    }

    [Fact]
    public void AContainerIsUnpackedAndItsRootDocumentFound()
    {
        var file = Container("cell.amlx",
            ("_rels/.rels", Rels),
            ("model/plant%20cell.aml", "<CAEXFile/>"),
            ("model/geometry/robot%20arm.dae", "<COLLADA/>"),
            ("lib/lib.aml", "<CAEXFile/>"));
        var location = DocumentSource.Resolve(file, out var problem);
        Assert.Null(problem);
        Assert.NotNull(location);
        Assert.Equal("plant cell.aml", location!.FileName);
        Assert.True(File.Exists(Path.Combine(location.Folder, "plant cell.aml")));
        // references are relative to the root document's part: geometry/robot arm.dae
        Assert.True(File.Exists(Path.Combine(location.Folder, "geometry", "robot arm.dae")));
    }

    [Fact]
    public void AContainerWithoutRelationshipsUsesItsOnlyAmlFile()
    {
        var file = Container("plain.amlx", ("doc.aml", "<CAEXFile/>"), ("a.dae", "<COLLADA/>"));
        var location = DocumentSource.Resolve(file, out _);
        Assert.Equal("doc.aml", location?.FileName);
    }

    [Fact]
    public void AContainerIsRecognisedByContentNotName()
    {
        var file = Container("renamed.aml", ("doc.aml", "<CAEXFile/>"));
        Assert.True(DocumentSource.IsContainer(file));
    }

    [Fact]
    public void EntriesCannotEscapeTheCacheFolder()
    {
        var file = Container("evil.amlx", ("doc.aml", "<CAEXFile/>"), ("../../escaped.txt", "x"));
        DocumentSource.Resolve(file, out _);
        Assert.False(File.Exists(Path.Combine(_dir, "escaped.txt")));
        Assert.False(File.Exists(Path.Combine(DocumentSource.CacheRoot, "..", "escaped.txt")));
    }

    [Fact]
    public void AContainerIsUnpackedOnceUntilItChanges()
    {
        var file = Container("once.amlx", ("doc.aml", "<CAEXFile/>"));
        var first = DocumentSource.Resolve(file, out _)!;
        var marker = Path.Combine(first.Folder, "marker.txt");
        File.WriteAllText(marker, "kept");
        Assert.Equal(first, DocumentSource.Resolve(file, out _));
        Assert.True(File.Exists(marker));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddMinutes(1));
        var second = DocumentSource.Resolve(file, out _)!;
        Assert.NotEqual(first.Folder, second.Folder);
    }
}
