# Testing in the real AutomationML Editor

Scripts that drive a running AutomationML Editor (6.4.3.5) with the plugin installed, the
way a person would, and read what the editor and the 3D page show. They were used for the
first test in the real editor on 2026-09-26 (results in `docs/plan.md`).

| File | What it does |
|---|---|
| `uia.ps1` | UI Automation helpers: find, invoke, select, expand, pictures of a window (with WebView2 content) |
| `tree.ps1` | The editor's AML trees: walk the instance hierarchy by labels, read the selected entry; `Page` evaluates in the 3D page |
| `open-file.ps1` | File > Open > Open AML File / Open AML Container; fills the file dialog by window messages |
| `click.ps1` | Real mouse clicks, only while the editor is in front |
| `cdp.mjs` | Evaluates an expression in the 3D page through the WebView2 debug port |

## Steps

1. Close every editor window. Start the editor with the WebView2 debug port (it applies to
   this editor process only; every WebView2 picks a free port and writes it to its profile):

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=0'
   Start-Process C:\Dev\91_AMLEditor\AMLEditor.exe
   ```

2. Install through the PlugIn Manager (PlugIns > PlugIn Manager). A new source needs three
   things before its packages show under "available":
   - added in the source dialog (the button next to the source list) with the folder of the
     `.nupkg`,
   - its check box set (only active sources are listed),
   - "Update" pressed for it.

   Then select the package and press install.
3. Activate: PlugIns > AML3DViewer > Activate. The check box in that menu entry only means
   "activate when the editor starts".
4. Drive and read, for example:

   ```powershell
   . .\tree.ps1
   & .\open-file.ps1 -Path C:\...\AmlDocument.aml            # or -Container for .amlx
   Page "document.getElementById('status').textContent"
   ```

## What needs a person

- **Selecting in a tree.** UI Automation can select an entry in the editor's trees, but the
  editor does not process such a selection (its own attribute panel stays empty). A real
  click is needed, and Windows lets a background script neither bring the editor to the
  front nor click into it safely. Someone clicks the editor's title bar once; `Wait-Foreground`
  waits for that, then `Click-At` clicks.
- **The file dialog.** Its file name box is not reachable through UI Automation here, so
  `open-file.ps1` sets it with `WM_SETTEXT` and confirms with `WM_COMMAND`. That needs no focus.

Do not start the probe while this editor runs: both use the plugin's WebView2 profile, and
WebView2 refuses to share it between processes started with different browser arguments.
