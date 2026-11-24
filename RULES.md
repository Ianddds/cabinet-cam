# Rules for working on Cabinet systems

Read this before changing any FeatureScript (onshape/*.fs) or the Cabinet CAM
toolpath / nesting code. Every rule here is a mistake that already happened once.

## FeatureScript

1. **`box` is a reserved word.** Never use it as a variable, parameter, function
   name, or a map key read with a dot (`r.box`). Use `bounds`. A quoted key in a
   string (`"box"`) or an id suffix (`id + "box"`) is fine.
2. **One constant or variable per declaration.** `const a = 1, b = 2;` fails with
   "Only one constant may be declared at a time". Write each on its own line.
3. **Don't name a parameter `flip`** — Onshape reserves it.
4. **Enum parameter types must be visible to the studio declaring the feature.**
   An enum from another Feature Studio used in a precondition needs
   `export import(...)` of that studio (Cabinet build imports Cabinet drawers and
   Cabinet fronts this way).
5. **Part names can't be read while a feature regenerates** (`getProperty` with
   `PropertyType.NAME` fails). Identify bodies by attributes or geometry.
6. **`qCreatedBy(id)` also matches every sub-id** (`id + "cup0"`, `id + "stick"`).
   Give a main body its own sub-id (`id + "blk"`, `id + "slab"`) so tools made
   under the same id aren't swept into it (that caused BOOLEAN_INVALID).
7. **A boolean that can leave nothing** (e.g. "box minus shape" for a shape that
   fills its box) must be checked before the result is moved or used —
   CANNOT_RESOLVE_ENTITIES otherwise.
8. **`qUnion(...)` passed into a function may arrive as a plain map.** Don't type
   such a parameter `is Query`; accept it untyped and tag it with `as Query`.
9. **Unused loop variables raise notices.** Iterate `keys(map)` / `values(map)`
   or use an index loop.
10. **The API's FeatureScript evaluation body needs `"queries": {}`**, not `[]`.
11. **Import lines are the user's**: when a file needs a new import, leave a clear
    `REPLACE_WITH_…` placeholder and say so; never invent document / version ids.
12. **Before sending FeatureScript, scan it** for 1–3 (`box` identifiers,
    multi-declarations, `flip`), and say plainly that it hasn't been run in Onshape.

## Cabinet CAM toolpaths

1. **Least rapid travel.** Any change to toolpath order must not increase rapid
   travel. `npm test` checks total rapids against a baseline; if a change is meant
   to trade travel for something else, say so and update the baseline on purpose.
2. **Pockets: each leg whole, out to in.** Touching pockets are one operation;
   any depth order cuts the same shape (a depth not cut yet counts as open), so
   the order is picked by time. Square-sided groups (a straight dado, an L, a C
   of rabbets and a dado) are cut leg by leg: each leg complete, its wall pass as
   its last row, then straight on to the next leg. Rows run along each leg
   (never across); a rabbet from its open edge in to its wall, a dado middle
   first, so the first full-width pass is never on a wall. Each leg's start end
   is picked so it finishes next to the next leg; a leg that joins two others
   may hold back its last pass and cut it on the way back. A wall pass is split
   where it crosses into the next leg; a corner square belongs to the leg that
   runs straight through it (else the longer one). Stubs (rows ≤ 3 bit widths,
   or ≤ 1" row ends a wall pass cut short) are cut whenever the bit passes. The
   cutter stays down inside a pocket wherever it safely can: links up to 1" into
   the next leg are fed at depth, a hop onto floor already cut drops straight to
   just above it, and on a near tie the start that keeps it down wins.
   *Finish pass* (off by default): rows stop *Finish allowance* (0.015") short of
   every wall, and after the bottom depth one light pass runs along each wall
   (through the corner reliefs, half the bit past open edges); costs time (about
   50 s on a 60" closet side). Curved or odd-shaped pockets keep the spiral with
   its wall lap.
3. **Contours start at the nearest point on the edge**, not the nearest corner
   (tabbed parts excepted).
4. **Dados before any outline when dados go first.** With *Dados before holes
   (always)* on, every dado on the sheet is cut before any hole or outline — even
   with one bit — because cutting a part's outline early weakens the sheet while
   dados are still to cut. The extra rapid travel is accepted. Only with it off
   does one bit interleave per part (each part's dados right before its profile).
5. **Always dados before holes** (*Dados before holes (always)*, on by default:
   the shop runs one bit, no tool changer). Order: all dados → the dado bit's own
   holes → drill-only bits → profile bit (its holes, then cutouts and outlines).
   A hole wholly inside a dado starts at the dado's floor, so it's shallower.
   With one bit and a drill-only bit, the main bit is loaded twice (main → drill
   → main): the one allowed second load. Turned off, one bit drills holes first
   unless a drill-only bit has a hole in a dado (no reload).
   Holes deeper than *Peck holes deeper than* (0.5") from where they start are
   pecked in *Peck step* (3/8") strokes, lifting to *Peck retract* (0.05") above
   the hole's top between strokes.
6. **Holes and dados / rabbets before the part is cut out.** Either can come
   first, but each is done completely in one operation before the next starts
   (a bit's holes aren't split up by other work), and both are finished before
   the part's cutout (`npm test` checks every sample sheet, with one bit and
   with two, and plants a hole after a cutout to make sure it's caught). No
   pocket floor may be left with bumps or ridges: `npm test` samples every
   floor the bit can reach and fails on any spot left uncut.
7. **Shared cut lines:** a line two parts share is cut once; before it's cut,
   both parts have had their holes, dados and cutouts done (perimeter last for
   every part). Never trade a sheet for shared edge or run-out room.
7b. **Tabs hold to something that holds.** A tab only counts if the waste it
   ties to is anchored (a screw in it; no screws: the biggest skeleton piece),
   or it bridges to a part that is held — every part needs that chain, or the
   sheet warns. Tabs go in after the screws: one beside each screw (thin waste
   within 6" of a screw counts as held), one within 3" of every outside corner,
   then the rest into the biggest gaps (no bunching on one edge). `npm test`
   checks the chain (with a planted island part), the corners and the screws.
8. **Optimize toolpaths for time whenever possible** — machine time from the
   machine profile (speeds, acceleration, bit changes), not inches of travel.
9. **Every sample sheet must pass the cut simulation** (floors cut, nothing too
   deep, outlines through with tabs). Add a planted-fault test for any new check.
