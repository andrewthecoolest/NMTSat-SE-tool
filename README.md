# NMTSat-SE-tool

A browser tool for mapping a satellite's architecture: subsystems, modules, and the wires between them.

Link: https://andrewthecoolest.github.io/NMTSat-SE-tool/

## Use

| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Click to select, drag to move, drag the corner handle to resize. Drag across empty space to select everything inside the box. Hold Space and drag (or drag with the middle button) to pan; scroll to zoom. |
| Module | M | Drag a box (or click for a default size), then name it. |
| Subsystem | S | Same as Module, but double-clicking it opens its own sheet. |
| Unknown load | U | Click to place an X: a placeholder wire end. Double-click it later to promote it to a module or subsystem. |
| Wire | W | Click where the wire starts, move the pointer (the wire follows it), and click where it ends; or drag from one to the other. Esc cancels. Dropping on empty space creates an unknown load. Dropping on a subsystem creates a port and a via inside it. Inside a subsystem, drop on the grey sheet boundary to leave it. |
| Text | T | Drag a text box (or click for a default size), then type. Drag its corner handle to resize it. Double-click it to edit; clear its text to delete it. |

- Click the **i** on a box, or click a wire, to see its details.
- Descriptions and text boxes can be formatted: select some text, then use **B** (bold, or Ctrl/Cmd+B), **Size**, or the color picker (**A** reapplies the current color). **Clear** removes formatting.
- Reusing a name refers to the same object or wire.
- Rest the pointer on a box for half a second to preview it (read-only). A subsystem shows what's inside, with its description, contents and boundary wires alongside. A module shows its description and connections. Move the pointer away to close the preview, or click it to open the subsystem (or the module's info).
- Use the breadcrumb at the top left to go back up a level.
- Select something (or box-select several things) and press Delete to remove it. Undo brings it back.

## Default diagram

Work autosaves in the browser. To make your diagram the site's default, click **Export JSON**, replace `default.json` in the repo with the downloaded file, then commit and push.
