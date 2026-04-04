We're going to add a new human interaction mode: Canvas. The user can create canvases to organize their thinking, and the agent can collaborate with them, reading and writing to those canvases.
  
This will necessitate some new data types: a canvas type, along with `note `,   `group` and `link`:

- note: like a sticky note. Plop it anywhere, write anything. optional metadata fields the user can create arbitrarily. default data: date created, modified
- group: the user can draw a round rect around any set of elements and "group" them with a name. then refer to contents by a group
- link: the user can drop a link in and it's fetched using the existing link loading mechanism

Users can additionally drag and drop pattern instances into the canvas, and create a "murderboard" by dragging connections between any element: instances, links, groups, notes.

MCP tools exist for agents to create, read and edit canvases.

## Layout

On the left side of the canvas view, a vertical list showing all canvas pages. Users can create, select, and organize (place into folders) canvases.

In the center, the infinite scroll canvas.

On the right, object pallette: canvas elements, plus all patterns and their instances.

# Iteration punchlist

- Scrolling is REALLY jerky. Let's slow it down.
- Labels like "Goals #2" float in various positions relative to their canvas element. Place their pattern name beneath the element, always in the same position, aligned to the right edge.
- Add link is in a weird spot, remove it from the right menu and add it to the top deck, next to note. add + next to the label for each button.
- double clicking a pattern entry should open an editor overlay for that pattern's content, using the same UI mechanisms that already exist for this
