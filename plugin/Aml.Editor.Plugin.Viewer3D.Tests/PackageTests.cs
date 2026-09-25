using System.IO.Compression;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Xunit;

namespace Aml.Editor.Plugin.Viewer3D.Tests;

/// <summary>
/// Checks the package the editor installs, before anybody installs it. Each check stands
/// for a failure that is silent inside the editor: the plugin does not show up, or shows
/// an empty panel.
/// </summary>
public class PackageTests
{
    private const string Framework = "lib/net8.0-windows7.0/";
    private const string Project = "Aml.Editor.Plugin.Viewer3D";

    private static string PluginFolder()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, Project);
            if (File.Exists(Path.Combine(candidate, Project + ".csproj"))) return candidate;
        }
        throw new DirectoryNotFoundException(Project + " was not found above " + AppContext.BaseDirectory);
    }

    private static string ProjectVersion() =>
        XDocument.Load(Path.Combine(PluginFolder(), Project + ".csproj")).Descendants("Version").First().Value;

    private static List<string> PackageEntries()
    {
        var build = Path.Combine(PluginFolder(), "..", "build", Project);
        var package = Directory.GetFiles(build, $"{Project}.{ProjectVersion()}.nupkg", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault()
            ?? throw new FileNotFoundException("No package for version " + ProjectVersion() + " under " + build);
        using var zip = ZipFile.OpenRead(package);
        return zip.Entries.Select(e => e.FullName).ToList();
    }

    [Fact]
    public void ThePackageDoesNotShipTheContractAssembly() =>
        Assert.DoesNotContain(PackageEntries(), e => e.EndsWith("Aml.Editor.Plugin.Contract.dll", StringComparison.OrdinalIgnoreCase));

    [Fact]
    public void ThePackageDoesNotShipWhatTheEditorAlreadyLoads()
    {
        Assert.DoesNotContain(PackageEntries(), e => e.EndsWith("/Aml.Engine.dll", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(PackageEntries(), e => e.EndsWith("/Aml.Editor.API.dll", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("Aml.Editor.Plugin.Viewer3D.dll")]
    [InlineData("Microsoft.Web.WebView2.Core.dll")]
    [InlineData("Microsoft.Web.WebView2.Wpf.dll")]
    [InlineData("WebView2Loader.dll")]
    [InlineData("viewer-assets/index.html")]
    public void ThePackageShipsEverythingThePluginNeedsAtRuntime(string file) =>
        Assert.Contains(Framework + file, PackageEntries());

    [Fact]
    public void ThePackageShipsThePageAndItsWorker()
    {
        // The page loads its script and, from there, a separate worker script; a package
        // without the worker shows the page and never finishes loading.
        var assets = PackageEntries().Where(e => e.StartsWith(Framework + "viewer-assets/assets/")).ToList();
        Assert.Contains(assets, e => Regex.IsMatch(e, @"/index-[^/]+\.js$"));
        Assert.Contains(assets, e => Regex.IsMatch(e, @"/worker-[^/]+\.js$"));
    }

    [Fact]
    public void ThePackageCarriesLicenceAndNotices()
    {
        Assert.Contains("THIRD-PARTY-NOTICES.md", PackageEntries());
        Assert.Contains("LICENSE", PackageEntries());
    }

    [Fact]
    public void MetadataAndProjectAgreeOnTheVersion()
    {
        var metadata = XDocument.Load(Path.Combine(PluginFolder(), "Metadata.xml"));
        Assert.Equal(ProjectVersion(), metadata.Descendants("Version").Single().Value);
    }

    [Fact]
    public void TheDisplayNameIsUsableAsAnXmlAndWpfName()
    {
        var metadata = XDocument.Load(Path.Combine(PluginFolder(), "Metadata.xml"));
        var shown = metadata.Descendants("DisplayName").Single().Value;
        Assert.Matches(new Regex("^[A-Za-z_][A-Za-z0-9_]*$"), shown);
        Assert.Contains($"DisplayName = \"{shown}\";", File.ReadAllText(Path.Combine(PluginFolder(), "Viewer3DPlugin.xaml.cs")));
    }

    [Fact]
    public void TheViewerIsBuiltWithRelativePaths()
    {
        // Served from a virtual host inside the plugin folder; absolute asset paths
        // ("/assets/...") would work in the dev server and fail there.
        var index = File.ReadAllText(Path.Combine(PluginFolder(), "..", "..", "dist", "web", "index.html"));
        Assert.DoesNotContain("src=\"/assets/", index);
        Assert.Contains("./assets/", index);
    }
}
