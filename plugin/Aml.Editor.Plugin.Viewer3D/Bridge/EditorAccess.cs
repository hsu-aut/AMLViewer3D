// What the plugin contract does not offer directly:
//
//   1. The document that is open right now. DocumentLoaded fires once, when a file
//      opens; a view created later (undock and redock, a plugin activated after the
//      file was opened) never hears of it. Looked up on the editor's main view model,
//      as in the plugin playbook's starter.
//   2. The file the document came from. The contract hands over a CAEXDocument
//      without a path; the editor's API (Aml.Editor.API) knows the active file.
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
    /// The path of the editor's active file, if it is the given document's: the file
    /// name in the document (CAEXFile/@FileName) must match, so that a path is never
    /// taken from another open file.
    /// </summary>
    public static string? TryGetFilePath(CAEXDocument document)
    {
        string? path;
        try
        {
            path = ActiveFilePath();
        }
        catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or TypeLoadException or MissingMethodException)
        {
            PluginLog.Debug("The editor API is not available: " + ex.Message);
            return null;
        }
        if (string.IsNullOrEmpty(path)) return null;

        var declared = document.CAEXFile?.FileName;
        if (string.IsNullOrEmpty(declared)) return path;
        var actual = Path.GetFileName(path);
        if (string.Equals(declared, actual, StringComparison.OrdinalIgnoreCase)) return path;
        // A container's root document keeps its own name inside the container.
        if (DocumentSource.IsContainer(path)) return path;
        PluginLog.Warn($"The editor's active file is {actual}, but the document calls itself {declared}; using the active file.");
        return path;
    }

    // Separate method so that a missing Aml.Editor.API fails here, inside the try above.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static string? ActiveFilePath() => Aml.Editor.API.AMLEditor.AMLApplication?.ActiveDocument?.FilePath;
}
