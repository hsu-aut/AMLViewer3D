# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

First version: a page for the browser and a plugin for the AutomationML Editor 6.4.

### Added

- The CAEX instance hierarchy with the COLLADA geometry it references
  (AutomationML Part 3): explicit and implicit references, `Frame`, `target`
  points, parts mounted through attachment interfaces. `.aml` files and `.amlx`
  containers, CAEX 2.15 and 3.0.
- Joints read from the COLLADA kinematics and moved with sliders, for files of
  the CATIA plug-in, the OpenRAVE writer and `collada_urdf`.
- Six gaps of three.js' COLLADA loader closed (references into other files,
  merged nodes, nodes without id, strips and fans, polygons, joints), each with
  a test file.
- Loading in a pool of Web Workers: the AutomationML e.V. robot cell (233 MB,
  7.6 million triangles) opens in about 5 s.
- Plugin: the document as the editor holds it, saved or not; selection both ways
  between the editor's tree and the 3D view; the editor's light and dark themes.
