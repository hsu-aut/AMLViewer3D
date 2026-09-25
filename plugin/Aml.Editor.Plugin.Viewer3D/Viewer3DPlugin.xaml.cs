// The AML 3D Viewer plugin for the AutomationML Editor.
//
// Shows the open document with its COLLADA geometry in a WebView2 (the web build of
// this repository) and keeps the selection in step with the editor's tree: a click on
// a part in 3D selects its element in the tree, a click in the tree marks the part.
// The page reads the AML text the editor holds in memory, so Reload shows changes not
// yet saved; the COLLADA files come from the document's folder on disk.

using System.IO;
using System.Windows;
using System.Windows.Media;
using Aml.Editor.Plugin.Contracts;
using Aml.Editor.Plugin.Viewer3D.Bridge;
using Aml.Editor.Plugin.Viewer3D.Diagnostics;
using Aml.Editor.Plugin.WPFBase;
using Aml.Engine.CAEX;
using Aml.Engine.CAEX.Extensions;

namespace Aml.Editor.Plugin.Viewer3D;

public partial class Viewer3DPlugin : PluginViewBase, INotifyAMLDocumentLoad, ISupportsSelection
{
    private const int MaxLogLines = 500;

    private ViewerView? _viewer;
    private CAEXDocument? _document;
    private string? _theme;
    // The element the page just selected in the editor; the editor answers with
    // ChangeSelectedObject for it, which must not go back to the page.
    private string? _selectionFromPage;

    /// <summary>For tests and the probe: the file path the editor API would report.</summary>
    internal string? FilePathOverride { get; set; }

    internal ViewerView? Viewer => _viewer;

    public Viewer3DPlugin()
    {
        InitializeComponent();

        // No dots, slashes or spaces: the editor turns DisplayName into a WPF x:Name
        // and an XML element name in its configuration.
        DisplayName = "AML3DViewer";
        IsReactive = true;

        PluginLog.Init();
        PluginLog.OnLine += AppendLogLine;
        PluginLog.Info($"AML 3D Viewer {typeof(Viewer3DPlugin).Assembly.GetName().Version?.ToString(3)} starting. Log: {PluginLog.FilePath}");
        if (!File.Exists(Path.Combine(ViewerView.AssetsPath, "index.html")))
            PluginLog.Error("The viewer is not next to the plugin: " + ViewerView.AssetsPath);

        // Created in the constructor, not in Loaded: the editor may call DocumentLoaded
        // before the view is loaded.
        CreateViewer();

        Loaded += async (_, _) =>
        {
            try
            {
                await _viewer!.InitAsync();
                if (_document == null && EditorAccess.TryFindOpenDocument() is { } open) Attach(open);
                DocumentSource.CleanCache();
            }
            catch (Exception ex)
            {
                PluginLog.Error("Starting the viewer failed", ex);
                SetStatus("Starting the viewer failed: " + ex.Message);
            }
        };

        // The editor themes itself light or dark through MahApps (Aml.Skins); the contract's
        // theme callback knows only Default and Office2010Blue. So the theme is read from
        // the editor's background whenever the view is shown.
        Loaded += (_, _) => FollowTheme();
        IsVisibleChanged += (_, _) => { if (IsVisible) FollowTheme(); };

        // No Unloaded handler: the editor fires Loaded and Unloaded on every re-parenting
        // (tab switches, docking); DocumentUnLoaded and ApplicationClose end the view.
    }

    // ── plugin identity ─────────────────────────────────────────────────────

    public override string PackageName => "Aml.Editor.Plugin.Viewer3D";

    public override DockPositionEnum InitialDockPosition => DockPositionEnum.DockContent;

    public override bool CanClose => true;

    /// <summary>Raised to make the editor select an element in its tree.</summary>
    public event EventHandler<SelectionEventArgs>? Selected;

    // ── bridge ──────────────────────────────────────────────────────────────

    private void CreateViewer()
    {
        _viewer = new ViewerView(Browser);
        _viewer.Info += PluginLog.Info;
        _viewer.Error += message =>
        {
            PluginLog.Error(message);
            SetStatus(message);
        };
        _viewer.PageLog += (level, message) =>
        {
            if (level == "error") PluginLog.Error("[page] " + message);
            else if (level == "warn") PluginLog.Warn("[page] " + message);
            else PluginLog.Debug("[page] " + message);
        };
        _viewer.Ready += () =>
        {
            // Every boot: the first, a reload, a recovery. Send what is open now.
            SendDocument();
            if (_theme != null) _viewer.SetTheme(_theme);
        };
        _viewer.Loaded += (summary, problems) =>
        {
            foreach (var problem in problems) PluginLog.Warn("[page] " + problem);
            SetStatus(summary == null ? "Shown." : summary + (problems.Count > 0 ? $", {problems.Count} problem(s) in the log." : "."));
        };
        _viewer.Selected += OnPageSelected;
    }

    // ── document lifecycle ──────────────────────────────────────────────────

    /// <summary>Required by the contract, never raised (raising it makes the editor call DocumentLoaded again, in a loop).</summary>
#pragma warning disable CS0067
    public event EventHandler<CAEXDocument>? IsDocumentLoaded;
#pragma warning restore CS0067

    public void DocumentLoaded(CAEXDocument document)
    {
        if (document == null)
        {
            DocumentUnLoaded();
            return;
        }
        if (ReferenceEquals(document, _document)) return;
        Attach(document);
    }

