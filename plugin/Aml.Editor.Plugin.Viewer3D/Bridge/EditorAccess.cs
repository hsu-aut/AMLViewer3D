// What the plugin contract does not offer directly:
//
//   1. The document that is open right now. DocumentLoaded fires once, when a file
//      opens; a view created later (undock and redock, a plugin activated after the
//      file was opened) never hears of it. Looked up on the editor's main view model,
//      as in the plugin playbook's starter.
//   2. The file the document came from. The contract hands over a CAEXDocument
//      without saying where it is on disk.
//
// Both are allowed to fail: every failure is logged and the plugin tells the user.

using System.IO;
using System.Reflection;
using System.Windows;
using Aml.Editor.Plugin.Viewer3D.Diagnostics;
using Aml.Engine.CAEX;

namespace Aml.Editor.Plugin.Viewer3D.Bridge;

public static class EditorAccess
{
    private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

    private static readonly string[] DocumentHolders =
        { "CurrentDocument", "ActiveDocument", "Document", "CAEXDocument", "AMLDocument", "OpenedDocument", "SelectedDocument" };

    public static CAEXDocument? TryFindOpenDocument()
    {
        try
        {
            var viewModel = Application.Current?.MainWindow?.DataContext;
            return viewModel == null ? null : FindDocument(viewModel, depth: 0);
        }
        catch (Exception ex)
        {
            PluginLog.Debug("Looking up the open document failed: " + ex.Message);
            return null;
        }
    }

    private static CAEXDocument? FindDocument(object owner, int depth)
    {
        if (depth > 2) return null;
        var type = owner.GetType();
        foreach (var property in type.GetProperties(Members).Where(p => typeof(CAEXDocument).IsAssignableFrom(p.PropertyType)))
        {
            try
            {
                if (property.GetValue(owner) is CAEXDocument document) return document;
            }
            catch { /* a getter with preconditions */ }
        }
        foreach (var name in DocumentHolders)
        {
            object? value;
            try { value = type.GetProperty(name, Members)?.GetValue(owner); }
            catch { continue; }
            if (value == null) continue;
            if (value is CAEXDocument document) return document;
            if (FindDocument(value, depth + 1) is { } nested) return nested;
        }
        return null;
    }

    /// <summary>
    /// The file the document was read from, or null when it is not known. In this order:
    /// <list type="number">
    /// <item>CAEXDocument.FilePath, which Aml.Engine sets when it loads or saves a file.</item>
    /// <item>For a document opened from a container: the container's file, which the
    /// editor keeps on its main view model (AMLContainerEditor.ContainerFilename). The
    /// editor's API does not report containers opened through File > Open.</item>
    /// <item>The editor's API (AMLEditor.AMLApplication.ActiveDocument), only if its file
    /// name is the one the document declares; the API is not updated on every load,
    /// so its path may belong to a file opened earlier.</item>
    /// </list>
    /// </summary>
    public static string? TryGetFilePath(CAEXDocument document)
    {
        try
        {
            if (Existing(document.FilePath) is { } own) return own;
            if (ContainerOf(document) is { } container) return container;
        }
        catch (Exception ex)
        {
            PluginLog.Warn("Reading the document's file from the editor failed: " + ex.Message);
        }

        string? active;
        try
        {
            active = Existing(ActiveFilePath());
        }
        catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or TypeLoadException or MissingMethodException)
        {
            PluginLog.Warn("The editor API is not available: " + ex.Message);
            return null;
        }
        if (active == null) return null;

        var declared = document.CAEXFile?.FileName;
        if (string.IsNullOrEmpty(declared) || string.Equals(declared, Path.GetFileName(active), StringComparison.OrdinalIgnoreCase))
            return active;
        PluginLog.Warn($"The editor's active file is {Path.GetFileName(active)}, but the document calls itself {declared}; its folder is unknown.");
        return null;
    }

    private static string? Existing(string? path) =>
        !string.IsNullOrEmpty(path) && Path.IsPathRooted(path) && File.Exists(path) ? path : null;

    /// <summary>The container file, when the main view model shows this document from one.</summary>
    private static string? ContainerOf(CAEXDocument document)
    {
        var viewModel = Application.Current?.MainWindow?.DataContext;
        if (viewModel == null) return null;
        var type = viewModel.GetType();
        if (type.GetProperty("CAEXDocument", Members)?.GetValue(viewModel) is CAEXDocument shown && !ReferenceEquals(shown, document)) return null;
        if (type.GetProperty("IsContainer", Members)?.GetValue(viewModel) is not true) return null;
        var editor = type.GetProperty("AMLContainerEditor", Members)?.GetValue(viewModel);
        return Existing(editor?.GetType().GetProperty("ContainerFilename", Members)?.GetValue(editor) as string);
    }

    // Separate method so that a missing Aml.Editor.API fails here, inside the try above.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static string? ActiveFilePath() => Aml.Editor.API.AMLEditor.AMLApplication?.ActiveDocument?.FilePath;
}
