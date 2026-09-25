# AML 3D Viewer

Shows an AutomationML document in the browser the way AutomationML Part 3
(IEC 62714-3) describes it: the CAEX instance hierarchy on one side, the COLLADA
geometry it references in 3D on the other, and the joints of the machines
movable. Clicking a part selects its element and the other way round. Parts
mounted on a machine through attachment interfaces follow it: a gripper on a
robot flange, a robot on the carriage of a linear axis.

Status: first version, working name. It grew out of a spike with the
AutomationML e.V. example "Robot cell" (406 COLLADA files, 7.6 million
triangles, 28 mechanisms, 981 joints), which it now opens in about 5 s. Next: a
plugin for the AutomationML Editor.

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

## License

MIT
