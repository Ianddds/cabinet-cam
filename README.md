# Cabinet CAM (proof of concept)

Onshape Part Studio → flat parts → sheet nesting → G-code, for cabinet case parts.
Profiles and dados/rabbets only. Runs locally; 

See RULES.md before changing toolpath or FeatureScript code.

## Desktop app (installer)

Cabinet CAM can be installed like any Windows program: `Cabinet-CAM-Setup-x.y.z.exe` puts it in the Start menu and on the desktop, in its own window, with no terminal, no `npm install` and no separate Node (it's the same server and page, wrapped with Electron: `electron/main.js`).

- **Data** (tools, settings, remnants, jobs, Onshape keys) lives in `%APPDATA%\Cabinet CAM\data`, so installing a new version never touches it. **File → Open data folder** shows it; **File → Import from an old copy…** brings over the `data` folder and the keys from a copy that was run from a folder.
- **Onshape keys** are entered in the app: click **enter API keys** (or **keys**) in the top-right status. They're saved on that PC only. A `.env` file still works for the run-from-a-folder way.
- **Updates**: the app checks the GitHub releases it was built from a few seconds after it starts (and from **Help → Check for updates…**), downloads a newer one and offers to restart. That needs the repository to be public; with a private one, download the new Setup file from the Releases page and run it over the old install.
- **Building the installer** is done by GitHub (`.github/workflows/build.yml`): repository → **Actions** → **Build installer** → **Run workflow**, type the new version number (higher than the last, e.g. `0.2.0`). It runs the tests, builds the installer on Windows and publishes it under **Releases**. Windows shows an "unknown publisher" warning the first time (the installer isn't code-signed): **More info → Run anyway**.
- `.gitignore` keeps `.env`, `data/` and `node_modules/` out of the repository: keys and shop data never go to GitHub.
- Run it un-installed for a try: `npm install`, then `npm run app`. `npm start` (browser, as before) is unchanged. If port 3100 is taken the app uses another free port.

## Installing on a Windows PC (from a folder)

Unzip to a permanent folder (e.g. `C:\Cabinet CAM`) and double-click **Install Cabinet CAM.bat** once: it installs Node if needed, runs `npm install`, asks for the Onshape API keys (saved in `.env`) and puts a **Cabinet CAM** icon on the desktop that runs **Start Cabinet CAM.bat**. To update, unzip a newer `cabinet-cam.zip` over the folder and run **Update Cabinet CAM.bat** — `data\` (tools, settings, remnants, jobs) and `.env` are never in the zip, so each PC keeps its own. Details in `READ ME FIRST.txt`.

## Run it

Needs Node 22 or newer.

```
npm install
cp .env.example .env      # add your Onshape API keys
npm start                 # http://localhost:3100
npm test                  # offline pipeline test, writes sample files to test/out/
```

Click **Load sample** to try everything without Onshape.

## Workflow

1. Paste a Part Studio URL (any tab URL like `…/documents/<id>/w/<id>/e/<id>`) and click **Get parts**.
2. Check the parts table: identical parts are merged into one line with a qty. Untick parts you don't want, change qty or grain.
3. Set sheet, tool, cutting and machine settings (remembered in the browser).
4. **Nest & toolpath** → searches for the best nest per material + thickness (a few seconds). Review each sheet, then download.
5. **Save** stores the job (parts + settings) in `data/jobs/`.

## How parts are read from Onshape

The server evaluates `lib/extract.fs` against the Part Studio through the API. For each solid part it:

- takes the **largest planar face** as the reference face and measures thickness off it;
- treats planar faces **parallel** to it and between the two skins as **pocket floors** (dados, rabbets, grooves). Depth = distance from the face they open to;
- picks the side with the most pockets as **up** (the part is flipped if needed), and takes the **profile from the opposite face**, so dados running out of an edge don't distort the outline;
- returns edges so outlines can have notches (toe kicks) and inside cutouts.

Pockets are cut to their true shape. Touching dados of the same depth (e.g. a bottom rabbet, back groove and stretcher rabbet that Onshape merges into one L-shaped floor) are cleared as one pocket. The tool centre is kept where the cutter only touches that floor or the air outside the part, so walls are never gouged; edges that run out of the part are cut 0.02" past. A floor covering more than 60% of its part is treated as a modelling problem and not cut. Parts machined on both faces get a warning and only one side is cut.

### Attributes from your cabinet builder

If a part has a FeatureScript attribute that is a map, these keys are used when present:

| key | used for |
|---|---|
| `label` | part name shown in the app and on the sheet |
| `material` | nesting group; falls back to the Onshape part material, then "Unassigned" |
| `cabinetCode` (or `cabinet`) | cabinet column, e.g. `B36` |
| `grain` | `"length"`, `"width"` or `"none"` |
| `cnc` | `false` parts (face frame) start unticked |

These match what CabinetSchema's `makePartAttribute` already writes, so nothing needs adding.

**Cut records.** Cabinet build and Cabinet drawers also tag the long side walls of every dado, rabbet and groove they cut (`cabinetCut` on the faces; see `onshape/README.md`). When a floor's walls are tagged, its legs come straight from them: which way each dado runs and which leg owns a junction (the longer one). The sheet's G-code comment says `(cut records)` for those pockets. Floors with no tags, or tags that don't explain the whole floor, are worked out from the shape as before, so hand-modeled parts and pockets added later still cut. It all comes back in the same single API call. Bodies tagged `cabinetExcluded` (hardware, opening markers) or `cabinetLayout` (envelopes, faces) are skipped.

Grain `length` = along the part's long side. The sheet's grain runs along X (the 96" side).

## Tools

The **tool library** (Tools → Edit tool library…) holds every bit's defaults and is saved on the server in `data/tools.json`, so everyone using the app shares it. Every bit, router or drill, has the same fields: diameter, RPM, cut ipm, **plunge entry ipm**, **plunge entry depth**, **plunge ipm (after entry)**, stepdown, stepover and peck.

Each job picks a profile tool, a dado tool (or "same as profile") and which tools may drill holes. Saving a job stores a copy of the tools it used, so an old job regenerates the same code after the library is retuned (or a tool is deleted).

Every plunge into material — profiles, dados and drilling — runs at the plunge entry ipm down to the plunge entry depth, then at the plunge ipm (after entry). The tool rapids down to 0.05" above the surface before feeding.

**Machine profile** (Machine card): max X/Y and Z feed (ipm), X/Y and Z acceleration (in/s²) and how long a manual bit change takes. Take them from the controller (FluidNC: `max_rate_mm_per_min` and `acceleration_mm_per_sec2` per axis, ÷ 25.4). Rapids run at the max speeds (ShopBot jog speeds come from them too). Times are worked out the way the controller moves: every move capped by its feed and each axis's top speed, speeding up and slowing down at the acceleration, slowing at a corner only as much as its angle needs (junction deviation), plus bit changes and spindle spin-up. That time is what the summary shows and what every choice of cutting order is judged by.

**Simulate cut** (sheet preview): the toolpath is carved into a height grid of the sheet (0.04" cells, flat-end bits) and checked against the model: every bit of each pocket floor the bit can reach is cut to depth, nothing in a part is cut deeper than the model (corner reliefs are meant to), and with tabs every outline is cut right through except at its tabs (a round bit always leaves a sliver in an outline's inside corner, so those don't count). The preview shows the carved sheet; problem spots are ringed (yellow = left uncut, red = too deep, pink = not cut through) and the sheet says whether it passed. `npm test` runs the same check on every sample sheet, nested both ways with onion skin and with tabs, and plants faults to make sure it catches them.

**Shared cut lines** (Sheet card, on by default): parts nest exactly one profile-bit width apart instead of the Part spacing, so where two parts face each other their outline paths are the same line, and it's cut once. On the sample kitchen that's about a quarter less outline cutting on the same sheets (≈9 min saved with tabs, ≈12 min with onion skin).
- **Nesting** scores shared edge length right after sheet count (a near tie still goes to the bigger offcut), with a placement rule that puts each part where it touches the most parts already placed, and the last 40% of the search spent looking for more shared edge.
- **Cutting** treats every outline as pieces still to cut and always cuts the nearest piece next, whichever part it belongs to, so the cut flows along the lines from part to part. Each piece goes back and forth a stepdown at a time (no trip back to its start), the last level in the outline's own direction. A shared line is cut by whichever part gets there first and is then marked cut for the other.
- **Order is kept per part:** before a shared line is cut, the part on the other side has its holes, dados and cutouts done first, so no part's perimeter is cut before its own work. (`npm test` checks this, that every outline is cut to full depth, and that no outline move cuts into a part.)
- **Tabs** on a shared line are the shared bridges already described (both parts lift at the same spot).
- **Dado run-outs:** an open dado still runs half the bit past the edge where there's room. Where it runs out toward a part only a bit width away, it stops with the bit 0.03" clear of that part (the app lists those parts). Padding those parts apart instead was tried: even 0.05" stopped 23 1/4" sides fitting two-high on a 48" sheet (3 extra sheets on the sample).
- On a shared edge one part is climb-cut and the other conventional; both parts' sizes depend on the true bit diameter, as with any outline.

**Bit changes:** the first bit in a file is taken to be already in the machine, so the file starts cutting straight away (it just notes which bit it expects). The machine only stops (`M0` / ShopBot `PAUSE`) for a bit change after that, with the spindle off and Z at safe height, and waits for Cycle Start / Continue. Make sure the bit named at the top of each file is the one loaded.

**Arcs:** FluidNC and LinuxCNC files fit runs of short moves that lie on a circle (rounded corners, hinge cups, relief arcs, the pocket spiral) as G2/G3 arcs within 0.0008" — smaller files and smoother motion. Straight runs and ramps stay as lines. ShopBot files get the same arcs as `CG, ,x,y,i,j,T,±1` (1 = CW). Turn off with **Arcs (G2/G3 / CG)** on the Machine card. `npm test` walks every arc in the sample G-code and checks it stays on the toolpath.

## Toolpaths

Order on each sheet: holes → dados/rabbets → inside cutouts → outlines (perimeter) → onion-skin passes, with each bit loaded once (see the tool order under holes). When one bit does both dados and profiles, each part's dados are cut right before its outline instead of in a separate trip across the sheet. Travel is kept short: dados and parts are ordered nearest-neighbour, then improved by reversing runs and moving single items, judged on the real distance from where the tool finishes one item to where the next starts. Every contour starts at the nearest point on its edge, not just the nearest corner (parts with tabs start at a corner so tab placement isn't disturbed). The pass that frees parts (onion skin, or full depth without it) does parts under **Free small parts first** (Cutting card, default 50 sq in) first, then the rest; each group is its own trip, so 0 gives the least travel.

- **Dados, rabbets and grooves** follow one rule: *clear the middle first, finish the walls last.*
  - **Touching pockets are one operation.** Pockets on a part whose floors overlap or share an edge (a dado running into the back rabbet, drawer end dados meeting the bottom groove) are grouped; each depth is cut at its own stepdown. A depth that isn't cut yet counts as open for the others (it gets cut away anyway), so the shape comes out the same in any order — the order is chosen by time (every order tried in a dry run). Shallow first, the deeper pocket's wall pass runs straight across the junction; deep first, the dado runs out into the cleared rabbet.
  - **Finished edges vs open edges.** A finished edge is a wall (or the step down to a deeper floor) — part material on the far side. An open edge is the part's own edge. Finishing passes only follow finished edges; open edges get no pass, and everything runs half the bit (+0.02") past them so the cutter leaves the material completely (kept short of the next part; the app warns if part spacing doesn't allow it).
  - **Clearing** is rows along each leg's length (never across), up to 85% of the bit apart, **farthest from the finished edges first, working toward them**: a dado from the middle out, a rabbet from its open edge in toward its wall. Rows that would run along a finished edge are left to the finishing pass, so nothing is cut twice (a 3/4" dado with a 3/8" bit: one middle row, then the two wall passes).
  - **Finishing** is one pass along the finished edges (a U round a blind dado's walls and end, just the wall for a rabbet), carried on past any open edge it reaches, and taking each corner relief as it passes the corner. Nothing is cleared at a depth after its finishing pass starts. **Wall pass** (Cutting card): *Climb* (default — cleanest wall in ply with a clockwise spindle), *Conventional*, or *Either* (whichever travels least; on the sample job about 1.7 min faster than climb, mostly mirrored side panels whose back rabbet otherwise needs a trip back down its length). Clearing rows run either way: most are full-width slots, where direction doesn't matter.
  - **Ramped entries (off by default):** with **Pocket ramp angle** above 0 (default 0 = plunge straight down), pockets ramp down into the cut along the path they're about to cut instead of plunging; a steep angle (45–60°) keeps the ramp short. The ramp starts that far along the path and comes back down to the start, so the ramped stretch is then cut again at full depth. Z never goes faster than the bit's plunge rate.
  - **Round or odd shapes enclosed all round** (hinge cups, grommet holes) are a morphed spiral from the middle out, ending with the wall lap.
  - **Order and links:** each depth's starting end is chosen by trying each candidate in a dry run (time to get there, time inside, time on to the next depth); finishing passes are toured shortest-first; the bit stays down over cleared floor where it can.
  - **Checked:** `npm test` samples every pocket floor the bit can reach and fails on any spot left uncut, any spot where the bit is deeper than the floor under it, any clearing after a finishing pass, or a rabbet cleared toward its open edge.
  - Corner reliefs (T-bones) at stopped ends are found from the geometry, but the drawn size only marks where they go (the packages draw them for a 1/4" bit, `dadoBitDiameter`). They're cut with whatever dado tool is loaded: tool centre on the dado's end line, one tool radius in from the side wall, so the corner is cleared and the cut runs half a tool diameter past the end. Blind-end tongue notches can't be fixed at the CAM, so they use a separate `blindNotchBit` (1/2" by default — size it for the biggest dado bit you'd use).
- **Cutter stays down:** inside a pocket the bit only lifts when it has to. Rows are linked end to end with the stepover fed at depth along the end of the dado, reliefs are taken at the start or finish of the sequence so the tool feeds straight into them, the next depth level plunges where the last one ended, and the jump from one leg of an L or U pocket to the next is fed over floor already cleared. A move lifts only if it would touch a wall, cut across uncut floor, or travel back over cleared floor farther than **Dado stay-down travel** (Cutting card, default 3"; rapiding is faster than feeding that far). Round or angled pockets (hinge cups) still get a final lap.
- **Hop height (same part)** (Cutting card, default 0.1"): moving between cuts on one part — its holes, dados, cutouts and outline — the bit lifts only this far above the top instead of to Safe Z, as long as the move stays over that part. After a cut that goes right through (an outline, or a cutout whose slug could be loose) it goes back to Safe Z. 0 = always Safe Z.
- **Hold parts with** (Cutting card): *Onion skin* (needs vacuum: every cut stops 0.02" short, then a light final lap around each part frees it), *Tabs* (no skin pass; each part is cut to full depth in one go and tabs hold it; set "Only parts under" to 0 to tab every part), *Tabs + onion skin*, or *Nothing* (cut right through). Tabs only skips the whole skin lap, about a quarter of machine time. Settings saved before this choice keep what they did.
- **Tab ramp length** (default 1/4"): the bit ramps up onto each tab and back down off it while it keeps moving along the edge, instead of stopping and going straight up and down, so it leaves no mark on the part edge. The tab's top is the tab length; its foot is wider by the two ramps. 0 = straight up and down.
- **Where tabs go** is planned for the whole sheet. A tab only holds if there's material past the cut, so along each edge: facing the sheet skeleton → ordinary tabs; facing the sheet edge (or less than 1/4" of material before it, like the thin strip the trim margin leaves) → no tabs; facing another tabbed part (parts sit closer than two bit widths, so the two cuts overlap) → one shared tab that both parts lift over at the same spot, bridging them, and it counts toward both parts' tab count. No straight edge gets more than one tab per Spacing, rounded up (shared and ordinary tabs together; a 24" end gets at most 2), so a part whose other edges can't take tabs doesn't have them all piled onto its one free edge. Each part still keeps at least one tab to the skeleton when it has room, and the app warns if a group of parts would only be tabbed to each other.
- **Profiles:** outside offset by the tool radius, inside offset for cutouts, multiple depth passes. Onion skin leaves a thin layer for the final pass; overcut goes into the spoilboard.
- **Direction:** conventional by default (outside CW); climb is an option.
- Plunges are straight down at the plunge feed (no ramping yet).

## Nesting

**Nest & toolpath** searches for the best layout in the background (one worker per material, side by side) for up to **Nest search (sec)** (Sheet card, default 6; it stops early when nothing better turns up). It tries every combination of part order (longest side, area, perimeter, width, height, short side), placement rule (best short side, best long side, best area, bottom-left, contact point) and sheet filling (first sheet it fits / best fit over all sheets), then keeps making small changes to the best order. Best means **fewest sheets**, then the **biggest rectangular offcut on the last sheet** — shown dashed with its size on the last sheet of each material.

The winning layout is kept with the job (`nests`), so reopening a saved job, or changing settings that only affect toolpaths, gives exactly the same layout. If parts, quantities, grain, sheet size, trim or spacing change, a quick nest is shown until you click **Nest & toolpath** again. **Search again** tries from a different starting point and only replaces a layout with a better one. The summary shows the area minimum (total part area ÷ sheet) when the nest uses more sheets than that; grain locks usually account for the gap.

## Remnants

Offcuts become stock for later jobs. The rack is shared by everyone using the app (`data/remnants.json`), listed in the **Remnants** card by material.

- **Offcuts to keep.** After nesting, each sheet's clear rectangles big enough to keep (both sides ≥ **Keep: min side**, area ≥ **Keep: min sq in**; up to two per sheet) are shown dashed with their size. The layout is mirrored so the biggest one sits on the sheet's **zero corner**: the remnant keeps that corner and its two factory edges, so next time it goes back against the same corner. Where an offcut reaches the edge of the usable area it runs on out to the sheet edge. **An offcut can be L-shaped** (or T): the biggest clear rectangle plus the clear strip running on past one of its sides (that strip needs the min side and half the min area), kept as one piece — drawn as one outline, sized by its bounding box with an **L** after it, its two rectangles in the rack entry.
- **Cut free on the CNC** (on by default): after the parts, the tool cuts along the offcut's inside edges only (its edges on the sheet edge are left alone; an L's two rectangles are never cut apart), full depth, back and forth without lifting. The cut ends on the sheet edge, never past it.
- **Nesting on remnants.** With **Nest on remnants before full sheets** on, every remnant on the rack in the same material name and thickness is offered to the nest before full sheets. The nest still minimises full sheets first, then keeps the biggest offcut, then uses up the fewest remnants. A remnant sheet's tab and file are named by its number (R12); its parts sit inside **Remnant trim** (an L remnant's missing corner is blocked, with the trim kept clear of its inside edges too, and drawn grey on the sheet). Put the remnant's zero corner at the origin, grain along X.
- **Mark job as cut** (Sheets card). Marks the remnants the job was nested on as used and puts its offcuts on the rack with new numbers, which then show on the sheet previews (write them on the pieces). The job's layout is frozen from then on; **Undo "cut"** reverses it (offcuts another job already used are left alone). Loading new parts into a cut job starts a new job.
- **Add a remnant by hand** for pieces from elsewhere: material exactly as the parts' material, thickness, length along the grain, width.

If a remnant a saved layout used has gone from the rack (used by another job), the sheet list warns and **Nest & toolpath** re-nests. When the rack changes, **Nest & toolpath** searches again so new remnants get considered.

## Labels (Zebra)

**Labels…** on the Sheets card opens the label panel: settings, a preview of the current sheet's strip, and **Print / Download this sheet** or **all sheets**. Each sheet prints as one string, so the operator tears it off and labels that sheet's parts:

1. **Sheet label** — sheet (or remnant) number, material, job, part count, date.
2. **One label per part** — part name, **#number** (the same number is shown on the sheet preview and the printed layout, numbered left to right, then front to back), finished size, cabinet, material, grain direction in words ("Grain along 34 1/2"), sheet + job.
3. **Offcut labels** — "KEEP" with size and grain; after **Mark job as cut** they carry the remnant number (R12).

Only nested parts get labels; face frame / cut list parts never do. Each remnant on the rack also has a **label** link for a single label.

Settings: label width × height (default 2 × 1 in; other sizes scale), printer dpi (203 / 300 / 600), and where to send it:
- **Download .zpl file** — send it with Zebra Setup Utilities (Open communication with printer → Send file), or any raw-print tool.
- **Network printer** — the printer's IP (port 9100 by default); the server sends the ZPL straight to it.
- **Windows shared printer** — share the USB Zebra in Windows (Printer properties → Sharing) and enter the share name; the server prints with `copy /b file \\localhost\<name>`. Works when the app runs on that Windows PC.

## Printed sheet layouts

**Print layouts** (Sheets card) prints every sheet on an ordinary printer, one landscape page per sheet; **Print layout** next to a sheet's download prints just that one. Each page has the sheet drawn in black and white with each part's **#number** (matching the labels), name and size, dados shaded, offcuts to keep dashed (with their R number once the job is marked cut), the zero corner and grain direction, then a parts list (#, part, cabinet, size, grain, dados/cutouts). Paper size comes from the print dialog (Letter, Legal, A4…).

## Grain

Each part's grain is decided in this order:

1. **The part's own setting** — the Grain dropdown in the parts table (orange when overridden). Merged rows have a **split** link so one part (say one B36 side) can be changed on its own.
2. **As modeled** — the `grain` tag from the cabinet builder ("Auto" in the dropdown shows it).

Choices are *Along length*, *Across width* and *Any (best fit)*; *Any* lets the nester rotate the part whichever way fits, even in grained stock. Grainless stock (MDF) stays free unless a part is set otherwise. Sheet grain runs along X; each part's label on the sheet shows its grain (↔ / ↕). Re-fetching the same Part Studio keeps part overrides (rows whose parts now disagree are split automatically).

## Cut list

Parts tagged `cnc: false` (face frame stiles and rails from Cabinet build, or anything you tag that way) are never nested. They appear in a **Cut list** card instead, grouped by material, identical members combined, with lengths in fractions (nearest 1/32) and decimals and the cabinets each line belongs to. **Download CSV** or **Print**.

## Tabs

Cutting → **Leave tabs on part outlines**. Tabs go on straight runs of the outline, clear of corners. The count is the outline length ÷ spacing, never fewer than **Min per part**, shared out by run length. **Tab thickness** is the material left at the bottom; **Only parts under** limits tabs to small parts (0 = all). On any pass deeper than the tab top the tool lifts over each tab (the lift is tab length + tool diameter, so the tab left is the length you set) and plunges back down. Inside cutouts don't get tabs. Tabs work with or without onion skin.

## Screw hold-downs

Cutting → **Screw hold-downs** (for a table without vacuum). Every sheet gets **5 screws: one as close as it can get to each of the four corners of the area the parts take up, and one to its centre.** The nest packs screw-sized squares in among the parts, so the search can open a gap where the centre screw needs one (the squares are taken out again afterwards, so an unused one doesn't cut up the offcut). Where the centre falls in the middle of one big panel there's nothing to open, so the screw goes to the nearest room. For the corners, where parts cover a corner of the parts' area, the nest slides them straight in from that corner by just enough for a screw (along the length or across, whichever moves fewer parts), taking whatever they'd run into along in a chain, if there's room on the far side — e.g. a row of stretchers moved over into the gap at the other end of the row. Screws go where the parts leave room — scrap first; an offcut being kept only when there's no other answer: no scrap within 30" of where a corner screw wants to be, or within 12" for the centre screw (a keeper spot counts as that much farther) — e.g. a corner screw that would land in the keeper moves along the edge to the scrap where the parts start — and never on the lines that cut a keeper free. A thin strip where the screw only just fits counts as 1" farther. The nest search ranks, after sheet count: no missing screws and the centre screw at the centre, then how tightly the parts pack (in 2% steps), then the corner screws close to their corners, none in a keeper, none in a thin strip; it never adds a sheet for screws. No cut comes within **Head dia** ÷ 2 + **Clearance** of a screw centre (defaults 0.375" and 0.125": a 0.3125" radius, about a 1" square of sheet per screw); dado run-outs stop short of it too.

On the machine: the first bit drills the 5 holes (**Hole depth**, default 0.25: with a bit as wide as the head that's a counterbore the head sits down in, below anything that moves over the sheet; 0 = right through, and the run warns if the heads would pull through), the spindle stops, the machine parks (the Park position, or X0 Y0) and the file stops (`M5` + `M0`, ShopBot `C7` + `PAUSE`) with the message *Drive a screw in each of the 5 holes…*. Drive the screws, continue, and the job runs on (spindle back on with its spin-up). The time estimate counts the stop like a bit change. The preview draws each screw and its clear ring in blue; **Simulate cut** flags any cut inside a ring (blue), and `npm test` checks every sample sheet both nest ways and plants a fault to make sure it's caught. Remnants get screws the same way (no held centre square, so a remnant isn't kept from fitting a part).

### Placing screws by hand

On any sheet, **Place screws** (above the layout) lets you put the hold-down screws where you want them: **click** an empty spot to add one, **drag** one to move it, **right-click** one to remove it. Each ring is the screw's clearance; it turns **red** when the spot is no good (on a part, off the edge of the stock, or a cut comes inside the clearance) and the job warns about it. When you drop a screw the sheet's toolpath is redone, so cuts and dado run-outs keep clear of it and the screw holes are drilled first, followed by the stop. Hand-placed screws are drilled even when automatic **Screw hold-downs** is off, so you can screw down just the sheets that need it. **Back to automatic** returns that sheet to the nest's screws; **Remove all** means no screws (and no stop) on that sheet. Hand-placed screws are saved with the job, per sheet, and are dropped when the layout changes (Search again, different parts or settings).

## Holes

Round holes are found from the geometry (no tagging needed) and matched against the **Drills** list in settings plus the loaded router bits (within 0.006"):

| Hole | Result |
|---|---|
| Blind, matches a drill/bit | drilled to depth: entry ipm for the entry depth, then drill ipm (optional pecks) |
| Blind, bigger than the bit (hinge cups) | milled as a round pocket |
| Through, matches a drill/bit | drilled through (into the spoilboard by the overcut) |
| Through, bigger | inside contour only — the slug drops out |
| Smaller than everything | flagged, not cut |

Tool order on a sheet: drilling first, and each bit loaded once with everything it does: each drill-only bit (its holes) → dado tool (its holes, then dados) → profile tool (its holes, then cutouts and outlines). When the dado tool is the profile tool that's a single load: holes, then each part's dados with its profile. Holes on the face opposite the dados are flagged as needing a flip.

## Posts

| Post | Notes |
|---|---|
| FluidNC `.nc` | G20/G90, `M0` pause for tool loads, `M3 S…`/`M5`, `G4` spin-up dwell |
| LinuxCNC `.ngc` | Same, with `(MSG, …)` prompts |
| ShopBot `.sbp` | Laid out like ShopBot's own Vectric/PartWorks post: units check (`IF %(25)=1 THEN GOTO UNIT_ERROR`), `SA`, `CN, 90`; `MS` in **inches per second**; `J3`/`M3`/`MZ`/`CG`; bit changes after the first as `&Tool = n` + `C9` (tool # from the library, 1 to **Highest tool #**, default 30 — a bit with no number gets a `PAUSE` asking to zero Z); spindle `C6`/`C7` (editable); `END` then `UNIT_ERROR:` / `CN, 91`. No `JS`: jog speed is a machine setting that outlasts the file, so it's left alone. |

### Post files (.pp)

Besides the three built-in posts, the **Post** list on the Machine card has a **Post files (.pp)** group: Vectric-format post-processors (the same `.pp` files VCarve, Aspire and PartWorks use) kept in this computer's **posts folder** — `data\posts` when run from a folder, `%APPDATA%\Cabinet CAM\data\posts` in the installed app (its path shows under the Post list). **Import post (.pp)…** checks a file and copies it there; **Remove this post file** deletes the selected one. Each shop keeps its own.

The first time the app starts it puts three starter posts there — **Cabinet CAM FluidNC / LinuxCNC / ShopBot.pp** — written to match the built-in posts, as a starting point to edit or copy (change `POST_NAME` in a copy so both show). After that the folder is yours: an edited or deleted starter post isn't put back.

What Cabinet CAM reads from a `.pp` (`public/lib/vpp.js`): `POST_NAME`, `FILE_EXTENSION`, `UNITS` (`INCHES` / `MM` — positions and feeds converted), line numbering, `SUBSTITUTE`; `VAR` lines (`[TAG|A or C|prefix|format|multiplier]`); and the blocks `HEADER`, `FOOTER`, `TOOLCHANGE`, `NEW_SEGMENT`, `RAPID_MOVE`, `FEED_MOVE`, `PLUNGE_MOVE`, `CW_ARC_MOVE`, `CCW_ARC_MOVE` and their `FIRST_` versions. Text tags: `[T]` (tool # from the library), `[TOOLNAME]`, `[TOOLPATH_NAME]`, `[FILENAME]`, `[DATE]`, `[TIME]`, `[XY_ORIGIN]`, `[Z_ORIGIN]`, plus `[MATERIAL]`, `[MESSAGE]`, `[SPINUP]`. How the moves map: the **first bit goes in the HEADER** (whatever the post does there — Vectric's ShopBot posts call `C9` for it); each later bit runs **TOOLCHANGE**; **NEW_SEGMENT** starts each part / operation; a post whose moves carry no feed tag (ShopBot's `MS,[FC],[FP]`) gets just the speed lines of NEW_SEGMENT again when a speed changes; arcs are fitted only when the post has both arc blocks; a `FIRST_` block is skipped when it would leave out an axis that moves. The screw hold-down stop runs Cabinet CAM's own **OPERATOR_STOP** block (in the starter posts), or the post's TOOLCHANGE block if it has none. Tags Cabinet CAM has no value for come out blank, with a warning when the file is made. `npm test` replays files from every post in `posts/` and a Vectric-style ShopBot post (`test/fixtures`) and checks every position against the toolpath.

There's no ATC handling. Every tool load pauses for a manual change. If dados use the profile tool there is a single load at the start.

Origin is the front-left corner of the sheet. Z0 can be the material top or the spoilboard.

**Air-cut every post before running material.** Check the C6/C7 custom cuts on your ShopBot and that your FluidNC build accepts `M0`.

## Files

`onshape/` holds the cabinet Feature Studios (layout, build, drawers, fronts, materials, schema, tag) — see `onshape/README.md` for the attribute contract between them and this app.

```
server.js              Express server: status, OAuth, /api/extract, /api/sample, jobs
lib/extract.fs         FeatureScript run inside Onshape
lib/onshape.js         API client (API keys or OAuth), FS value decoder
lib/parts.js           raw extraction → normalized inch parts, merge identical parts
public/lib/geometry.js polygon helpers (offset, chaining, rotation)
public/lib/nest.js     MaxRects nesting with grain lock + layout search
public/lib/nest-worker.js runs a search off the page's main thread
public/lib/labels.js   Zebra (ZPL) part / sheet / remnant labels + preview
public/lib/printsheets.js printable sheet layouts (one page per sheet)
public/lib/toolpath.js dado + profile toolpaths
public/lib/post.js     FluidNC / LinuxCNC / ShopBot posts
public/lib/settings.js defaults and material grouping
public/app.js          UI
test/                  synthetic Onshape data + pipeline test
```

## Not done yet (next steps)

- Assemblies (multiple instances of a Part Studio) instead of a single Part Studio
- Ramped entries and lead-ins, ramped tabs
- True-shape nesting for arched or radius parts
- Part labels / cut list PDF

