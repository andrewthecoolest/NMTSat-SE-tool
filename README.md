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
| Bundle | B | Click corner points to lay out a bundle (a bus that groups wires). Double-click or press Enter to finish; Esc cancels. |
| Text | T | Drag a text box (or click for a default size), then type. Drag its corner handle to resize it. Double-click it to edit; clear its text to delete it. |
| Line | L | Drag to draw a plain colored line with a caption, e.g. for a legend of wire colors. It isn't a wire. Double-click it to change its color or caption. |

- To see and edit a box's details, hover it and click its preview (for a subsystem, click the details column; clicking its sheet opens it). Double-clicking a module also works. Click a wire for its details.
- Drag a wire's end (Select tool) around its box to move where it attaches. Drag it away and it floats with the pointer: drop it on another box, bundle or wire to reconnect it there, or on empty space to leave it floating (as an unknown load). Dragging an unknown load onto a box connects its wire there too.
- Drag any part of a wire's line to arrange it; the wire's info then offers **Auto-route this segment** to undo that.
- Drag a wire's name to wherever it reads best.
- **Pins:** when a wire starts or ends on a module, the wire dialog asks for an optional pin name at that module (e.g. J1-3). The pin is written just inside the box where the wire meets it. Change pins later in the module's info (PINS lists every wire end on it), or in a wire's info when you click its segment. Clear the field to remove a pin.
- Descriptions and text boxes can be formatted: select some text, then use **B** (bold, or Ctrl/Cmd+B), **Size**, or the color picker (**A** reapplies the current color). **Clear** removes formatting.
- Reusing a name refers to the same object or wire.
- **Universal wires** (like ground): tick *Universal* when creating a wire, or in its info. A universal wire can be drawn anywhere, in separate pieces on any sheet; all its pieces count as connected, so every module on it lists the others. Universal wires are bidirectional.
- **Branching partway along:** with the Wire tool, start (or end) on a bidirectional or universal wire's line to branch it there; a dot marks the branch point. Directed wires can only branch at modules and vias.
- **Bundles:** with the Wire tool, draw a wire onto a bundle to put it in. To pull one out, click the bundle (or a wire's dot on it, to pull out at that same point) with the Wire tool, type the wire's name, then click where it goes; it runs inside the bundle from where it went in. With the Select tool, drag a bundle to move it, drag its corner handles to reshape it, drag a wire's dot along it to move where that wire goes in or out, and double-click it for its info (where you can also change its color, or tick *Highlight this bundle* to put a solid band of color behind it). A bundle's name isn't shown on the canvas: hover anywhere on its line to see its name and the wires inside. While laying out a bundle, click a subsystem box to run it into that subsystem: it carries on inside from a bundle via, and wires put in outside can be pulled out inside (or the other way round). Deleting a bundle reconnects its wires directly.
- Giving a box a color tints its body lightly.
- Rest the pointer on a box (anywhere but its outer edge; a faint dashed outline shows the area) or anywhere on a bundle's line (but not on a wire's dot) to preview it (read-only). The thin outer edge, where wire ends are, never opens a preview, so wiring isn't interrupted. A subsystem shows what's inside, with its description, contents and boundary wires alongside. A module shows its description and connections. Move the pointer away to close the preview. Previews don't open while something is selected; press Esc or click empty space to clear the selection.
- Use the breadcrumb at the top left to go back up a level.
- Select something (or box-select several things) and press Delete to remove it. Undo brings it back.

## Default diagram

Work autosaves in the browser. To make your diagram the site's default, click **Export JSON**, replace `default.json` in the repo with the downloaded file, then commit and push.
