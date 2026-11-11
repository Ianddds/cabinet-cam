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
2. **Pockets: clear the middle first, finish the walls last.** Touching pockets
   are one operation; any depth order cuts the same shape (a depth not cut yet
   counts as open), so the order is picked by time. Clearing rows run along each leg (never across),
   farthest from the finished edges first — a rabbet from its open edge in to
   its wall. Finishing passes follow finished edges only (walls, steps), through
   the corner reliefs, and run half the bit past any open edge. No finish
   allowance (chip clearance matters more). The cutter stays down inside a
   pocket wherever it safely can.
3. **Contours start at the nearest point on the edge**, not the nearest corner
   (tabbed parts excepted).
4. **One bit for dados and profiles → interleave per part** (no separate trip for
   all the dados).
5. **Drilling first, and each bit is loaded once per sheet** with everything it
   does (its holes first). Manual bit changes cost far more than a few inches of
   rapid travel.
6. **Order per part: holes, then dados / rabbets, then cutouts, then the
   perimeter.** No pocket floor may be left with bumps or ridges: `npm test`
   samples every floor the bit can reach and fails on any spot left uncut.
7. **Shared cut lines:** a line two parts share is cut once; before it's cut,
   both parts have had their holes, dados and cutouts done (perimeter last for
   every part). Never trade a sheet for shared edge or run-out room.
8. **Optimize toolpaths for time whenever possible** — machine time from the
   machine profile (speeds, acceleration, bit changes), not inches of travel.
9. **Every sample sheet must pass the cut simulation** (floors cut, nothing too
   deep, outlines through with tabs). Add a planted-fault test for any new check.
