# Plan and state

A viewer for AutomationML documents with their COLLADA geometry and kinematics
(AutomationML Part 3, IEC 62714-3), in the browser and as a plugin for the
AutomationML Editor. This file records where the work stands, why it is built
the way it is, and what comes next, so that work can continue from here
without the history.

State on 2026-09-26: stages 1 to 3 are done, reviewed and tested in the real editor
(6.4.3.5, driven by the scripts in `plugin/editor-test`, see "The test in the real
editor").
Nothing is pushed; the repository has no remote. "AML 3D Viewer" is a working
title.

| Stage | Content | Status | Commits |
|---|---|---|---|
| 0 | Spike: does it work, what is missing in three.js | done, throwaway code in `../AmlViewer3D-Spike` (no git, its README has the first findings) | |
| 1 | Repository, generated fixtures, tests, CI file | done | `c0574c0` |
| 2 | Loading speed: robot cell from 44 s to about 5.5 s | done | `37f40e8`, `eb941a2` |
| 3 | AutomationML Editor plugin (WebView2), selection both ways | done | `4711d9f` |
| 3a | Two independent reviews (plugin against the decompiled editor, page in plugin mode); all confirmed findings fixed | done | `7c0e173` (page), `7c9f15d` (plugin) |
| 3b | Test in the real editor; what it found is fixed | done | `d5d5ab4`, `eaba7b7` |
| 4 | Same page as a view in AmlWeb (with AmlEngine.js); fixes offered to three.js | open | |

## Code

```
src/aml/reader.ts        CAEX 2.15 and 3.0: InstanceHierarchies, Frame, COLLADAInterface,
                         AttachmentInterface, InternalLinks (by ID, "[ID]:[Name]", "{ID}:Name")
src/collada/numbers.ts   number lists to typed arrays, exactly Math.fround(parseFloat)
src/collada/preprocess.ts rewrites before three.js parses (list below), number lists as tokens
src/collada/parser.ts    three.js parser that takes the typed arrays; composer that keeps
                         geometries built in a worker
src/collada/offload.ts   work without DOM (read, preprocess, build geometries); inThread()
                         imitates a worker, typed arrays really handed over
src/collada/pool.ts      up to 8 workers, 2 tasks each, geometry tasks first; a failed
                         worker fails its tasks
src/collada/worker.ts    the worker around offload.ts
src/collada/store.ts     loads files, fills <instance_node> placeholders with copies;
                         waits per node, cycles found in a graph of who waits for whom
src/collada/kinematics.ts joints, limits, values along newparam/bind/SIDREF; chain from
                         link/attachment_full
src/scene/frame.ts       Frame to matrix (fixed axes x, y, z)
src/scene/cell.ts        the scene: elements, explicit and implicit references, attachment
                         points, mechanisms, attachments; fileUrl() for references
src/app/main.ts          the page (tree, 3D, details, joint sliders); standalone or hosted
src/app/host.ts          message protocol with a host (the plugin)
src/index.ts             library entry
scripts/make-fixtures.mjs the 10 fixtures in test/fixtures (npm run fixtures:check compares)
scripts/serve.mjs        serves dist/web and data/ (port 5180)
bench/                   load benchmarks (Playwright with GPU)
plugin/                  the editor plugin (C#, WPF, WebView2), its tests and the probe
```

### Loading, step by step

1. **Worker:** fetch (no HTTP cache), then `preprocess`:
   - number lists (`float_array`, `p`, `vcount`) become typed arrays and a token `§k`;
   - `tristrips`/`trifans` become `triangles`, `polygons` becomes `polylist`, and the
     arrays they replace are emptied;
   - every `instance_node` becomes a placeholder node `__ref_k`;
   - `instance_kinematics_scene` is removed (read separately from `reduced`);
   - every node gets an id, and its name becomes `@id`.
2. **Page:** three.js parses the small skeleton.
3. **Worker:** builds the geometries, except skinned ones (the composer adds the skin later).
4. **Page:** composes the scene.
5. **Page:** placeholders are filled with clones of the referenced node, from the same or
   another file, with a unit wrapper. A placeholder waits for one node, not for a whole file,
   so two files may use nodes of each other; a node that contains itself is reported.
6. **Page:** `buildCell` places every InternalElement by its Frame, draws explicit
   references, maps implicit ones onto nodes in an ancestor's geometry, finds mechanisms and
   attachments.

Node keys are `<file name, lower case>#<node id>`: implicit references name the file in
which the node is defined, while the scene holds copies of it inside other files.

### Decisions and their reasons

- **COLLADA only.** Part 3 prescribes it for geometry and kinematics; glTF has no machine
  joints. Other formats would be static geometry (see "Other 3D formats").
- **three.js internals.** `ColladaParser` and `ColladaComposer` (three.js 0.186.1, pinned
  exactly, types in `types/three-collada.d.ts`) are used directly; the loader itself is not.
- **Every `instance_node` is resolved here**, also those inside one file, because three.js
  merges a node that holds exactly one instance with it and loses its name and transform.
- **No cache** of converted geometry: about 5 s is acceptable, and a cache risks stale data.
  It can be added if loading feels slow in the editor.
- **Drawing on demand:** the page draws only after a change (camera, selection, joint, load,
  texture); in the editor it may stay open for hours.
- **Plugin reads the AML from memory** (`CAEXDocument.SaveToStream`), so Reload shows
  unsaved changes; the COLLADA files come from disk.
- **The plugin serves the whole drive of an .aml file** (virtual host `aml3d-document.local`),
  so that `../` references and `file:///C:/...` paths on the same drive resolve; the page only
  reads through that host and cannot navigate. An .amlx is unpacked (off the UI thread, under
  a lock) into `%LOCALAPPDATA%\AmlViewer3D\amlx\<hash of path, size, time>` and served
  whole; unused folders are removed after a week.
- **Selection:** the editor's tree owns it. A click on empty space in 3D changes nothing;
  selections from library trees (objects of other documents) are ignored; a selection that
  arrives while loading is applied after loading (the page keeps it, and the plugin resends
  it on `loaded`).

## Message protocol (`src/app/host.ts`, `plugin/.../Bridge/PageMessage.cs`)

| Direction | Message | Meaning |
|---|---|---|
| page to host | `ready {url}` | the page listens; the host answers every `ready` by sending its document |
| page to host | `loaded {ticket, summary, problems}` | a document is shown; `ticket` as sent with `open` |
| page to host | `selected {id}` | the user picked an element |
| page to host | `log {level, message}`, `error {message}` | |
| host to page | `open {aml, base, name, ticket, drive}` | AML text, folder URL, file name, a number, the served drive ("C:") or null |
| host to page | `clear` | no document |
| host to page | `select {id}` | the editor selected an element (null: nothing) |
| host to page | `setTheme {theme}` | "dark" or "light" |

A new `open` stops the load in progress (its worker pool is disposed); a `loaded` with an
old ticket is ignored by the plugin.

## Findings about AML and COLLADA

- **Frame:** x, y, z in metres; rx, ry, rz in degrees about the fixed axes, first x, then y,
  then z (R = Rz·Ry·Rx, three.js Euler order 'ZYX'). Measured on the robot cell: 15 of 15
  implicit nodes sit exactly on their Frame; the other reading turns 10 of 15 away.
- **COLLADAInterface:**
  - `refType` explicit: the file or `#node` is the element's geometry.
  - `refType` implicit: the element stands for a node inside an ancestor's geometry.
  - `target`: a sid, the attachment point.
- **`file:///Col/x.dae`** (no drive) is how the AutomationML examples write a path relative
  to the document.
- **Attachments:** AttachmentInterface pairs linked by an InternalLink. The part on a
  joint-driven node leads; the owner of an attachment frame is its parent element.
- **KUKA files** keep all links as flat siblings, with the stored pose baked in. The chain is
  only in the kinematics model, so a joint moves by (value minus stored value), relative to
  the stored pose.
- **Robot cell data gap:** in 8 of 18 attachment links one side states no point (neither
  `target` nor `Frame`); the three robot pedestals are off by the same 1071.6 mm. The viewer
  keeps the loaded distance, so parts still follow. Worth reporting to the AutomationML e.V.
- **Robot cell limits of little use:** ±360° limits on doors and clamps are placeholders;
  the hose packages (166 passive joints per robot) hang on the arm only and move rigidly.
  Clamps move one by one, not coupled. The file holds no robot paths.

## Gaps in three.js' COLLADA loader (r186)

Each one is closed here and is a candidate for a contribution to three.js (stage 4):

1. `instance_node` into other files is not resolved.
2. A node holding exactly one instance is merged with it; the inner node's name and
   transform are lost.
3. Nodes without id overwrite each other.
4. `tristrips` and `trifans` are ignored (85 % of the robot cell's triangles).
5. Kinematics are matched by a naming pattern and crash on real files; the chain is known
   only through nested nodes.
6. `polygons` with several `p` keep only the last polygon.

Also found while building on it: `compose()` builds every geometry again without looking at
an existing build (hence `PrebuiltColladaComposer`); a `.tga` texture without a TGA loader
makes the whole file fail.

## The AutomationML Editor, as the plugin meets it (6.4.3.5)

Read in the decompiled editor. A local copy is in `test/output/editor-6.4.3.5/` (ignored by
git): `extract_bundle.py <AMLEditor.exe> <folder>` unpacks the single-file bundle, then
`ilspycmd -p -o <out> <dll>` decompiles.

- **Callbacks:** all plugin callbacks arrive on the UI thread (BeginInvoke). An exception
  that reaches the dispatcher shuts the editor down.
- **Documents:** one document per process.
- **Selection:**
  - A selection raised by the plugin is applied with `notify: false`, so it is not reported
    back.
  - The trees of external libraries report their selections with objects of other
    `CAEXDocument`s.
- **ApplicationClose** is also sent when a plugin makes the editor open another document.
- **File path:**
  - `AMLEditor.AMLApplication.ActiveDocument` (Aml.Editor.API) is set only in
    `MainViewModel.LoadFromFile`, not when an .amlx is opened through File > Open, and not
    on New, Save As or Close.
  - The plugin therefore takes the path in this order: `CAEXDocument.FilePath`, then the
    container file from `MainViewModel.AMLContainerEditor.ContainerFilename` (by
    reflection), then the API, but only when its file name matches.
- **Theme:**
  - View > Change theme offers Default, Metro Light, Royal Light, Office 2010 Blue,
    Office 2013, Dark (RoyalDark) and Metro Dark. The editor applies a theme through the
    Infragistics ThemeManager and `AMLApp.ApplySkin` (the MahApps brushes), then calls
    `ISupportsThemes.OnThemeChanged(ApplicationTheme)` on every plugin that implements it,
    also when a plugin is activated. (The review assumed that `ApplicationTheme` knows only
    Default and Office2010Blue; the contract 4.3.0 has all of the above.)
  - The plugin reads the brightness of `MahApps.Brushes.ThemeBackground` when it is shown and
    follows `ControlzEx` ThemeManager changes by reflection. In the real editor this follows
    a change at once (Metro Dark gave "dark", Office 2013 "light"). `ISupportsThemes` would
    be the documented way and could replace the reflection.
- **Plugin menu:** PlugIns > <plugin> is a submenu with Activate and Terminate. Its check box
  is `IsAutoActive`, "activate when the editor starts", and opens nothing by itself.
- **PlugIn Manager:**
  - Only active sources (check box in the source dialog) are listed and searched, and a new
    source shows its packages only after "Update".
  - The manager searches a source for "AMLEditor" and needs the tag `AMLEditorPlugin.Net`.
  - It also installs the nuspec's dependencies (Aml.Engine, Aml.Editor.API,
    System.IO.Packaging) into the plugin's folder, as for every other plugin. They are not
    used: the load context resolves through the plugin's `deps.json`, where they are compile
    only, so the editor's copies are shared.
- **Trees:** a selection made through UI Automation marks the entry but is not processed
  by the editor (its attribute panel stays empty, plugins are not told); only a mouse click
  selects.
- **Packaging:**
  - The Contract assembly must not be shipped; a second copy makes the editor skip the
    plugin silently. Aml.Engine and Aml.Editor.API come from the editor too.
  - WebView2 is packed from `lib_manual/netcoreapp3.0`, as AMLOpcUa does.
  - The `DisplayName` becomes a WPF name and an XML element name (no dots, spaces or
    slashes).

## Build, test, check

```bash
npm install
npm run dev                 # page at http://127.0.0.1:5179/?aml=<url>, default data/robotcell/AmlDocument.aml
npm run fixtures:check && npm run typecheck && npm test      # 71 tests
npm run test:robotcell      # 5 tests on the robot cell, needs data/robotcell (about 90 s)
npm run build               # dist/web, packed into the plugin

dotnet test plugin/Aml.Editor.Plugin.Viewer3D.Tests          # 32 tests, including the package
dotnet build plugin/Aml.Editor.Plugin.Viewer3D.slnx          # plugin, tests and probe
plugin/Aml.Editor.Plugin.Viewer3D.Probe/bin/Debug/net8.0-windows7.0/Aml.Editor.Plugin.Viewer3D.Probe.exe <file.aml|.amlx> <output folder>
```

- **The probe** hosts the plugin in a WPF window the way the editor does and runs 20
  checks. It prints each result at once and writes pictures and `report.txt`.
- **Probe documents that passed:**
  - `test/fixtures/cell.aml`;
  - the robot cell as `data/robotcell/AmlDocument.aml` and as `test/output/robotcell.amlx`;
  - a copy of the fixture cell with `../geometry/` and `file:///C:/...` references. To
    build it, put `cell.aml` in `model/` and the `.dae` files in `geometry/`, then rewrite
    the `refURI` values.
- **Load time of the robot cell:** about 9 s in the probe's WebView2, as before the review.
  The Playwright benchmark gives 5.5 s.
- **Benchmark:** `npm run dev`, then `node bench/run.mjs`. The machine varies a lot under
  load; compare values from the same run only.
- **The robot cell** is the AutomationML e.V. example (spot welding, 2017):
  <https://www.automationml.org/news/example-file-of-a-robotcell/>. Its licence is by-nc-sa,
  so it stays in `data/` (ignored by git) and is never committed. It has 323 elements,
  406 COLLADA files (233 MB, COLLADA 1.5, mm), 7,576,407 triangles, 28 mechanisms and
  981 joints.

### Pitfalls met so far

- **Line endings:** `.gitattributes` keeps LF; with CRLF the fixture check fails on Windows.
- **Browser tests:** Playwright needs the GPU build of Chromium (`channel: 'chromium'`,
  `--use-angle=d3d11`); SwiftShader does not manage 7.6 million triangles.
- **.NET:**
  - The .NET 10 SDK creates `.slnx` files.
  - `UseWPF` removes `System.IO` from the implicit usings.
  - XML comments must not contain `--`.
- **WebView2:**
  - `CapturePreviewAsync` never returns while the view is hidden.
  - After a probe is killed, the profile folder is busy for a while (0x800700AA).
  - A cancelled navigation ends in `NavigationCompleted` with `OperationCanceled`; that
    must not mark the page as not ready.
  - WPF cannot draw over a WebView2, so the placeholder shows only while the view is hidden.
- **CSS grid of the hosted page** needs fixed cells, else the 3D view shrinks to width 0
  (picking still works, hence the size check in the probe).
- **The editor's panel is narrow.** On a screen scaled by 200 % the plugin's page is about
  535 × 585 CSS pixels. A fixed 320 px side panel left 200 px for 3D, and a status line that
  wrapped made the page scroll. The probe's large window hid both.
- **A WPF ToolBar in a narrow panel** moves what does not fit into its overflow menu; the
  plugin's status line sat there unseen. It now sits next to the toolbar.
- **The editor's skin makes tab headers large.** A TabItem style of the plugin's own would
  replace the skin's style; the headers carry their own font size instead.
- **Tests of the worker path** must hand typed arrays over (`structuredClone` with
  `transfer`); copying hides errors.

## Next

1. **Open question (visible behaviour):** a selection in the document's own libraries
   (RoleClassLib and so on) clears the 3D selection, as the editor's attribute panel then
   shows no element either. Keeping the last element marked instead would be a small change.
2. **Before publishing:**
   - the final name;
   - a remote (probably under hsu-aut, like AMLMcp and AMLOpcUa);
   - check the CI file after the first push (untested);
   - `CAEX_ClassModel_V.3.0.xsd` lies untracked in `test/fixtures`; clarify whether it
     belongs there.
3. **More test files:** the robot cell is the only public AML file with COLLADA we have,
   from 2017 and from one exporter. Other files could come through the AutomationML e.V.
4. **Stage 4:** the page as a view in AmlWeb, reading AML with AmlEngine.js instead of
   `reader.ts`; the six gaps above offered to three.js.
5. **Known limits:**
   - If WebView2 fails to start, the plugin cannot recover without reopening the view.
   - The robot cell's limits listed above.

### The test in the real editor (2026-09-26)

Installed through the PlugIn Manager from `plugin/build/Aml.Editor.Plugin.Viewer3D/Debug`
(source "AML3DViewer"), editor 6.4.3.5, screen scaled by 200 %. Steps and scripts:
`plugin/editor-test/README.md`.

| Check | Result |
|---|---|
| install, activate, page ready | passed |
| new unsaved document | placeholder "folder not known", as intended |
| robot cell .aml through File > Open > Open AML File | 406 files, 7,576,407 triangles, no problems, about 6.5 s |
| robot cell .amlx through File > Open > Open AML Container | found through the container path, unpacked, same result, about 6.2 s |
| click in 3D selects in the editor's tree | passed |
| click in the editor's tree marks the part in 3D | passed (a real click; see "Trees" above) |
| Reload keeps the selection | passed |
| theme change while running (Metro Dark, back to Office 2013) | passed |
| File > Close empties the page, placeholder shows | passed |
| editor error log | no entry from this plugin |
| layout in the narrow panel, status line, tab headers | failed, fixed in `d5d5ab4` and checked again in the editor |
| log of a second editor process | could not write the shared file; now writes its own |

Seen on the way, not in this plugin: AMLOpcUa 0.1.1 (installed) raises a
NullReferenceException in `OpcUaPlugin.Watch` on every document load and unload of the
robot cell, and the editor shows a message box each time.

### Other 3D formats (considered, not started)

- **In AML:** the generic `ExternalDataReference` (below `ExternalDataConnector`, with
  `refURI` and `MIMEType`) would reference them. `reader.ts` reads only `COLLADAInterface`
  so far. For such references the standard fixes neither the axes, nor the units, nor how
  `Frame` applies, so a convention would have to be set and documented.
- **What they cannot carry:** implicit references (nodes in another file), `target`
  points and kinematics. In practice they give static geometry only.
- **Loaders:**
  - glTF/GLB (`GLTFLoader`) and STL/OBJ/PLY/3MF are small steps.
  - STEP/IGES needs OpenCascade as WebAssembly (occt-import-js): a large download, LGPL,
    and work in a worker.
  - JT has no usable open loader.
- **Order:** glTF first (CIROS exports its station models as glb), then STL. STEP only if
  real files need it.
