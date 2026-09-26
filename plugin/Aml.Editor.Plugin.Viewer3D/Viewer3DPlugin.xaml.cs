// The AML 3D Viewer plugin for the AutomationML Editor.
//
// Shows the open document with its COLLADA geometry in a WebView2 (the web build of
// this repository) and keeps the selection in step with the editor's tree: a click on
// a part in 3D selects its element in the tree, a click in the tree marks the part.
// The page reads the AML text the editor holds in memory, so Reload shows changes not
// yet saved; the COLLADA files come from the document's folder on disk.
//
// How the editor (6.4) calls plugins, read in its code: every callback arrives on the UI
// thread; a selection the plugin raises is applied without being reported back; the
// trees of external libraries report their selections too, with objects of other
// documents; ApplicationClose is also sent when a plugin makes the editor open another
// document; an exception that reaches the dispatcher ends the editor.

using System.IO;
using System.Reflection;
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
    private const string NoDocument = "Open an AML document. Its COLLADA geometry is shown here in 3D.";

    private readonly ViewerView _viewer;
    private readonly Queue<string> _logLines = new();
    private CAEXDocument? _document;
    private string? _theme;
    // Counts documents sent to the page; "loaded" for an older one is ignored.
    private int _ticket;
    // The element last selected in the editor (or by this plugin), resent after a load.
    private string? _editorSelection;

    /// <summary>For tests and the probe: the file path the editor would report.</summary>
    internal string? FilePathOverride { get; set; }

    internal ViewerView Viewer => _viewer;

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
        _viewer = CreateViewer();
        ShowPlaceholder(NoDocument);

        Loaded += async (_, _) =>
        {
            try
            {
                FollowTheme();
                await _viewer.InitAsync();
                if (_document == null && EditorAccess.TryFindOpenDocument() is { } open) Attach(open);
            }
            catch (Exception ex)
            {
                PluginLog.Error("Starting the viewer failed", ex);
                SetStatus("Starting the viewer failed: " + ex.Message);
            }
        };

        // The editor themes itself light or dark through MahApps (Aml.Skins); the contract's
        // theme callback knows only Default and Office2010Blue. So the theme is read from
        // the editor's background when the view is shown and when the theme changes.
        IsVisibleChanged += (_, _) => { if (IsVisible) FollowTheme(); };
        FollowThemeChanges();

        // No Unloaded handler: the editor fires Loaded and Unloaded on every re-parenting
        // (tab switches, docking).
    }

    // ── plugin identity ─────────────────────────────────────────────────────

    public override string PackageName => "Aml.Editor.Plugin.Viewer3D";

    public override DockPositionEnum InitialDockPosition => DockPositionEnum.DockContent;

    public override bool CanClose => true;

    /// <summary>Raised to make the editor select an element in its tree.</summary>
    public event EventHandler<SelectionEventArgs>? Selected;

    // ── bridge ──────────────────────────────────────────────────────────────

    private ViewerView CreateViewer()
    {
        var viewer = new ViewerView(Browser);
        viewer.Info += PluginLog.Info;
        viewer.Error += message =>
        {
            PluginLog.Error(message);
            SetStatus(message);
        };
        viewer.PageLog += (level, message) =>
        {
            if (level == "error") PluginLog.Error("[page] " + message);
            else if (level == "warn") PluginLog.Warn("[page] " + message);
            else PluginLog.Debug("[page] " + message);
        };
        viewer.Ready += () =>
        {
            // Every boot: the first, a reload, a recovery. Send what is open now.
            if (_theme != null) viewer.SetTheme(_theme);
            SendDocument();
        };
        viewer.Loaded += (ticket, summary, problems) =>
        {
            if (ticket != _ticket) return;                          // an older document finished late
            foreach (var problem in problems) PluginLog.Warn("[page] " + problem);
            SetStatus(summary == null ? "Shown." : summary + (problems.Count > 0 ? $", {problems.Count} problem(s) in the log." : "."));
            if (_editorSelection != null) viewer.Select(_editorSelection);
        };
        viewer.Selected += OnPageSelected;
        return viewer;
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
        try
        {
            _document = null;
            _editorSelection = null;
            _ticket++;
            _viewer.Clear();
            ShowPlaceholder(NoDocument);
            SetStatus("");
        }
        catch (Exception ex)
        {
            PluginLog.Error("Emptying the view failed", ex);
        }
    }

    /// <summary>
    /// Not the end of the view: the editor also sends it when a plugin makes it open
    /// another document, and loads that one next. The page is emptied, the view stays.
    /// </summary>
    public void ApplicationClose() => DocumentUnLoaded();

    /// <summary>The editor's callbacks come on the UI thread; this also holds for tests and other hosts.</summary>
    internal void Attach(CAEXDocument document)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(() => Attach(document));
            return;
        }
        if (!ReferenceEquals(document, _document)) _editorSelection = null;
        _document = document;
        SendDocument();
    }

    /// <summary>
    /// Hands the page the document as the editor holds it now. Unpacking a container can
    /// take seconds, so it runs off the UI thread; the ticket tells whether the document
    /// is still the one to show when it is done.
    /// </summary>
    private async void SendDocument()
    {
        try
        {
            if (_document == null) return;
            if (!_viewer.IsReady) return;                               // sent again on Ready
            var document = _document;
            var ticket = ++_ticket;

            var path = FilePathOverride ?? EditorAccess.TryGetFilePath(document);
            if (path != null && DocumentSource.IsContainer(path)) SetStatus($"Unpacking {Path.GetFileName(path)} …");
            string? problem = null;
            var location = await Task.Run(() => DocumentSource.Resolve(path, out problem));
            if (ticket != _ticket || !ReferenceEquals(document, _document)) return;
            if (location == null)
            {
                _viewer.Clear();
                ShowPlaceholder(problem ?? "The document's folder is unknown.");
                SetStatus(problem ?? "");
                PluginLog.Warn(problem ?? "No location for the document.");
                return;
            }
            DocumentSource.CleanCache(inUse: location.FullFolder);

            string aml;
            using (var stream = document.SaveToStream(false))
            using (var reader = new StreamReader(stream))
                aml = reader.ReadToEnd();

            if (_viewer.Open(aml, location, ticket))
            {
                HidePlaceholder();
                SetStatus($"Loading {location.FileName} …");
                PluginLog.Info($"Showing {location.FileName} from {location.FullFolder} ({aml.Length / 1024} KB of AML).");
            }
        }
        catch (Exception ex)
        {
            PluginLog.Error("Could not hand the document to the viewer", ex);
            SetStatus("Could not show the document: " + ex.Message);
        }
    }

    private void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!_viewer.IsReady)
            {
                // After a failed navigation or a crash: start the page again; Ready sends the document.
                _viewer.ReloadPage();
                SetStatus("Starting the viewer again …");
                return;
            }
            if (_document == null && EditorAccess.TryFindOpenDocument() is { } open) _document = open;
            if (_document == null)
            {
                SetStatus("No AML document is open.");
                return;
            }
            SendDocument();
        }
        catch (Exception ex)
        {
            PluginLog.Error("Reload failed", ex);
            SetStatus("Reload failed: " + ex.Message);
        }
    }

    /// <summary>
    /// WPF cannot draw over a WebView2 (it is a window of its own), so the placeholder is
    /// only visible when the view is hidden.
    /// </summary>
    private void ShowPlaceholder(string text)
    {
        PlaceholderText.Text = text;
        Placeholder.Visibility = Visibility.Visible;
        Browser.Visibility = Visibility.Hidden;
    }

    private void HidePlaceholder()
    {
        Placeholder.Visibility = Visibility.Collapsed;
        Browser.Visibility = Visibility.Visible;
    }

    // ── selection ───────────────────────────────────────────────────────────

    public override void ChangeSelectedObject(CAEXBasicObject selectedObject)
    {
        base.ChangeSelectedObject(selectedObject);
        try
        {
            if (selectedObject == null)
            {
                _editorSelection = null;
                _viewer.Select(null);
                return;
            }
            // Selections in the trees of external libraries carry objects of other
            // documents; they are not what the view shows.
            if (_document != null && !ReferenceEquals(selectedObject.CAEXDocument, _document)) return;

            _editorSelection = NearestElementId(selectedObject);
            _viewer.Select(_editorSelection);
        }
        catch (Exception ex)
        {
            PluginLog.Error("Following the editor's selection failed", ex);
        }
    }

    /// <summary>The InternalElement a selected object belongs to (an interface or attribute selects its element).</summary>
    internal static string? NearestElementId(CAEXBasicObject? obj)
    {
        for (var o = obj; o != null; o = o.CAEXParent as CAEXBasicObject)
            if (o is InternalElementType element) return element.ID;
        return null;
    }

    /// <summary>
    /// The user picked a part in 3D. The editor selects the element without reporting it
    /// back (so nothing needs to be filtered here), and ignores a selection of what is
    /// already selected.
    /// </summary>
    private void OnPageSelected(string? id)
    {
        if (_document == null || string.IsNullOrEmpty(id) || id == _editorSelection) return;
        if (_document.FindByID(id) is not InternalElementType element)
        {
            PluginLog.Debug($"The page selected {id}, which is not an InternalElement of the document.");
            return;
        }
        _editorSelection = id;
        Selected?.Invoke(this, new ExtendedSelectionEventArgs(element) { Select = true, Expand = true });
    }

    // ── theme ───────────────────────────────────────────────────────────────

    private void FollowTheme()
    {
        try
        {
            var theme = IsDark(TryFindResource("MahApps.Brushes.ThemeBackground") ?? Application.Current?.TryFindResource("MahApps.Brushes.ThemeBackground")) ? "dark" : "light";
            if (theme == _theme) return;
            _theme = theme;
            _viewer.SetTheme(theme);
        }
        catch (Exception ex)
        {
            PluginLog.Error("Following the editor's theme failed", ex);
        }
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

    /// <summary>
    /// Subscribes to the editor's theme manager (ControlzEx, loaded by the editor) by
    /// reflection, so that the plugin needs no reference to it and runs without it.
    /// </summary>
    private void FollowThemeChanges()
    {
        try
        {
            var assembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "ControlzEx");
            var managerType = assembly?.GetType("ControlzEx.Theming.ThemeManager");
            var manager = managerType?.GetProperty("Current", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
            var changed = managerType?.GetEvent("ThemeChanged");
            if (manager == null || changed?.EventHandlerType == null) return;
            var argsType = changed.EventHandlerType.GetGenericArguments().FirstOrDefault() ?? typeof(EventArgs);
            var method = typeof(Viewer3DPlugin).GetMethod(nameof(OnThemeManagerChanged), BindingFlags.NonPublic | BindingFlags.Instance)!.MakeGenericMethod(argsType);
            changed.AddEventHandler(manager, Delegate.CreateDelegate(changed.EventHandlerType, this, method));
        }
        catch (Exception ex)
        {
            PluginLog.Debug("Not following theme changes: " + ex.Message);
        }
    }

    private void OnThemeManagerChanged<T>(object? sender, T e) => Dispatcher.BeginInvoke(FollowTheme);

    // ── status, log ─────────────────────────────────────────────────────────

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

    /// <summary>Keeps the last lines; counted here because the text box counts lines only once it has been laid out.</summary>
    private void AppendLogLine(string line) =>
        Dispatcher.BeginInvoke(() =>
        {
            _logLines.Enqueue(line);
            if (_logLines.Count > MaxLogLines)
            {
                while (_logLines.Count > MaxLogLines) _logLines.Dequeue();
                LogBox.Text = string.Join(Environment.NewLine, _logLines) + Environment.NewLine;
            }
            else LogBox.AppendText(line + Environment.NewLine);
            LogBox.ScrollToEnd();
        });
}
