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

    private static string Package()
    {
        var build = Path.Combine(PluginFolder(), "..", "build", Project);
        return Directory.GetFiles(build, $"{Project}.{ProjectVersion()}.nupkg", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault()
            ?? throw new FileNotFoundException("No package for version " + ProjectVersion() + " under " + build);
    }

    private static List<string> PackageEntries()
    {
        using var zip = ZipFile.OpenRead(Package());
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
    public void ThePackageShipsTheDotNetBuildOfWebView2()
    {
        // The WebView2 package has a .NET Framework build of the WPF control too; the
        // plugin is compiled against the .NET one (lib_manual/netcoreapp3.0), which
        // AMLOpcUa ships in the same editor. (Core.dll is one file for both.)
        using var zip = ZipFile.OpenRead(Package());
        using var memory = new MemoryStream();
        using (var entry = zip.GetEntry(Framework + "Microsoft.Web.WebView2.Wpf.dll")!.Open()) entry.CopyTo(memory);
        memory.Position = 0;
        using var pe = new System.Reflection.PortableExecutable.PEReader(memory);
        var metadata = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
        var references = metadata.AssemblyReferences.Select(h => metadata.GetString(metadata.GetAssemblyReference(h).Name)).ToList();
        Assert.DoesNotContain("mscorlib", references);
    }

    [Fact]
    public void ThePackageShipsThePageAndItsWorker()
    {
        // The page loads its script and, from there, a separate worker script; a package
        // without the worker shows the page and never finishes loading.
        var assets = PackageEntries().Where(e => e.StartsWith(Framework + "viewer-assets/assets/")).ToList();
        Assert.Contains(assets, e => Regex.IsMatch(e, @"/index-[^/]+\.js$"));
        Assert.Contains(assets, e => Regex.IsMatch(e, @"/worker-[^/]+\.js$"));
    }

    private static string Nuspec()
    {
        using var zip = ZipFile.OpenRead(Package());
        using var reader = new StreamReader(zip.Entries.Single(e => e.FullName.EndsWith(".nuspec")).Open());
        return reader.ReadToEnd();
    }

    [Fact]
    public void ThePackageDeclaresNoDependencies()
    {
        // The PlugIn Manager downloads declared dependencies from nuget.org next to the
        // plugin; without a network the installation fails. Everything the plugin needs is
        // either packed or comes with the editor.
        Assert.DoesNotContain("<dependency ", Nuspec());
    }

    [Fact]
    public void ThePluginIsCompiledAgainstTheAmlEngineOfTheOldestEditor()
    {
        // The plugin runs with the editor's Aml.Engine, and .NET refuses a reference to a
        // newer version than the one loaded. Editor 6.4.3.5 brings 4.5.2; a build against
        // 4.5.3 would not load there.
        using var zip = ZipFile.OpenRead(Package());
        using var memory = new MemoryStream();
        using (var entry = zip.GetEntry(Framework + Project + ".dll")!.Open()) entry.CopyTo(memory);
        memory.Position = 0;
        using var pe = new System.Reflection.PortableExecutable.PEReader(memory);
        var metadata = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
        var engine = metadata.AssemblyReferences.Select(metadata.GetAssemblyReference)
            .Single(r => metadata.GetString(r.Name) == "Aml.Engine");
        Assert.True(engine.Version <= new Version(4, 5, 2, 0), $"compiled against Aml.Engine {engine.Version}");
    }

    [Fact]
    public void TheEditorListsThePackage() =>
        // The PlugIn Manager searches its sources for this tag.
        Assert.Matches(@"<tags>[^<]*\bAMLEditorPlugin\.Net\b", Nuspec());

    [Fact]
    public void ThePackageNamesItsRepository()
    {
        var nuspec = Nuspec();
        Assert.Contains("<projectUrl>https://github.com/hsu-aut/AMLViewer3D</projectUrl>", nuspec);
        Assert.Contains("url=\"https://github.com/hsu-aut/AMLViewer3D\"", nuspec);
    }

    [Fact]
    public void ThePackageHasItsOwnPageWithAbsoluteLinks()
    {
        // nuget.org shows README.md as the package's page; links relative to the
        // repository lead nowhere there.
        Assert.Contains("<readme>README.md</readme>", Nuspec());
        using var zip = ZipFile.OpenRead(Package());
        using var reader = new StreamReader(zip.GetEntry("README.md")!.Open());
        var page = reader.ReadToEnd();
        Assert.Empty(Regex.Matches(page, @"\]\((?!https://)[^)]*\)").Select(m => m.Value));
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
