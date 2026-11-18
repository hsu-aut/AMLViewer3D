using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Aml.Editor.Plugin.Viewer3D.Bridge;

/// <summary>
/// Owns the WebView2 that shows the viewer and the message protocol with it.
///
/// Rules kept from the plugin playbook (learned in AMLFPB.js and AMLPetriNet):
/// <list type="bullet">
/// <item>The page is ready when it says so ("ready"), not when navigation completes;
/// a message posted before its listener exists is lost.</item>
/// <item>A reload or a renderer crash makes the page not ready again.</item>
/// <item>A document is not buffered here: the host answers every Ready by sending the
/// document it has now. Selection and theme are buffered.</item>
/// </list>
///
/// Two virtual hosts: the viewer's files, and the folder tree the open document's files
/// are in (see DocumentSource). The page loads the COLLADA files from the second one, in
/// Web Workers; access across the two origins is allowed for these two only. The view
/// never leaves the viewer: dropped files and links do not navigate it.
/// </summary>
public sealed class ViewerView : IDisposable
{
    public const string ViewerHost = "aml3d-viewer.local";
    public const string DocumentHost = "aml3d-document.local";
    public const string AssetsFolder = "viewer-assets";

    private readonly WebView2 _view;
    private Task? _init;
    private bool _ready;
    private bool _disposed;
    private string? _mappedRoot;

    private string? _pendingSelection;
    private bool _hasPendingSelection;
    private string? _pendingTheme;

    private EventHandler<CoreWebView2WebMessageReceivedEventArgs>? _onMessage;
    private EventHandler<CoreWebView2NavigationStartingEventArgs>? _onNavigationStarting;
    private EventHandler<CoreWebView2NavigationCompletedEventArgs>? _onNavigationCompleted;
    private EventHandler<CoreWebView2ProcessFailedEventArgs>? _onProcessFailed;
    private EventHandler<CoreWebView2NewWindowRequestedEventArgs>? _onNewWindow;

    public ViewerView(WebView2 view) => _view = view;

    /// <summary>The page booted (first load, reload, recovery).</summary>
    public event Action? Ready;

    /// <summary>A document is shown: the ticket it was sent with, what the page counted, what it could not resolve.</summary>
    public event Action<int, LoadSummary?, IReadOnlyList<string>>? Loaded;

    /// <summary>The user picked an element in the page (null: nothing).</summary>
    public event Action<string?>? Selected;

    public event Action<string>? Error;
    public event Action<string>? Info;
    public event Action<string, string>? PageLog;

    public bool IsReady => _ready;

    /// <summary>WebView2's profile. Next to the editor's executable it may not be writable.</summary>
    public static string UserDataFolder =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AmlViewer3D", "WebView2");

    public static string AssetsPath
    {
        get
        {
            var location = typeof(ViewerView).Assembly.Location;
            var directory = string.IsNullOrEmpty(location) ? null : Path.GetDirectoryName(location);
            return Path.Combine(directory ?? AppContext.BaseDirectory, AssetsFolder);
        }
    }

    /// <summary>Starts the view once; later calls (the editor fires Loaded on every re-parenting) wait for the same start.</summary>
    public Task InitAsync() => _init ??= StartAsync();

    private async Task StartAsync()
    {
        if (_disposed) return;
        try
        {
            // Must be set before the first EnsureCoreWebView2Async.
            _view.CreationProperties ??= new CoreWebView2CreationProperties { UserDataFolder = UserDataFolder };
            _view.AllowExternalDrop = false;
            await _view.EnsureCoreWebView2Async();
        }
        catch (Exception ex)
        {
            RaiseError("The WebView2 runtime is missing or failed to start: " + ex.Message);
            return;
        }
        if (_disposed) return;

        var assets = AssetsPath;
        if (!File.Exists(Path.Combine(assets, "index.html")))
        {
            RaiseError($"The viewer is missing in {assets}. Was 'npm run build' run before packing?");
            return;
        }

        var core = _view.CoreWebView2;
        // F12 and "Inspect" only while developing; the remote debugging port that the
        // editor tests use (plugin/editor-test) does not depend on this.
#if DEBUG
        core.Settings.AreDevToolsEnabled = true;
#else
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.Settings.IsStatusBarEnabled = false;
        core.SetVirtualHostNameToFolderMapping(ViewerHost, assets, CoreWebView2HostResourceAccessKind.Allow);

        _onMessage = (_, e) => OnMessage(e.Source, e.WebMessageAsJson);
        _onNavigationStarting = (_, e) =>
        {
            // Only the viewer itself; a dropped file or a link must not replace it.
            if (!IsViewerUrl(e.Uri))
            {
                e.Cancel = true;
                Info?.Invoke("Blocked navigation to " + e.Uri);
                return;
            }
            _ready = false;
        };
        _onNavigationCompleted = (_, e) =>
        {
            // A navigation cancelled above also ends here; the page it wanted to replace stays.
            if (e.IsSuccess || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
            _ready = false;
            RaiseError("Navigation failed: " + e.WebErrorStatus);
        };
        _onProcessFailed = (_, e) =>
        {
            _ready = false;
            RaiseError($"The WebView2 process failed ({e.ProcessFailedKind}).");
            if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited
                or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                _view.Dispatcher.BeginInvoke(() => core.Reload());
            }
        };
        _onNewWindow = (_, e) => e.Handled = true;
        core.WebMessageReceived += _onMessage;
        core.NavigationStarting += _onNavigationStarting;
        core.NavigationCompleted += _onNavigationCompleted;
        core.ProcessFailed += _onProcessFailed;
        core.NewWindowRequested += _onNewWindow;

        core.Navigate(StartUrl);
    }

