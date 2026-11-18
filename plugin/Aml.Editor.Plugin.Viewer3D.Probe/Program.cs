// Hosts the AML 3D Viewer plugin in a window of its own and drives it like the editor:
// hands over a document, waits for the page to show it, selects in both directions,
// and writes pictures of the page and a report. Exit code 0 when every check passed.
//
//   dotnet run --project plugin/Aml.Editor.Plugin.Viewer3D.Probe -- <file.aml|.amlx> [output folder]

using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Aml.Editor.Plugin.Contracts;
using Aml.Editor.Plugin.Viewer3D;
using Aml.Engine.CAEX;
using Aml.Engine.CAEX.Extensions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

internal static class Program
{
    private static readonly List<string> Report = new();
    private static int _failures;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: probe <file.aml|.amlx> [output folder]");
            return 2;
        }
        var file = Path.GetFullPath(args[0]);
        var output = Path.GetFullPath(args.Length > 1 ? args[1] : "probe-output");
        Directory.CreateDirectory(output);

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var plugin = new Viewer3DPlugin();
        var window = new Window { Title = "AML 3D Viewer probe", Width = 1400, Height = 850, Content = plugin };
        window.Show();

        app.Dispatcher.InvokeAsync(async () =>
        {
            try
            {
                await Run(plugin, file, output);
            }
            catch (Exception ex)
            {
                Fail("probe crashed: " + ex);
            }
            finally
            {
                File.WriteAllLines(Path.Combine(output, "report.txt"), Report);
                app.Shutdown(_failures == 0 ? 0 : 1);
            }
        });
        return app.Run();
    }

    private static void Pass(string text) => Line("ok    " + text);

    private static void Fail(string text)
    {
        Line("FAIL  " + text);
        _failures++;
    }

    /// <summary>Written at once, so that a probe that hangs shows how far it got.</summary>
    private static void Line(string text)
    {
        Report.Add(text);
        Console.WriteLine(text);
        Console.Out.Flush();
    }

    private static void Check(bool ok, string text)
    {
        if (ok) Pass(text); else Fail(text);
    }

    private static async Task Run(Viewer3DPlugin plugin, string file, string output)
    {
        // 1. The page boots in the plugin's WebView2.
        var ready = await Until(() => plugin.Viewer?.IsReady == true, TimeSpan.FromSeconds(60));
        Check(ready, "the page announced itself (ready)");
        if (!ready) return;

        // The probe is built in the plugin's configuration: F12 opens the developer tools
        // in a Debug build only.
#if DEBUG
        const bool debugBuild = true;
#else
        const bool debugBuild = false;
#endif
        Check(FindWebView(plugin)?.CoreWebView2?.Settings.AreDevToolsEnabled == debugBuild,
            debugBuild ? "the developer tools are on (Debug build)" : "the developer tools are off (Release build)");

        // 2. The editor hands over a document.
        var document = file.EndsWith(".amlx", StringComparison.OrdinalIgnoreCase)
            ? LoadContainer(file)
            : CAEXDocument.LoadFromFile(file);
        plugin.FilePathOverride = file;
        var t0 = DateTime.Now;
        plugin.DocumentLoaded(document);

        var shown = await Until(async () => await Eval(plugin, "window.cell ? 1 : 0") == "1", TimeSpan.FromMinutes(5));
        Check(shown, $"the document is shown ({(DateTime.Now - t0).TotalSeconds:0.0} s)");
        if (!shown)
        {
            Line("      page says: " + await Eval(plugin, "document.getElementById('loading-text')?.textContent"));
            return;
        }
        await Task.Delay(1500);
        var status = Unquote(await Eval(plugin, "document.getElementById('status').textContent"));
        Line("      page status: " + status);
        Check(status.Contains("no problems"), "the page reports no problems");
        Check(Unquote(await Eval(plugin, "document.body.classList.contains('embedded') ? 'yes' : 'no'")) == "yes", "the page hides its own tree inside the editor");
        // The 3D view must fill most of the page. A layout that squeezes it to nothing
        // still passes every other check here (picking works on a zero-width canvas).
        var size = Unquote(await Eval(plugin, "(() => { const c = document.getElementById('view'); return JSON.stringify([c.clientWidth, c.clientHeight, innerWidth, innerHeight]); })()"));
        var dims = JsonSerializer.Deserialize<int[]>(size) ?? new int[4];
        Check(dims[0] > dims[2] / 2 && dims[1] > dims[3] / 2, $"the 3D view fills the page ({dims[0]} x {dims[1]} of {dims[2]} x {dims[3]})");
        await Capture(plugin, Path.Combine(output, "1-shown.png"));

        // 3. A click in 3D selects the element in the editor. (The editor applies it without
        //    reporting it back, so there is no echo to test.)
        SelectionEventArgs? fromPage = null;
        plugin.Selected += (_, e) => fromPage = e;
        // Clicks from the middle of the view outwards until one hits a part (a click on
        // empty space changes nothing inside the editor).
        var at = Unquote(await Eval(plugin, """
            (() => {
              const c = document.getElementById('view'), r = c.getBoundingClientRect();
              const points = [];
              for (let j = 1; j < 24; j++) for (let i = 1; i < 40; i++) points.push([i / 40, j / 24]);
              points.sort((a, b) => Math.hypot(a[0] - 0.5, a[1] - 0.5) - Math.hypot(b[0] - 0.5, b[1] - 0.5));
              for (const [x, y] of points) {
                const at = { clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true, pointerId: 1 };
                c.dispatchEvent(new PointerEvent('pointerdown', at));
                c.dispatchEvent(new PointerEvent('pointerup', at));
                if (document.querySelector('#details h2')) return `${x.toFixed(2)}, ${y.toFixed(2)}`;
              }
              return 'nowhere';
            })()
            """));
        var picked = await Until(() => fromPage != null, TimeSpan.FromSeconds(10));
        Line("      clicked at " + at);
        var pickedElement = fromPage?.SelectedElement as InternalElementType;
        Check(picked && pickedElement != null, $"a click in 3D selects an element in the editor ({pickedElement?.Name ?? "none"})");
        Check(fromPage is ExtendedSelectionEventArgs { Select: true, Expand: true }, "the editor is asked to select and expand it");
        var shownName = await Shown(plugin);
        Check(pickedElement != null && shownName == pickedElement.Name, $"the page shows the same element ({shownName})");
        await Capture(plugin, Path.Combine(output, "2-picked.png"));

        // A click on empty space leaves the selection alone, here and in the editor.
        var before = fromPage;
        await Click(plugin, 0.01, 0.01);
        await Task.Delay(500);
        Check(ReferenceEquals(before, fromPage) && await Shown(plugin) == shownName, "a click on empty space keeps the selection");

        // 4. A selection in the editor's tree marks the part in 3D, also through an interface.
        var target = document.CAEXFile.InstanceHierarchy.SelectMany(ih => ih.Descendants<InternalElementType>())
            .FirstOrDefault(ie => ie.Name != pickedElement?.Name && ie.ExternalInterface.Any(i => (i.RefBaseClassPath ?? "").EndsWith("COLLADAInterface")));
        if (target != null)
        {
            plugin.ChangeSelectedObject(target.ExternalInterface.First());
            var marked = await Until(async () => await Shown(plugin) == target.Name, TimeSpan.FromSeconds(10));
            Check(marked, $"selecting '{target.Name}' (through one of its interfaces) in the editor marks it in 3D");
            Check(fromPage == before, "a selection from the editor is not sent back to it");
            await Capture(plugin, Path.Combine(output, "3-selected-in-editor.png"));

            // The trees of external libraries report selections too, with objects of other documents.
            var library = CAEXDocument.New_CAEXDocument();
            var foreign = library.CAEXFile.InstanceHierarchy.Append("Library").InternalElement.Append("Somewhere else");
            plugin.ChangeSelectedObject(foreign);
            await Task.Delay(500);
            Check(await Shown(plugin) == target.Name && fromPage == before, "a selection in another document's tree is ignored");
        }

        // 5. The editor's dark theme (MahApps) reaches the page when the view is shown again.
        plugin.Resources["MahApps.Brushes.ThemeBackground"] = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x25, 0x25, 0x25));
        plugin.Resources["MahApps.Brushes.ThemeForeground"] = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Colors.White);
        plugin.Visibility = Visibility.Collapsed;
        plugin.Visibility = Visibility.Visible;
        var dark = await Until(async () => Unquote(await Eval(plugin, "document.documentElement.dataset.theme ?? ''")) == "dark", TimeSpan.FromSeconds(10));
        Check(dark, "the editor's dark theme reaches the page");
        await Task.Delay(500);
        await Capture(plugin, Path.Combine(output, "4-dark.png"));

        // 6. Reload shows the document again; what the editor selects meanwhile is shown after loading.
        var loads = 0;
        plugin.Viewer!.Loaded += (_, _, _) => loads++;
        var during = document.CAEXFile.InstanceHierarchy.SelectMany(ih => ih.Descendants<InternalElementType>())
            .FirstOrDefault(ie => ie.Name != target?.Name && ie.ExternalInterface.Any(i => (i.RefBaseClassPath ?? "").EndsWith("COLLADAInterface")));
        t0 = DateTime.Now;
        plugin.Attach(document);
        await Task.Delay(200);
        if (during != null) plugin.ChangeSelectedObject(during);
        var again = await Until(() => loads == 1, TimeSpan.FromMinutes(5));
        var single = DateTime.Now - t0;
        Check(again, $"the document can be shown again ({single.TotalSeconds:0.0} s)");
        if (during != null)
            Check(await Until(async () => await Shown(plugin) == during.Name, TimeSpan.FromSeconds(5)), $"'{during.Name}', selected in the editor while loading, is marked after loading");

        // 7. Reload pressed three times in a row: the page finishes one load, not three.
        loads = 0;
        t0 = DateTime.Now;
        for (var i = 0; i < 3; i++)
        {
            plugin.Attach(document);
            await Task.Delay(700);
        }
        var burst = await Until(() => loads >= 1, TimeSpan.FromMinutes(5));
        var took = DateTime.Now - t0;
        await Task.Delay(3000);
        if (single > TimeSpan.FromSeconds(2))
        {
            Check(burst && loads == 1, $"three quick reloads end in one load ({loads} reported, {took.TotalSeconds:0.0} s; one load took {single.TotalSeconds:0.0} s)");
            Check(took < single * 2 + TimeSpan.FromSeconds(3), "and take about as long as one");
        }
        else Line($"      three quick reloads not checked: one load takes only {single.TotalSeconds:0.0} s ({loads} reported)");

        // 8. The page cannot be navigated away from the viewer.
        await Eval(plugin, "location.href = 'https://example.com/'; 1");
        await Task.Delay(1500);
        Check(Unquote(await Eval(plugin, "location.host")) == Aml.Editor.Plugin.Viewer3D.Bridge.ViewerView.ViewerHost && plugin.Viewer.IsReady,
            "a link out of the page is blocked and the viewer stays");

        // 9. The editor closes the document: the page empties and the placeholder shows.
        plugin.DocumentUnLoaded();
        var cleared = await Until(async () => await Eval(plugin, "window.cell ? 1 : 0") == "0", TimeSpan.FromSeconds(10));
        Check(cleared && plugin.Placeholder.Visibility == Visibility.Visible && plugin.Browser.Visibility != Visibility.Visible,
            "closing the document empties the page and shows the placeholder");
        // CapturePreview does not return while the view is hidden; the placeholder is WPF anyway.
        CaptureWpf(plugin, Path.Combine(output, "5-closed.png"));
        plugin.DocumentLoaded(document);
        var reopened = await Until(async () => await Eval(plugin, "window.cell ? 1 : 0") == "1", TimeSpan.FromMinutes(2));
        Check(reopened && plugin.Browser.Visibility == Visibility.Visible, "a document opened after that is shown");
        if (!reopened)
            Line($"      ready: {plugin.Viewer.IsReady}, page: {await Eval(plugin, "location.href + ' | ' + document.getElementById('loading-text')?.textContent")}, status: {plugin.StatusLabel.Text}");
    }

    /// <summary>A click at a point of the 3D view, given as a fraction of its width and height.</summary>
    private static Task<string> Click(Viewer3DPlugin plugin, double x, double y) =>
        Eval(plugin, $$"""
            (() => {
              const c = document.getElementById('view'), r = c.getBoundingClientRect();
              const at = { clientX: r.left + r.width * {{x.ToString(System.Globalization.CultureInfo.InvariantCulture)}}, clientY: r.top + r.height * {{y.ToString(System.Globalization.CultureInfo.InvariantCulture)}}, bubbles: true, pointerId: 1 };
              c.dispatchEvent(new PointerEvent('pointerdown', at));
              c.dispatchEvent(new PointerEvent('pointerup', at));
              return 1;
            })()
            """);

    /// <summary>The name of the element the page shows as selected.</summary>
    private static async Task<string> Shown(Viewer3DPlugin plugin) =>
        Unquote(await Eval(plugin, "document.querySelector('#details h2')?.textContent ?? ''"));

    private static CAEXDocument LoadContainer(string path)
    {
        using var container = new Aml.Engine.AmlObjects.AutomationMLContainer(path, FileMode.Open, FileAccess.Read);
        using var stream = container.RootDocumentStream();
        return CAEXDocument.LoadFromStream(stream);
    }

    private static async Task<string> Eval(Viewer3DPlugin plugin, string script) =>
        plugin.Viewer == null ? "null" : await plugin.Viewer.EvaluateAsync(script);

    private static string Unquote(string json) =>
        json.StartsWith('"') ? JsonSerializer.Deserialize<string>(json) ?? "" : json;

    private static async Task<bool> Until(Func<bool> condition, TimeSpan timeout) =>
        await Until(() => Task.FromResult(condition()), timeout);

    private static async Task<bool> Until(Func<Task<bool>> condition, TimeSpan timeout)
    {
        var end = DateTime.Now + timeout;
        while (DateTime.Now < end)
        {
            if (await condition()) return true;
            await Task.Delay(250);
        }
        return false;
    }

    /// <summary>A picture of the page. RenderTargetBitmap does not see WebView2 content; CapturePreview does.</summary>
    private static async Task Capture(Viewer3DPlugin plugin, string path)
    {
        var view = FindWebView(plugin);
        if (view?.CoreWebView2 == null) return;
        await using var file = File.Create(path);
        await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
        Line("      picture: " + path);
    }

    private static void CaptureWpf(FrameworkElement element, string path)
    {
        var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap((int)element.ActualWidth, (int)element.ActualHeight, 96, 96, System.Windows.Media.PixelFormats.Pbgra32);
        bitmap.Render(element);
        var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
        encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
        using var file = File.Create(path);
        encoder.Save(file);
        Line("      picture: " + path);
    }

    private static WebView2? FindWebView(DependencyObject root)
    {
        if (root is WebView2 view) return view;
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            if (FindWebView(child) is { } found) return found;
        return null;
    }
}
