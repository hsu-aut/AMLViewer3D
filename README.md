# AML 3D Viewer

Shows an AutomationML document in the browser the way AutomationML Part 3
(IEC 62714-3) describes it: the CAEX instance hierarchy on one side, the COLLADA
geometry it references in 3D on the other, and the joints of the machines
movable. Clicking a part selects its element and the other way round. Parts
mounted on a machine through attachment interfaces follow it: a gripper on a
robot flange, a robot on the carriage of a linear axis.

Status: first version, working name. It grew out of a spike with the
AutomationML e.V. example "Robot cell" (406 COLLADA files, 7.6 million
triangles, 28 mechanisms, 981 joints), which it now opens in about 5 s. It also
runs inside the AutomationML Editor as a plugin (see below); the plugin has been
checked in a host of its own, not yet in the editor itself.

```bash
npm install
npm run dev        # http://localhost:5179/?aml=<path to an .aml file>
npm test
npm run typecheck
npm run test:robotcell   # needs data/robotcell, a few minutes
npm run build && npm run serve   # the production build with data/, http://127.0.0.1:5180/
```

Without `?aml=` the page opens `data/robotcell/AmlDocument.aml`. The robot cell
is not part of this repository (see below); download it and unpack it there.

## What AML asks of a viewer

- `Frame` places an element relative to its parent: x, y, z in metres, then
  rx, ry, rz in degrees about the parent's fixed x, y and z axes, in this order.
  The order is measured on the robot cell: with it all 15 machine links whose
  elements carry a `Frame` sit exactly where the COLLADA kinematics puts them.
- A `COLLADAInterface` with `refType` explicit makes the referenced file (or
  `file#node`) the element's geometry. With `refType` implicit the element stands
  for a node inside the geometry of an element above it, for example axis 6 of a
  robot; that node is not drawn twice, and the element's children move with it.
- `target` names a point inside the referenced node (attachment point, frame of
  interest). An `InternalLink` between two `AttachmentInterface`s mounts one part
  on another.

## What three.js' COLLADA loader does not do

The viewer uses three.js (pinned to 0.186.1) to parse COLLADA and build the
geometry, and works around six things, each covered by a test file in
`test/fixtures` (made by `scripts/make-fixtures.mjs`):

| three.js 0.186 | Effect on the robot cell | Here |
|---|---|---|
| `<instance_node>` into another file is not resolved | 95 of 406 files do not load | every `<instance_node>` becomes a placeholder, filled from the referenced file, with unit conversion |
| a node holding exactly one instance is merged with it; the inner node's name and transform are lost | parts cannot be found by id | the same placeholders |
| nodes without id overwrite each other | parts go missing | ids added before parsing |
| `<tristrips>` and `<trifans>` are ignored | 6.5 of 7.6 million triangles missing | rewritten as `<triangles>` |
| `<polygons>` with one `<p>` per polygon keeps only the last polygon | (not used in the cell) | rewritten as `<polylist>` |
| joints are matched by name patterns; the chain is taken only from nested nodes | loader crashes; the KUKA files keep their links as flat siblings | joints read along the parameter chain (`newparam`, `SIDREF`, `bind`/`param ref`), the chain from `<link>`/`<attachment_full>`, motion relative to the stored pose |

The workarounds use three.js' internal `ColladaParser` and `ColladaComposer`
modules, hence the exact version.

## Loading

Most of a COLLADA file is number lists. three.js hands them to the browser's XML
parser and then splits them into JavaScript arrays. Here they are cut out of the
text first and read into typed arrays by a parser that gives exactly
`Math.fround(parseFloat(token))`; the XML parser only sees the small skeleton.
Reading and rewriting the files and building their geometries needs no DOM and
runs in a pool of Web Workers (`src/collada/pool.ts`); the page parses the
skeleton and assembles the scene.

| Robot cell, 233 MB, Radeon 780M laptop | first open |
|---|---|
| three.js as is (after the fixes above) | 44 s |
| number lists as typed arrays | 11 s |
| with 8 workers | 5.5 s, of which 1.2 s in the page |

`bench/` measures this (`npm run dev`, then `node bench/run.mjs`). A cache of the
built scene would save most of the rest when a document is opened again; it is left
out for now because stale caches are a class of bug of their own.

