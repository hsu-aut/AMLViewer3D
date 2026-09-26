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

    private static string Rels(string target) =>
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
        $"<Relationship Type=\"http://schemas.automationml.org/container/relationship/RootDocument\" Target=\"{target}\" Id=\"R1\" />" +
        "</Relationships>";

    /// <summary>Where the page ends up for a reference relative to the document, as a path on disk.</summary>
    private static string Served(DocumentLocation location, string reference) =>
        Path.GetFullPath(Path.Combine(location.FullFolder, reference.Replace('/', Path.DirectorySeparatorChar)));

    private static bool IsServed(DocumentLocation location, string path) =>
        Path.GetFullPath(path).StartsWith(Path.GetFullPath(location.Root), StringComparison.OrdinalIgnoreCase);

    [Fact]
    public void AnAmlFileIsServedFromItsDriveWithItsFolderAsBase()
    {
        var file = Path.Combine(_dir, "cell.aml");
        File.WriteAllText(file, "<CAEXFile/>");
        var location = DocumentSource.Resolve(file, out var problem);
        Assert.Null(problem);
        Assert.NotNull(location);
        Assert.Equal(Path.GetPathRoot(_dir), location!.Root);
        Assert.Equal(Path.GetPathRoot(_dir)![..2].ToUpperInvariant(), location.Drive);
        Assert.Equal("cell.aml", location.FileName);
        Assert.DoesNotContain('\\', location.Folder);
        Assert.Equal(Path.GetFullPath(_dir).TrimEnd(Path.DirectorySeparatorChar), location.FullFolder.TrimEnd(Path.DirectorySeparatorChar));
    }

    [Fact]
    public void ReferencesMayLeaveTheDocumentsFolder()
    {
        var model = Path.Combine(_dir, "model");
        var geometry = Path.Combine(_dir, "geometry");
        Directory.CreateDirectory(model);
        Directory.CreateDirectory(geometry);
        File.WriteAllText(Path.Combine(model, "cell.aml"), "<CAEXFile/>");
        File.WriteAllText(Path.Combine(geometry, "robot.dae"), "<COLLADA/>");

        var location = DocumentSource.Resolve(Path.Combine(model, "cell.aml"), out _)!;
        var target = Served(location, "../geometry/robot.dae");
        Assert.True(File.Exists(target));
        Assert.True(IsServed(location, target));
    }

    [Fact]
    public void AnUnsavedDocumentHasNoFolder()
    {
        Assert.Null(DocumentSource.Resolve(null, out var problem));
        Assert.Contains("not known", problem);
    }

    [Fact]
    public void AMissingFileIsReported()
    {
        Assert.Null(DocumentSource.Resolve(Path.Combine(_dir, "gone.aml"), out var problem));
        Assert.Contains("not found", problem);
    }

    [Fact]
    public void AContainerIsUnpackedAndItsRootDocumentFound()
    {
        var file = Container("cell.amlx",
            ("_rels/.rels", Rels("/model/plant%20cell.aml")),
            ("model/plant%20cell.aml", "<CAEXFile/>"),
            ("model/geometry/robot%20arm.dae", "<COLLADA/>"),
            ("lib/lib.dae", "<COLLADA/>"));
        var location = DocumentSource.Resolve(file, out var problem);
        Assert.Null(problem);
        Assert.NotNull(location);
        Assert.Equal("plant cell.aml", location!.FileName);
        Assert.Equal("model", location.Folder);
        Assert.Null(location.Drive);                                  // paths on a drive do not lead out of a container
        Assert.True(File.Exists(Path.Combine(location.FullFolder, "plant cell.aml")));
        // references are relative to the root document's part: geometry/robot arm.dae
        Assert.True(File.Exists(Served(location, "geometry/robot arm.dae")));
        // and may go up to other parts of the container
        var lib = Served(location, "../lib/lib.dae");
        Assert.True(File.Exists(lib));
        Assert.True(IsServed(location, lib));
    }

    [Fact]
    public void AContainerWithoutRelationshipsUsesItsOnlyAmlFile()
    {
        var file = Container("plain.amlx", ("doc.aml", "<CAEXFile/>"), ("a.dae", "<COLLADA/>"));
        var location = DocumentSource.Resolve(file, out _);
        Assert.Equal("doc.aml", location?.FileName);
        Assert.Equal("", location?.Folder);
    }

    [Fact]
    public void ABrokenRelationshipPartFallsBackToTheOnlyAmlFile()
    {
        var file = Container("broken.amlx", ("_rels/.rels", "<Relationships"), ("doc.aml", "<CAEXFile/>"));
        var location = DocumentSource.Resolve(file, out var problem);
        Assert.Null(problem);
        Assert.Equal("doc.aml", location?.FileName);
    }

    [Fact]
    public void AContainerWithoutADocumentIsAProblemNotACrash()
    {
        var file = Container("empty.amlx", ("a.dae", "<COLLADA/>"), ("b.dae", "<COLLADA/>"));
        Assert.Null(DocumentSource.Resolve(file, out var problem));
        Assert.Contains("no AML document", problem);
    }

    [Fact]
    public void ANamedContainerThatIsNoZipIsAProblemNotACrash()
    {
        var file = Path.Combine(_dir, "fake.amlx");
        File.WriteAllText(file, "not a zip");
        Assert.Null(DocumentSource.Resolve(file, out var problem));
        Assert.NotNull(problem);
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
        var marker = Path.Combine(first.FullFolder, "marker.txt");
        File.WriteAllText(marker, "kept");
        Assert.Equal(first, DocumentSource.Resolve(file, out _));
        Assert.True(File.Exists(marker));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddMinutes(1));
        var second = DocumentSource.Resolve(file, out _)!;
        Assert.NotEqual(first.Root, second.Root);
    }

    [Fact]
    public void ConcurrentResolvesOfOneContainerAgree()
    {
        var file = Container("busy.amlx", ("doc.aml", "<CAEXFile/>"), ("a.dae", "<COLLADA/>"));
        var locations = Enumerable.Range(0, 8).AsParallel().Select(i => DocumentSource.Resolve(file, out _)).ToList();
        Assert.All(locations, l => Assert.Equal(locations[0], l));
        Assert.True(File.Exists(Path.Combine(locations[0]!.FullFolder, "a.dae")));
    }

    [Fact]
    public void TheCacheKeepsWhatIsInUseAndWhatIsRecent()
    {
        var old = DocumentSource.Resolve(Container("old.amlx", ("doc.aml", "<CAEXFile/>")), out _)!;
        var used = DocumentSource.Resolve(Container("used.amlx", ("m/doc.aml", "<CAEXFile/>")), out _)!;
        var recent = DocumentSource.Resolve(Container("recent.amlx", ("doc.aml", "<CAEXFile/>")), out _)!;
        Directory.SetLastWriteTimeUtc(old.Root, DateTime.UtcNow.AddDays(-30));
        Directory.SetLastWriteTimeUtc(used.Root, DateTime.UtcNow.AddDays(-30));

        DocumentSource.RemoveUnused(inUse: used.FullFolder, TimeSpan.FromDays(7));

        Assert.False(Directory.Exists(old.Root));
        Assert.True(Directory.Exists(used.Root));
        Assert.True(Directory.Exists(recent.Root));
    }
}
