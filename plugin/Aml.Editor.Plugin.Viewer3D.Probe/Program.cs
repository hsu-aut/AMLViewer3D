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
                foreach (var line in Report) Console.WriteLine(line);
                app.Shutdown(_failures == 0 ? 0 : 1);
            }
        });
        return app.Run();
    }

    private static void Pass(string text) => Report.Add("ok    " + text);

    private static void Fail(string text)
    {
        Report.Add("FAIL  " + text);
        _failures++;
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
            Report.Add("      page says: " + await Eval(plugin, "document.getElementById('loading-text')?.textContent"));
            return;
        }
        await Task.Delay(1500);
        var status = Unquote(await Eval(plugin, "document.getElementById('status').textContent"));
        Report.Add("      page status: " + status);
        Check(status.Contains("no problems"), "the page reports no problems");
        Check(Unquote(await Eval(plugin, "document.body.classList.contains('embedded') ? 'yes' : 'no'")) == "yes", "the page hides its own tree inside the editor");
        // The 3D view must fill most of the page. A layout that squeezes it to nothing
        // still passes every other check here (picking works on a zero-width canvas).
        var size = Unquote(await Eval(plugin, "(() => { const c = document.getElementById('view'); return JSON.stringify([c.clientWidth, c.clientHeight, innerWidth, innerHeight]); })()"));
        var dims = JsonSerializer.Deserialize<int[]>(size) ?? new int[4];
        Check(dims[0] > dims[2] / 2 && dims[1] > dims[3] / 2, $"the 3D view fills the page ({dims[0]} x {dims[1]} of {dims[2]} x {dims[3]})");
        await Capture(plugin, Path.Combine(output, "1-shown.png"));

        // 3. A click in 3D selects the element in the editor.
        SelectionEventArgs? fromPage = null;
        plugin.Selected += (_, e) => fromPage = e;
        await Eval(plugin, """
            (() => {
              const c = document.getElementById('view'), r = c.getBoundingClientRect();
              const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 };
              c.dispatchEvent(new PointerEvent('pointerdown', at));
              c.dispatchEvent(new PointerEvent('pointerup', at));
              return 1;
            })()
            """);
        var picked = await Until(() => fromPage != null, TimeSpan.FromSeconds(10));
        var pickedElement = fromPage?.SelectedElement as InternalElementType;
        Check(picked && pickedElement != null, $"a click in 3D selects an element in the editor ({pickedElement?.Name ?? "none"})");
        Check(fromPage is ExtendedSelectionEventArgs { Select: true, Expand: true }, "the editor is asked to select and expand it");
        var shownName = Unquote(await Eval(plugin, "document.querySelector('#details h2')?.textContent ?? ''"));
        Check(pickedElement != null && shownName == pickedElement.Name, $"the page shows the same element ({shownName})");

        // The editor answers with ChangeSelectedObject for that element; it must not come back as a new selection.
        var before = fromPage;
        if (pickedElement != null) plugin.ChangeSelectedObject(pickedElement);
        await Task.Delay(500);
        Check(ReferenceEquals(before, fromPage), "the editor's echo of that selection is not sent back");
        await Capture(plugin, Path.Combine(output, "2-picked.png"));

        // 4. A selection in the editor's tree marks the part in 3D, also through an interface.
        var target = document.CAEXFile.InstanceHierarchy.SelectMany(ih => ih.Descendants<InternalElementType>())
            .FirstOrDefault(ie => ie.Name != pickedElement?.Name && ie.ExternalInterface.Any(i => (i.RefBaseClassPath ?? "").EndsWith("COLLADAInterface")));
        if (target != null)
        {
            plugin.ChangeSelectedObject(target.ExternalInterface.First());
            var marked = await Until(async () => Unquote(await Eval(plugin, "document.querySelector('#details h2')?.textContent ?? ''")) == target.Name, TimeSpan.FromSeconds(10));
            Check(marked, $"selecting '{target.Name}' (through one of its interfaces) in the editor marks it in 3D");
            Check(fromPage == before, "a selection from the editor is not sent back to it");
            await Capture(plugin, Path.Combine(output, "3-selected-in-editor.png"));
        }

        // 5. The editor's dark theme (MahApps) reaches the page when the view is shown again.
        plugin.Resources["MahApps.Brushes.ThemeBackground"] = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x25, 0x25, 0x25));
        plugin.Visibility = Visibility.Collapsed;
        plugin.Visibility = Visibility.Visible;
        var dark = await Until(async () => Unquote(await Eval(plugin, "document.documentElement.dataset.theme ?? ''")) == "dark", TimeSpan.FromSeconds(10));
        Check(dark, "the editor's dark theme reaches the page");
        await Task.Delay(500);
        await Capture(plugin, Path.Combine(output, "4-dark.png"));

        // 6. Reload keeps working and shows the document again.
        plugin.Attach(document);
        Check(await Until(async () => await Eval(plugin, "window.cell ? 1 : 0") == "1", TimeSpan.FromMinutes(5)), "the document can be shown again");
    }

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
        Report.Add("      picture: " + path);
    }

    private static WebView2? FindWebView(DependencyObject root)
    {
        if (root is WebView2 view) return view;
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            if (FindWebView(child) is { } found) return found;
        return null;
    }
}