    private static string StartUrl => $"https://{ViewerHost}/index.html";

    private static bool IsViewerUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps
        && string.Equals(uri.Host, ViewerHost, StringComparison.OrdinalIgnoreCase);

    /// <summary>Loads the page again when it is not ready (after a failed navigation or a crash).</summary>
    public void ReloadPage()
    {
        if (_disposed || _view.CoreWebView2 == null) return;
        _view.CoreWebView2.Navigate(StartUrl);
    }

    /// <summary>
    /// Shows a document: its AML text and where its references are. The ticket comes
    /// back with "loaded", so that a late answer for an older document can be told apart.
    /// Returns false when the page is not ready; the host sends it again on Ready.
    /// </summary>
    public bool Open(string aml, DocumentLocation location, int ticket)
    {
        if (_disposed || !_ready || _view.CoreWebView2 == null) return false;
        MapDocumentRoot(location.Root);
        var folder = string.Join('/', location.Folder.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.EscapeDataString));
        var @base = $"https://{DocumentHost}/" + (folder.Length > 0 ? folder + "/" : "");
        Post(new { type = MessageType.Open, aml, @base, name = Uri.EscapeDataString(location.FileName), ticket, drive = location.Drive });
        return true;
    }

    /// <summary>Empties the page (no document).</summary>
    public void Clear()
    {
        if (_disposed || !_ready) return;
        Post(new { type = MessageType.Clear });
    }

    private void MapDocumentRoot(string root)
    {
        var core = _view.CoreWebView2;
        if (string.Equals(_mappedRoot, root, StringComparison.OrdinalIgnoreCase)) return;
        if (_mappedRoot != null) core.ClearVirtualHostNameToFolderMapping(DocumentHost);
        core.SetVirtualHostNameToFolderMapping(DocumentHost, root, CoreWebView2HostResourceAccessKind.Allow);
        _mappedRoot = root;
    }

    /// <summary>Selects an element in the view; null clears the selection.</summary>
    public void Select(string? id)
    {
        if (_disposed) return;
        if (!_ready)
        {
            _pendingSelection = id;
            _hasPendingSelection = true;
            return;
        }
        Post(new { type = MessageType.Select, id });
    }

    public void SetTheme(string theme)
    {
        if (_disposed) return;
        if (!_ready)
        {
            _pendingTheme = theme;
            return;
        }
        Post(new { type = MessageType.SetTheme, theme });
    }

    /// <summary>Runs a script in the page and returns its JSON result (for tests and diagnosis).</summary>
    public Task<string> EvaluateAsync(string script) =>
        _view.CoreWebView2?.ExecuteScriptAsync(script) ?? Task.FromResult("null");

    private void Post(object message) =>
        _view.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    private void OnMessage(string source, string json)
    {
        if (_disposed) return;
        if (!IsViewerUrl(source))
        {
            RaiseError("Ignored a message from " + source);
            return;
        }
        PageMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<PageMessage>(json, MessageType.Json);
        }
        catch (JsonException ex)
        {
            RaiseError("Unreadable message from the page: " + ex.Message);
            return;
        }
        if (message == null) return;

        // The handlers run on the editor's UI thread; an exception here would end the editor.
        try
        {
            Dispatch(message);
        }
        catch (Exception ex)
        {
            RaiseError($"Handling the page's '{message.Type}' failed: {ex.Message}");
        }
    }

    private void Dispatch(PageMessage message)
    {
        switch (message.Type)
        {
            case MessageType.Ready:
                _ready = true;
                Info?.Invoke("Viewer ready at " + message.Url);
                if (_pendingTheme is { } theme) { _pendingTheme = null; SetTheme(theme); }
                Ready?.Invoke();
                if (_hasPendingSelection) { _hasPendingSelection = false; Select(_pendingSelection); }
                break;

            case MessageType.Loaded:
                Loaded?.Invoke(message.Ticket ?? -1, message.Summary, message.Problems ?? new List<string>());
                break;

            case MessageType.Selected:
                Selected?.Invoke(message.Id);
                break;

            case MessageType.Log:
                PageLog?.Invoke(message.Level ?? "log", message.Message ?? "");
                break;

            case MessageType.Error:
                RaiseError("[page] " + (message.Message ?? "(no message)"));
                break;

            default:
                RaiseError($"Unknown message type from the page: '{message.Type}'.");
                break;
        }
    }

    private void RaiseError(string message)
    {
        if (_view.Dispatcher.CheckAccess()) Error?.Invoke(message);
        else _view.Dispatcher.Invoke(() => Error?.Invoke(message));
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _ready = false;
        try
        {
            var core = _view.CoreWebView2;
            if (core != null)
            {
                if (_onMessage != null) core.WebMessageReceived -= _onMessage;
                if (_onNavigationStarting != null) core.NavigationStarting -= _onNavigationStarting;
                if (_onNavigationCompleted != null) core.NavigationCompleted -= _onNavigationCompleted;
                if (_onProcessFailed != null) core.ProcessFailed -= _onProcessFailed;
                if (_onNewWindow != null) core.NewWindowRequested -= _onNewWindow;
            }
        }
        catch
        {
            // The core may already be gone; there is nothing left to unsubscribe.
        }
    }
}
