# AML 3D Viewer

The open document of the [AutomationML Editor](https://www.automationml.org/) in 3D,
with the COLLADA geometry and kinematics it references (AutomationML Part 3,
IEC 62714-3).

- **Geometry:** every element with a `COLLADAInterface` shows its COLLADA file,
  placed by its `Frame`. An implicit reference stands for a node in the geometry
  of an element above it, for example an axis of a robot.
- **Kinematics:** the joints of machines, read from the COLLADA kinematics, move
  with sliders. Parts mounted through attachment interfaces follow: a gripper on
  a robot flange, a robot on the carriage of a linear axis.
- **Selection both ways:** a click on a part selects its element in the editor's
  tree; a selection in the tree marks the part in 3D.
- **Reload** shows the document as the editor holds it, saved or not.
- `.aml` files and `.amlx` containers; the editor's light and dark themes.

## Installing

1. In the AutomationML Editor (6.4 or later), open the PlugIn Manager
   (**PlugIns** › **PlugIn Manager**), choose the source **PublicSource**, select
   **AML3DViewer** among the available plugins and install it.
2. Restart the editor and switch the plugin on once with **PlugIns** ›
   **AML3DViewer** › **Activate**.

The view runs in WebView2, which Windows 10 and 11 bring.

Without a network, download the package from the
[releases](https://github.com/hsu-aut/AMLViewer3D/releases) and add its folder as a
package source in the PlugIn Manager; the package asks for nothing the editor
does not bring.

## More

- [Changes](https://github.com/hsu-aut/AMLViewer3D/blob/main/CHANGELOG.md)
- [Source](https://github.com/hsu-aut/AMLViewer3D), MIT license;
  [third-party notices](https://github.com/hsu-aut/AMLViewer3D/blob/main/THIRD-PARTY-NOTICES.md)
- The same viewer runs in the browser; how to start it is in the repository.