    public void DocumentUnLoaded()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(DocumentUnLoaded);
            return;
        }
        _document = null;
        PlaceholderText.Text = "Open an AML document. Its COLLADA geometry is shown here in 3D.";
        Placeholder.Visibility = Visibility.Visible;
        SetStatus("");
    }

    public void ApplicationClose()
    {
        _viewer?.Dispose();
        _viewer = null;
        PluginLog.Shutdown();
    }

    /// <summary>The editor's callbacks are not documented as UI thread only; WPF and WebView2 are.</summary>
    internal void Attach(CAEXDocument document)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(() => Attach(document));
            return;
        }
        _document = document;
        SendDocument();
    }

    /// <summary>Hands the page the document as the editor holds it now.</summary>
    private void SendDocument()
    {
        if (_document == null || _viewer == null) return;

        var path = FilePathOverride ?? EditorAccess.TryGetFilePath(_document);
        var location = DocumentSource.Resolve(path, out var problem);
        if (location == null)
        {
            PlaceholderText.Text = problem ?? "The document's folder is unknown.";
            Placeholder.Visibility = Visibility.Visible;
            SetStatus(problem ?? "");
            PluginLog.Warn(problem ?? "No location for the document.");
            return;
        }

        string aml;
        try
        {
            using var stream = _document.SaveToStream(false);
            using var reader = new StreamReader(stream);
            aml = reader.ReadToEnd();
        }
        catch (Exception ex)
        {
            PluginLog.Error("Could not read the document from the editor", ex);
            SetStatus("Could not read the document: " + ex.Message);
            return;
        }

        Placeholder.Visibility = Visibility.Collapsed;
        if (_viewer.Open(aml, location.Folder, location.FileName))
        {
            SetStatus($"Loading {location.FileName} …");
            PluginLog.Info($"Showing {location.FileName} from {location.Folder} ({aml.Length / 1024} KB of AML).");
        }
    }

    private void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        if (_document == null && EditorAccess.TryFindOpenDocument() is { } open) _document = open;
        if (_document == null)
        {
            SetStatus("No AML document is open.");
            return;
        }
        SendDocument();
    }

    // ── selection ───────────────────────────────────────────────────────────

    public override void ChangeSelectedObject(CAEXBasicObject selectedObject)
    {
        base.ChangeSelectedObject(selectedObject);
        if (selectedObject == null || _viewer == null) return;

        // Another document selected in the editor: show that one.
        var owner = selectedObject.CAEXDocument;
        if (owner != null && !ReferenceEquals(owner, _document))
        {
            Attach(owner);
            return;
        }

        var id = NearestElementId(selectedObject);
        if (id != null && id == _selectionFromPage)
        {
            _selectionFromPage = null;
            return;
        }
        _selectionFromPage = null;
        _viewer.Select(id);
    }

    /// <summary>The InternalElement a selected object belongs to (an interface or attribute selects its element).</summary>
    internal static string? NearestElementId(CAEXBasicObject? obj)
    {
        for (var o = obj; o != null; o = o.CAEXParent as CAEXBasicObject)
            if (o is InternalElementType element) return element.ID;
        return null;
    }

    private void OnPageSelected(string? id)
    {
        if (_document == null || string.IsNullOrEmpty(id)) return;
        if (_document.FindByID(id) is not InternalElementType element)
        {
            PluginLog.Debug($"The page selected {id}, which is not an InternalElement of the document.");
            return;
        }
        _selectionFromPage = id;
        try
        {
            Selected?.Invoke(this, new ExtendedSelectionEventArgs(element) { Select = true, Expand = true });
        }
        catch (Exception ex)
        {
            PluginLog.Error("The editor refused the selection", ex);
        }
    }

    // ── theme, status, log ──────────────────────────────────────────────────

    private void FollowTheme()
    {
        var theme = IsDark(TryFindResource("MahApps.Brushes.ThemeBackground") ?? Application.Current?.TryFindResource("MahApps.Brushes.ThemeBackground")) ? "dark" : "light";
        if (theme == _theme) return;
        _theme = theme;
        _viewer?.SetTheme(theme);
    }

    /// <summary>A background darker than mid grey means a dark theme; no theme (a test host) means light.</summary>
    internal static bool IsDark(object? background)
    {
        var color = background switch
        {
            SolidColorBrush brush => brush.Color,
            Color c => c,
            _ => Colors.White,
        };
        return 0.2126 * color.R + 0.7152 * color.G + 0.0722 * color.B < 128;
    }

    private void SetStatus(string text) => Dispatcher.Invoke(() => StatusLabel.Text = text);

    private void DebugToggle_Changed(object sender, RoutedEventArgs e) => PluginLog.DebugEnabled = DebugToggle.IsChecked == true;

    private void OpenLogFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(PluginLog.LogDirectory) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            PluginLog.Error("Could not open the log folder", ex);
        }
    }

    private void AppendLogLine(string line) =>
        Dispatcher.BeginInvoke(() =>
        {
            LogBox.AppendText(line + Environment.NewLine);
            if (LogBox.LineCount > MaxLogLines)
                LogBox.Text = LogBox.Text[LogBox.GetCharacterIndexFromLineIndex(LogBox.LineCount - MaxLogLines)..];
            LogBox.ScrollToEnd();
        });
}
