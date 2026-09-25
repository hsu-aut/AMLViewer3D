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
/// document it has now, so a buffer could only bring back an older one. Selection and
/// theme are buffered.</item>
/// </list>
///
/// Two virtual hosts: the viewer's files, and the folder of the open document. The
/// page loads the COLLADA files from the second one, in Web Workers; access across the
/// two origins is allowed for exactly these two folders.
/// </summary>
public sealed class ViewerView : IDisposable
{
    public const string ViewerHost = "aml3d-viewer.local";
    public const string DocumentHost = "aml3d-document.local";
    public const string AssetsFolder = "viewer-assets";

    private readonly WebView2 _view;
    private bool _navigationStarted;
    private bool _ready;
    private bool _disposed;
    private string? _mappedFolder;

    private string? _pendingSelection;
    private bool _hasPendingSelection;
    private string? _pendingTheme;

    private EventHandler<CoreWebView2WebMessageReceivedEventArgs>? _onMessage;
    private EventHandler<CoreWebView2NavigationStartingEventArgs>? _onNavigationStarting;
    private EventHandler<CoreWebView2NavigationCompletedEventArgs>? _onNavigationCompleted;
    private EventHandler<CoreWebView2ProcessFailedEventArgs>? _onProcessFailed;

    public ViewerView(WebView2 view) => _view = view;

    /// <summary>The page booted (first load, reload, recovery).</summary>
    public event Action? Ready;

    /// <summary>A document is shown, with what the page counted and what it could not resolve.</summary>
    public event Action<LoadSummary?, IReadOnlyList<string>>? Loaded;

    /// <summary>The user picked an element in the page (null: nothing).</summary>
    public event Action<string?>? Selected;

    public event Action<string>? Error;
    public event Action<string>? Info;
    public event Action<string, string>? PageLog;

    public bool IsReady => _ready;

    public static string AssetsPath
    {
        get
        {
            var location = typeof(ViewerView).Assembly.Location;
            var directory = string.IsNullOrEmpty(location) ? null : Path.GetDirectoryName(location);
            return Path.Combine(directory ?? AppContext.BaseDirectory, AssetsFolder);
        }
    }

    public async Task InitAsync()
    {
        if (_navigationStarted || _disposed) return;
        try
        {
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
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.SetVirtualHostNameToFolderMapping(ViewerHost, assets, CoreWebView2HostResourceAccessKind.Allow);

        _onMessage = (_, e) => OnMessage(e.WebMessageAsJson);
        _onNavigationStarting = (_, _) => _ready = false;
        _onNavigationCompleted = (_, e) =>
        {
            if (e.IsSuccess) return;
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
        core.WebMessageReceived += _onMessage;
        core.NavigationStarting += _onNavigationStarting;
        core.NavigationCompleted += _onNavigationCompleted;
        core.ProcessFailed += _onProcessFailed;

        _navigationStarted = true;
        core.Navigate($"https://{ViewerHost}/index.html");
    }

    /// <summary>
    /// Shows a document: its AML text and the folder its references are relative to.
    /// Returns false when the page is not ready; the host sends it again on Ready.
    /// </summary>
    public bool Open(string aml, string folder, string fileName)
    {
        if (_disposed || !_ready || _view.CoreWebView2 == null) return false;
        MapDocumentFolder(folder);
        Post(new { type = MessageType.Open, aml, @base = $"https://{DocumentHost}/", name = Uri.EscapeDataString(fileName) });
        return true;
    }

    private void MapDocumentFolder(string folder)
    {
        var core = _view.CoreWebView2;
        if (string.Equals(_mappedFolder, folder, StringComparison.OrdinalIgnoreCase)) return;
        if (_mappedFolder != null) core.ClearVirtualHostNameToFolderMapping(DocumentHost);
        core.SetVirtualHostNameToFolderMapping(DocumentHost, folder, CoreWebView2HostResourceAccessKind.Allow);
        _mappedFolder = folder;
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

    private void OnMessage(string json)
    {
        if (_disposed) return;
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
                Loaded?.Invoke(message.Summary, message.Problems ?? new List<string>());
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
            }
        }
        catch
        {
            // The core may already be gone; there is nothing left to unsubscribe.
        }
    }
}