## AutomationML Editor plugin

`plugin/` holds a plugin for the AutomationML Editor 6.4 that shows the open
document in a WebView2 with this page:

- The page gets the AML text the editor holds in memory, so **Reload** shows
  changes not yet saved. The COLLADA files come from disk through a second
  virtual host. For an `.aml` file that host serves the file's drive, so that
  references may leave the document's folder (`../dae/x.dae`) or name a path on
  the same drive (`file:///C:/…`); a path on another drive is reported. An
  `.amlx` container is unpacked once, off the editor's UI thread, into
  `%LOCALAPPDATA%\AmlViewer3D\amlx` and served as a whole; unpacked containers
  not used for a week are removed.
- A click on a part selects its element in the editor's tree
  (`ISupportsSelection`); a selection in the tree, also of an interface or
  attribute, marks the element's part in 3D, also when it comes while the
  document is still loading. Selections in the trees of external libraries are
  ignored, and a click on empty space leaves the selection as it is.
- A new document or Reload stops the load in progress; closing the document
  empties the view.
- The page leaves the tree to the editor and follows the editor's light or dark
  theme (read from its MahApps background, also when it changes).
- The page cannot be navigated away: dropped files and links are blocked. WebView2
  keeps its profile in `%LOCALAPPDATA%\AmlViewer3D\WebView2`; the plugin's log is
  in `%TEMP%\aml3d-viewer`.

```bash
npm run build                                   # the page, packed with the plugin
dotnet test plugin/Aml.Editor.Plugin.Viewer3D.slnx
```

The build writes `plugin/build/Aml.Editor.Plugin.Viewer3D/Debug/Aml.Editor.Plugin.Viewer3D.0.1.0.nupkg`;
install it through the editor's PlugIn Manager with that folder as a source. The
package tests check what the editor needs and does not report when it is missing:
no second copy of the contract or of Aml.Engine, the page with its worker script,
relative asset paths, a display name the editor accepts.

`plugin/Aml.Editor.Plugin.Viewer3D.Probe` hosts the plugin in a window of its own
the way the editor does and checks it end to end: the page loads the document,
fills the view, a click in 3D reaches the editor as a selection, a selection from
the editor marks the part, one from another document's tree does not, a selection
made during a reload is shown after it, three quick reloads end in one load, the
dark theme arrives, a link cannot lead the page away, closing and opening a
document again works. With the robot cell, as .aml and as .amlx, all checks pass:

```bash
dotnet run --project plugin/Aml.Editor.Plugin.Viewer3D.Probe -- data/robotcell/AmlDocument.aml test/output/probe
```

## Test data

`test/fixtures` holds small generated files: a reference into another file in
other units, a merged instance, nodes without id, strips and fans, polygons, a
two-link arm once flat and once nested, and a CAEX 3.0 cell with a gripper mounted
on the arm. The worker path is tested in the same process with the typed arrays
handed over as between threads (`inThread` in `src/collada/offload.ts`).
`npm run fixtures:check` fails when they differ from the script.

The AutomationML e.V. example "Robot cell" (spot welding, March 2017) is the
larger test: <https://www.automationml.org/news/example-file-of-a-robotcell/>.
Its description states a by-nc-sa licence, so it is not included here. With the
files in `data/robotcell`, `npm run test:robotcell` checks that all 406 files load,
that the 15 machine links with a `Frame` sit exactly on it, that mounted parts stay
on their points when the robots move, that a robot rides along its linear axis, and
that the worker path gives the same 7,576,407 triangles.

Robots of other COLLADA writers (not included either): `npm run fetch:robots` fetches the
30 robots of [rdiankov/collada_robots](https://github.com/rdiankov/collada_robots) (OpenRAVE
writer, CATIA plug-in) and converts three robots from URDF with `collada_urdf` in a ROS Noetic
container (Franka Panda, UR5e, ABB IRB 2400; needs Docker). `npm run test:robots` checks that
all load with all joints, that the OpenRAVE robots move as their own kinematics model says, and
that the URDF robots move as their URDF says. `data/urdf/robots.aml` shows the three in the
viewer.

## State and plan

Where the work stands, why it is built this way, what the editor does with plugins,
and what comes next: [docs/plan.md](docs/plan.md).

## License

MIT
