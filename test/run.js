// Offline pipeline test: synthetic extraction -> normalize -> nest -> toolpath -> post.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './clipper-node.js';
import { sampleKitchen, rawPart, sampleCabinetPlaces } from './synthetic.js';
import { cabinetModel, drawerBoxes, constructionHTML } from '../public/lib/construction.js';
import { moveRoom, applyMoves, moveKey, partKey, screwRoom } from '../public/lib/moveparts.js';
import { parseProgram, timeline } from '../public/lib/gcodesim.js';
import { cutLevels, cutMesh } from '../public/lib/exactcut.js';
import { ShapeUtils, Vector2 } from '../public/lib/vendor/three/three.module.min.js';
import { post as postFile } from '../public/lib/post.js';
import { inRegion, difference, offset, union, area, intersect } from '../public/lib/clip.js';
import { SHAPE_ORDERS, placeShapes, isShapePart } from '../public/lib/shapes.js';
import { normalizeAll } from '../lib/parts.js';
import { decode } from '../lib/onshape.js';
import { nestParts, placedGeometry, applySolution, nestKey } from '../public/lib/nest.js';
import { sheetTabs, minTabsFor, sheetToolpaths, fillHoleBites, placeTabs, legsOf, splitLobes, legsFromWalls, offcutCutLines, screwR, screwCheck } from '../public/lib/toolpath.js';
import { postGcode, postShopBot, post as postAny, fitArcs } from '../public/lib/post.js';
import { parsePP } from '../public/lib/vpp.js';
import { carve, check as simCheck } from '../public/lib/sim.js';
import { machineTime } from '../public/lib/machine.js';
import { DEFAULT_SETTINGS, groupParts, mergeSettings, holdDownOf } from '../public/lib/settings.js';
import { DEFAULT_LIBRARY, resolveTools } from '../public/lib/tools.js';
import { cutListRows, cutListCSV, fraction } from '../public/lib/cutlist.js';
import { applyGrain, splitPart, carryOverrides, effectiveGrain } from '../public/lib/grain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL', msg); } };

// --- decoder ---
const fsv = {
  btType: 'com.belmonttech.serialize.fsvalue.BTFSValueArray',
  value: [{
    btType: 'com.belmonttech.serialize.fsvalue.BTFSValueMap',
    value: [
      { btType: 'BTFSValueMapEntry', key: { btType: 'BTFSValueString', value: 'name' }, value: { btType: 'BTFSValueString', value: 'Side' } },
      { btType: 'BTFSValueMapEntry', key: { btType: 'BTFSValueString', value: 'z' }, value: { btType: 'BTFSValueNumber', value: -0.01 } },
      { btType: 'BTFSValueMapEntry', key: { btType: 'BTFSValueString', value: 'u' }, value: { btType: 'BTFSValueUndefined' } },
    ],
  }, { typeName: 'BTFSValueNumber', message: { value: 3 } }],
};
const d = decode(fsv);
check(d[0].name === 'Side' && d[0].z === -0.01 && d[0].u === null && d[1] === 3, 'decoder ' + JSON.stringify(d));

// --- normalize ---
const raw = sampleKitchen();
const { parts, errors } = normalizeAll(raw);
check(errors.length === 0, 'normalize errors: ' + errors.join('; '));
const sides = parts.filter((p) => p.name.includes('Side'));
check(sides.length === 2 && sides.every((x) => x.qty === 3), `left and right sides are mirror parts, 3 each (got ${sides.map((s) => s.qty)})`);
const s = sides[0];
check(Math.abs(s.width - 34.5) < 1e-3 && Math.abs(s.height - 23.25) < 1e-3, `side oriented long-way ${s.width}x${s.height}`);
check(s.outline.length === 6, `side outline has toe-kick notch (${s.outline.length} pts)`);
check(s.pockets.length === 2, 'side has 2 pockets');
const ff = parts.find((p) => p.name === 'B36-2-SIDE-R');
check(ff && ff.pockets.length === 6, `frameless side keeps its merged floor + front rabbet + 4 pin holes (${ff?.pockets.length}) ${ff?.warnings}`);
check(ff && ff.warnings.length === 0, 'frameless side has no warnings: ' + ff?.warnings);
check(!parts.some((p) => /slide|envelope/.test(p.name)), 'hardware and layout bodies skipped');
const p7 = parts.find((p) => p.name === 'Part 7');
check(p7 && p7.untagged && !p7.include, 'untagged body listed but not included');
const db = parts.find((p) => p.name === 'B36-DRAWER_BACK-1');
check(db && db.pockets.length === 1 && db.pockets[0].depth === 0.25, 'drawer back keeps its groove side up: ' + JSON.stringify(db?.pockets.map((q) => q.depth)));
check(db && db.warnings.some((w) => /other face/.test(w)), 'drawer back warns about hook holes on the other face');
check(db && db.outline.length === 8, 'drawer back outline has both rear notches (' + db?.outline.length + ')');
const rel = parts.find((p) => p.name === 'RELIEF-SIDE');
check(rel && rel.pockets.length === 1, 'relief dado read as one pocket');
{
  const { core, lobes } = splitLobes(union(rel.pockets[0].loops, []));
  check(lobes.length === 2 && lobes.every((l) => Math.abs(l.r - 0.125) < 0.003), `two R0.125 reliefs found (${lobes.map((l) => l.r.toFixed(3))})`);
  check(legsOf(core) !== null, 'relief dado core is square-edged');
  // overlapping reliefs (big bit, narrow dado) merge into one blob: still two lobes
  const rr = 0.1875, y0 = 0, y1 = 0.705, x1 = 4;
  const arc = (cy, a0, a1) => { const o = []; for (let k = 1; k < 16; k++) { const a = a0 + ((a1 - a0) * k) / 16; o.push([x1 + rr * Math.cos(a), cy + rr * Math.sin(a)]); } return o; };
  const c1 = arc(y0 + rr, -Math.PI / 2, Math.PI / 2), c2 = arc(y1 - rr, -Math.PI / 2, Math.PI / 2);
  const merged = union([[[0, y0], [x1, y0], [x1, y1], [0, y1]], [[x1, y0], ...c1, [x1, y0 + 2 * rr]], [[x1, y1 - 2 * rr], ...c2, [x1, y1]]], [], 'nonzero');
  const sm = splitLobes(merged);
  // cut records: walls that explain the floor give its legs; partial records fall back
  const Lfloor = union([[[0, 0], [10, 0], [10, 0.7], [0, 0.7]], [[9.3, 0], [10, 0], [10, 8], [9.3, 8]]], [], 'nonzero');
  const lr = legsFromWalls(Lfloor, [
    { cut: 'a', seg: [[0, 0.7], [9.3, 0.7]] },
    { cut: 'b', seg: [[9.3, 0.7], [9.3, 8]] }, { cut: 'b', seg: [[10, 0], [10, 8]] }]);
  check(lr && lr.length === 2 && lr[0].alongX === true && lr[1].alongX === false && lr[1].clip, `L floor legs from records (${JSON.stringify(lr && lr.map((l) => [l.alongX, l.x0, l.y0, l.x1, l.y1]))})`);
  check(legsFromWalls(Lfloor, [{ cut: 'a', seg: [[0, 0.7], [9.3, 0.7]] }]) === null, 'incomplete records fall back to the shape');
  check(sm.lobes.length === 2 && sm.lobes.every((l) => Math.abs(l.r - rr) < 0.01), `merged reliefs split into two (${sm.lobes.map((l) => l.r.toFixed(3))})`);
}
const panel = parts.find((p) => p.name === 'Grommet Panel');
check(panel.holes.length === 4 && panel.grain === 'none' && panel.material === '3/4 MDF', 'panel hole/grain/material');
console.log('parts:', parts.map((p) => `${p.qty}x ${p.name} ${p.width}x${p.height}x${p.thickness} [${p.material}] pockets=${p.pockets.length}`).join('\n       '));

// --- nest + toolpath + post per group ---
let liftTotal = 0, pocketTotal = 0, arcTotal = 0;
const cfg = { ...structuredClone(DEFAULT_SETTINGS), ...resolveTools(DEFAULT_SETTINGS, DEFAULT_LIBRARY) };
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
for (const g of groupParts(parts)) {
  const nest = nestParts(g.parts, { ...cfg.sheet, respectGrain: cfg.respectGrain });
  check(nest.unplaced.length === 0, 'unplaced: ' + JSON.stringify(nest.unplaced));
  console.log(`\n${g.key}: ${nest.sheets.length} sheet(s)`, nest.sheets.map((x) => `${x.placements.length} parts ${(x.yield * 100).toFixed(0)}%`).join(', '));

  nest.sheets.forEach((sheet, i) => {
    // no overlaps, inside trim
    const boxes = sheet.placements.map((pl) => placedGeometry(pl).box);
    for (const b of boxes) {
      check(b.x0 >= cfg.sheet.trim - 1e-6 && b.y0 >= cfg.sheet.trim - 1e-6 &&
        b.x1 <= cfg.sheet.sheetW - cfg.sheet.trim + 1e-6 && b.y1 <= cfg.sheet.sheetH - cfg.sheet.trim + 1e-6, 'part inside trim ' + JSON.stringify(b));
    }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b], sp = cfg.sheet.spacing - 1e-6;
      const sep = A.x1 + sp <= B.x0 || B.x1 + sp <= A.x0 || A.y1 + sp <= B.y0 || B.y1 + sp <= A.y0;
      check(sep, `parts ${a},${b} closer than spacing`);
    }
    // grain: grain-locked parts not rotated
    for (const pl of sheet.placements) if (pl.part.grain === 'length') check(!pl.rotated, `${pl.part.name} rotated against grain`);

    const tp = sheetToolpaths(sheet, { ...cfg, thickness: g.thickness });
    const st = tp.stats;
    const r = cfg.tool.dia / 2;
    check(st.minX >= -r - 0.05 && st.minY >= -r - 0.05 && st.maxX <= cfg.sheet.sheetW + r && st.maxY <= cfg.sheet.sheetH + r, 'moves inside sheet ' + JSON.stringify(st));
    check(st.minZ >= -(g.thickness + cfg.overcut) - 1e-6, 'min Z ' + st.minZ);
    for (const w of tp.warnings) console.log('  warn:', w);

    // low hops (below safe Z) only happen over one part, never across the sheet
    {
      const reach = Math.max(cfg.tool.dia, (cfg.dadoSameTool ? cfg.tool : cfg.dadoTool).dia) / 2 + 0.06;
      const regs = sheet.placements.map((pl) => offset([placedGeometry(pl).outline], reach, 'miter'));
      let prevM = null, bad = 0, joinedSec = false;
      const allRegs = union(regs.flat(), [], 'nonzero');
      for (const m of tp.moves) {
        if (m.comment) { joinedSec = / \+ .* pocket /.test(m.comment); continue; }
        if (m.x == null) continue;
        if (prevM && m.g === 0 && m.z < cfg.safeZ - 1e-9 && Math.hypot(m.x - prevM.x, m.y - prevM.y) > 1e-6 && m.z > 0) {
          // (a dado joined across parts hops between those parts, over the gap between them)
          const ok = regs.some((rg) => [0, 0.25, 0.5, 0.75, 1].every((t) => inRegion([prevM.x + (m.x - prevM.x) * t, prevM.y + (m.y - prevM.y) * t], rg)))
            || (joinedSec && [0, 0.25, 0.5, 0.75, 1].every((t) => inRegion([prevM.x + (m.x - prevM.x) * t, prevM.y + (m.y - prevM.y) * t], allRegs)));
          if (!ok) bad++;
        }
        prevM = m;
      }
      check(bad === 0, `${bad} low hop(s) leave the part they're on`);
    }

    // gouge + coverage check on every pocket move
    const rTool = (cfg.dadoSameTool ? cfg.tool : cfg.dadoTool).dia / 2;
    const geos = sheet.placements.map((pl) => placedGeometry(pl));
    const floors = geos.flatMap((gg) => gg.pockets.map((q) => ({ q, gg })));
    const pmoves = tp.moves.filter((m) => m.op === 'pocket' && m.g === 1 && m.z < -1e-6);
    let gouges = 0, prevM = null;
    for (const m of tp.moves) {
      if (m.x == null) continue;
      if (prevM && (m.op === 'pocket' || m.op === 'finish') && m.g === 1 && m.z < -1e-6) {
        for (let t = 0; t <= 1; t += 0.05) {
          const cx = prevM.x + (m.x - prevM.x) * t, cy = prevM.y + (m.y - prevM.y) * t;
          for (let a = 0; a < 16; a++) {
            const px = cx + (rTool - 0.002) * Math.cos((a * Math.PI) / 8), py = cy + (rTool - 0.002) * Math.sin((a * Math.PI) / 8);
            const inPart = geos.some((gg) => inRegion([px, py], [gg.outline, ...gg.holes]));
            const inFloor = floors.some(({ q }) => inRegion([px, py], q.loops));
            if (inPart && !inFloor) gouges++;
          }
        }
      }
      prevM = m;
    }
    check(gouges === 0, `pocket toolpaths gouge walls at ${gouges} sample points`);
    // coverage: floor points away from walls must be within tool radius of the path
    const segs = [];
    prevM = null;
    for (const m of tp.moves) { if (m.x == null) continue; if (prevM && (m.op === 'pocket' || m.op === 'relief' || m.op === 'finish') && m.g === 1 && m.z < -1e-6) segs.push([prevM, m]); prevM = m; }
    const dseg = (p, [a, b]) => { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / L2)); return Math.hypot(p[0] - a.x - t * dx, p[1] - a.y - t * dy); };
    let missed = 0, tested = 0;
    for (const { q } of floors) {
      const xs = q.loops.flat().map((p) => p[0]), ys = q.loops.flat().map((p) => p[1]);
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.06) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 0.06) {
        if (!inRegion([x, y], q.loops)) continue;
        tested++;
        if (!segs.some((sg) => dseg([x, y], sg) <= rTool + 1e-3)) missed++;
      }
    }
    if (tested) check(missed / tested < 0.01, `pocket coverage: ${missed}/${tested} floor points left uncut`);
    if (tested) console.log(`  pockets: ${pmoves.length} moves, ${tested} floor samples, ${missed} uncut (corners)`);

    const drillNotes = tp.moves.filter((m) => m.comment && m.comment.startsWith('Drill')).map((m) => m.comment);
    if (drillNotes.length) console.log('  ' + drillNotes.join(' | '));
    if (g.key.startsWith('BB 3/4')) check(drillNotes.some((c) => /Drill 4 holes with 5 mm/.test(c)), 'shelf pins drilled with the 5 mm drill');
    if (g.key.startsWith('3/4 MDF')) {
      check(drillNotes.some((c) => /Drill 1 hole with 1\/4/.test(c)), '1/4 through hole drilled');
      check(tp.moves.some((m) => m.comment && /pocket 1\.378x1\.378/.test(m.comment)), 'hinge cup milled as a round pocket');
      check(tp.warnings.some((w) => /0\.118" through hole has no matching drill/.test(w)), '3 mm hole flagged');
      const dm = tp.moves.filter((m) => m.op === 'drill' && m.plunge);
      check(dm.some((m) => m.f === 15 && Math.abs(m.z + 0.06) < 1e-9) && dm.some((m) => m.f === 40), 'drill uses entry ipm to entry depth, then drill ipm');
      const drillZ = tp.moves.filter((m) => m.op === 'drill' || m.plunge).map((m) => m.z);
      check(Math.min(...drillZ) >= -(g.thickness + cfg.overcut) - 1e-9, 'drill depth within overcut');
    }
    // every plunge into material starts at the tool's entry ipm, then switches
    const profPl = tp.moves.filter((m) => m.plunge && m.op === 'profile');
    if (profPl.length) check(profPl.some((m) => m.f === cfg.tool.entryFeed && Math.abs(m.z + cfg.tool.entryDepth) < 1e-9) &&
      profPl.some((m) => m.f === cfg.tool.drillFeed), 'profile plunges use entry ipm then plunge ipm');
    // dados / rabbets: no cutting move across a leg (every pocket feed runs along its leg)
    {
      const legBoxes = [];
      for (const { q } of floors) {
        const { core } = splitLobes(union(q.loops, []));
        for (const lg of legsOf(core) || []) legBoxes.push(lg);
      }
      let across = 0, prevP = null, done = [], spiralSec = false;
      const segD = (p, a, b) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
        return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      };
      // a move over floor already cleared at this depth isn't cutting across anything
      const overCleared = (a, b, z) => {
        for (let t = 0; t <= 1.0001; t += 0.05) {
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const nearEnd = Math.hypot(p[0] - a[0], p[1] - a[1]) <= rTool + 1e-6 || Math.hypot(p[0] - b[0], p[1] - b[1]) <= rTool + 1e-6;
          if (!nearEnd && !done.some((d) => Math.abs(d.z - z) < 1e-6 && segD(p, d.a, d.b) <= rTool * 0.9 + 1e-3)) return false;
        }
        return true;
      };
      for (const m of tp.moves) {
        if (m.comment) { done = []; spiralSec = /\((spiral|inside out)\)/.test(m.comment); continue; }
        if (m.x == null) continue;
        if (prevP && !spiralSec && m.op === 'pocket' && m.g === 1 && !m.plunge && m.z < -1e-6) {
          const dx = m.x - prevP.x, dy = m.y - prevP.y;
          if (Math.hypot(dx, dy) > 1e-4) {
            const mx = (m.x + prevP.x) / 2, my = (m.y + prevP.y) / 2;
            const lg = legBoxes.find((b) => mx >= b.x0 - 0.05 && mx <= b.x1 + 0.05 && my >= b.y0 - 0.05 && my <= b.y1 + 0.05);
            // a stepover at a row end is fine; a full cut across the dado is not
            const crossLen = lg ? (lg.alongX ? Math.abs(dy) : Math.abs(dx)) : 0;
            if (lg && crossLen > 1e-4 && (crossLen > rTool * 2.1 + 1e-6 || Math.hypot(dx, dy) > rTool * 2.1 + 1e-6) &&
              !overCleared([prevP.x, prevP.y], [m.x, m.y], m.z)) across++;
            done.push({ a: [prevP.x, prevP.y], b: [m.x, m.y], z: m.z });
          }
        }
        prevP = m;
      }
      check(across === 0, `${across} pocket move(s) run across a dado`);
      // cutter stays down inside a pocket: count lifts after the first entry
      let cur = null, entered = false, prevXY = null;
      const lifts = {};
      for (const m of tp.moves) {
        if (m.comment) { cur = / pocket /.test(m.comment) ? m.comment : null; entered = false; if (cur) lifts[cur] = 0; continue; }
        if (!cur || m.x == null) continue;
        // a sideways G0 at clearance height after cutting started = a lift
        if (m.g === 1 && m.z < 0) entered = true;
        else if (entered && m.g === 0 && m.z > 0 && m.z <= 0.051 && prevXY && (Math.abs(m.x - prevXY[0]) > 1e-6 || Math.abs(m.y - prevXY[1]) > 1e-6)) lifts[cur]++;
        prevXY = [m.x, m.y];
      }
      const reliefKey = Object.keys(lifts).find((k) => /RELIEF/.test(k));
      for (const k of Object.keys(lifts)) if (/B36-2-SIDE-R pocket 30|RELIEF/.test(k)) check(/\(cut records\)/.test(k), `legs from cut records: ${k}`);
      if (reliefKey) {
        check(lifts[reliefKey] === 0, `relief dado cut without lifting (${lifts[reliefKey]} lifts)`);
        // reliefs drawn for a 1/4 bit, cut with the loaded bit: centres on the end
        // line, one tool radius in from each side wall (0.875 wide dado)
        // relief centres = where the tool doubles back (in to the centre, back out
        // along the dado), or where the pocket ends inside a relief
        let inRel = false;
        const seq = [];
        for (const m of tp.moves) {
          if (m.comment) { inRel = m.comment === reliefKey; continue; }
          if (!inRel || m.x == null || m.g !== 1) continue;
          const lastP = seq.at(-1);
          if (!lastP || Math.hypot(lastP.x - m.x, lastP.y - m.y) > 1e-6) seq.push({ x: m.x, y: m.y, op: m.op });
        }
        const rc = [];
        seq.forEach((p, k) => {
          const a = seq[k - 1], b = seq[k + 1];
          if (!a) { if (p.op === 'relief') rc.push([p.x, p.y]); return; }   // started in a relief
          const ux = p.x - a.x, uy = p.y - a.y;
          const back = b ? (ux * (b.x - p.x) + uy * (b.y - p.y)) / (Math.hypot(ux, uy) * Math.hypot(b.x - p.x, b.y - p.y) || 1) < -0.7 : p.op === 'relief';
          if (back && p.op === 'relief') rc.push([p.x, p.y]);
        });
        const sep = rc.length === 2 ? Math.hypot(rc[0][0] - rc[1][0], rc[0][1] - rc[1][1]) : -1;
        check(Math.abs(sep - (0.875 - 2 * rTool)) < 0.002, `reliefs placed for the loaded bit (${rc.length} centres, ${sep.toFixed(4)} apart)`);
      }
      liftTotal += Object.values(lifts).reduce((a, b) => a + b, 0); if (process.env.LIFTS) for (const [k, v] of Object.entries(lifts)) if (v) console.log("  lifts", v, k);
      pocketTotal += Object.keys(lifts).length;
    }
    const base = `${g.key.replace(/[^\w.-]+/g, '_')}_sheet${i + 1}`;
    const meta = { title: `${g.key} sheet ${i + 1}/${nest.sheets.length}`, material: g.material };
    const gc = postGcode(tp.moves, { ...cfg, post: 'fluidnc', thickness: g.thickness }, meta);
    const sbp = postShopBot(tp.moves, { ...cfg, post: 'sbp', thickness: g.thickness }, meta);
    fs.writeFileSync(path.join(out, base + '.nc'), gc);
    fs.writeFileSync(path.join(out, base + '.sbp'), sbp);
    check(!/NaN|undefined/.test(gc + sbp), 'NaN/undefined in post output');
    // the first bit is already in the machine: only later bit changes stop it
    {
      const changes = tp.moves.filter((m) => m.toolchange).length;
      const m0 = gc.split('\n').filter((l) => l.trim() === 'M0').length;
      const SL = sbp.split('\n').map((l) => l.split("'")[0].trim());
      const pauses = SL.filter((l) => l === 'PAUSE' || l === 'C9').length;
      check(m0 === Math.max(0, changes - 1) && pauses === Math.max(0, changes - 1), `stops only for bit changes after the first (${changes} bits: ${m0} M0, ${pauses} PAUSE/C9)`);
      const firstCut = gc.split('\n').findIndex((l) => /^G1 /.test(l));
      check(!gc.split('\n').slice(0, firstCut).some((l) => l.trim() === 'M0'), 'no stop before the first cut');
      // ShopBot layout matches ShopBot's own post
      const sbpCut = SL.findIndex((l) => /^(M3|MZ|CG),/.test(l));
      check(SL[SL.findIndex((l) => l.startsWith('IF %(25)=1'))] && SL.includes('CN, 90') && SL.includes('UNIT_ERROR:') && SL.includes('CN, 91'), 'sbp: units check and CN 90 / 91');
      check(!SL.some((l) => /^JS\b/.test(l)), 'sbp: no JS (jog speed stays a machine setting)');
      check(!SL.slice(0, sbpCut).some((l) => l === 'C9' || l === 'PAUSE'), 'sbp: no tool change before the first cut');
      const c9At = SL.map((l, k) => (l === 'C9' ? k : -1)).filter((k) => k >= 0);
      check(c9At.every((k) => /^&Tool = \d+$/.test(SL[k - 1])), 'sbp: every C9 comes right after &Tool = n');
      check(SL.indexOf('END') < SL.indexOf('UNIT_ERROR:'), 'sbp: END before the UNIT_ERROR block');
      // walk every CG and check it stays on the toolpath
      const segs = [];
      { let pm = null; for (const m of tp.moves) { if (m.x == null) continue; if (pm && m.g === 1) segs.push([[pm.x, pm.y], [m.x, m.y], m.z]); pm = m; } }
      const sd = (p, a, b) => { const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
      let X = 0, Y = 0, Z = 0, cgs = 0, worstCG = 0;
      for (const l of SL) {
        const p = l.split(',').map((v) => v.trim());
        if (p[0] === 'J3' || p[0] === 'M3') { X = +p[1]; Y = +p[2]; Z = +p[3]; }
        else if (p[0] === 'JZ' || p[0] === 'MZ') Z = +p[1];
        else if (p[0] === 'J2') { X = +p[1]; Y = +p[2]; }
        else if (p[0] === 'CG') {
          cgs++;
          const nx = +p[2], ny = +p[3], I = +p[4], J = +p[5], cw = +p[7] === 1;
          const cx = X + I, cy = Y + J, R = Math.hypot(I, J);
          check(p[1] === '' && p[6] === 'T', 'CG: arc to a point, on the line');
          check(Math.abs(Math.hypot(nx - cx, ny - cy) - R) < 0.002, 'CG end on its circle');
          let a0 = Math.atan2(Y - cy, X - cx), a1 = Math.atan2(ny - cy, nx - cx);
          if (cw) { while (a1 > a0) a1 -= 2 * Math.PI; } else { while (a1 < a0) a1 += 2 * Math.PI; }
          const list = segs.filter((s) => Math.abs(s[2] - Z) < 1e-4);
          for (let t = 0; t <= 1.0001; t += 0.05) {
            const a = a0 + (a1 - a0) * t, q = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
            worstCG = Math.max(worstCG, Math.min(...list.map(([u, v]) => sd(q, u, v))));
          }
          X = nx; Y = ny;
        }
      }
      check(worstCG < 0.003, `CG arcs follow the toolpath (${cgs} arcs, worst ${worstCG.toFixed(4)}")`);
      if (i === 0) console.log(`  sbp sheet 1: ${cgs} CG arcs`);
    }
    // arcs: walk every G2/G3 in the G-code and check it stays on the toolpath
    {
      const zo = (z) => z;   // Z0 = material top in these tests
      const segsAt = new Map();
      let pm = null;
      for (const m of tp.moves) { if (m.x == null) continue; if (pm && m.g === 1) { const k = m.z.toFixed(4); if (!segsAt.has(k)) segsAt.set(k, []); segsAt.get(k).push([[pm.x, pm.y], [m.x, m.y]]); } pm = m; }
      const sd = (p, a, b) => { const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
      let X = 0, Y = 0, Z = 0, G = 0, arcs = 0, worst = 0;
      for (const line of gc.split('\n')) {
        if (line.startsWith('(')) continue;
        const w = Object.fromEntries([...line.matchAll(/([GXYZIJF])(-?[\d.]+)/g)].map((mm) => [mm[1], +mm[2]]));
        if (w.G != null && [0, 1, 2, 3].includes(w.G)) G = w.G;
        const nx = w.X ?? X, ny = w.Y ?? Y, nz = w.Z ?? Z;
        if ((G === 2 || G === 3) && w.I != null) {
          arcs++;
          const cx = X + w.I, cy = Y + w.J, R = Math.hypot(w.I, w.J);
          let a0 = Math.atan2(Y - cy, X - cx), a1 = Math.atan2(ny - cy, nx - cx);
          if (G === 2) { while (a1 > a0) a1 -= 2 * Math.PI; } else { while (a1 < a0) a1 += 2 * Math.PI; }
          check(Math.abs(Math.hypot(nx - cx, ny - cy) - R) < 0.002, 'arc end on its circle');
          const list = segsAt.get(zo(nz).toFixed(4)) || [];
          for (let t = 0; t <= 1.0001; t += 0.05) {
            const a = a0 + (a1 - a0) * t, p = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
            const d = Math.min(...list.map(([u, v]) => sd(p, u, v)));
            worst = Math.max(worst, d);
          }
        }
        X = nx; Y = ny; Z = nz;
      }
      arcTotal += arcs;
      check(worst < 0.003, `G2/G3 arcs stay on the toolpath (worst ${worst.toFixed(4)}")`);
    }
    console.log(`  sheet ${i + 1}: ${tp.moves.length} moves, ${st.cutLength.toFixed(0)}in cut, ~${st.estMinutes.toFixed(1)} min, ${gc.split('\n').length} gcode lines`);
  });
}

// --- grain ---
{
  const bb = parts.filter((p) => p.include && p.material === '3/4 Baltic Birch');
  const sides = bb.find((p) => /Left Side/.test(p.name));
  // job rule: stretchers any
  const ruled = applyGrain(bb, { STRETCHER: 'any' });
  check(ruled.filter((p) => p.role === 'STRETCHER').every((p) => p.grain === 'none'), 'job rule frees stretchers');
  check(ruled.filter((p) => p.role === 'SIDE').every((p) => p.grain === 'length'), 'sides keep modelled grain');
  // a part override beats the rule
  check(effectiveGrain({ ...sides, grainOverride: 'width' }, { SIDE: 'any' }) === 'width', 'part override beats rule');
  // grainless stock ignores rules
  const mdf = parts.find((p) => p.name === 'Grommet Panel');
  check(effectiveGrain(mdf, { '': 'length' }) === 'none', 'grainless stock ignores rules');
  // split one side out and turn it
  const split = splitPart(sides);
  check(split.length === 3 && split.every((p) => p.qty === 1), 'split merged row into 3');
  split[1].grainOverride = 'width';
  const nest = nestParts(applyGrain([split[1]], {}), { ...cfg.sheet, respectGrain: true });
  check(nest.sheets[0].placements[0].rotated === true, 'side with width grain is rotated on the sheet');
  // override survives a re-fetch: rows whose sources disagree get split
  const carried = carryOverrides([split[0], split[1], split[2]], [sides]);
  check(carried.length === 3 && carried.filter((p) => p.grainOverride === 'width').length === 1, 'override carried across re-fetch');
}

// --- cut list ---
{
  const rows = cutListRows(parts);
  check(rows.length === 3, `face frame cut list merges identical members into 3 rows (${rows.map((r) => r.qty + 'x' + r.part + ' ' + r.length).join(', ')})`);
  check(rows.reduce((a, r) => a + r.qty, 0) === 10, 'cut list counts all 10 face frame members');
  check(!parts.filter((p) => p.cnc === false).some((p) => p.include), 'face frame parts are not nested');
  check(fraction(23.25) === '23 1/4' && fraction(1.5) === '1 1/2' && fraction(0.71) === '23/32', 'fractions');
  const csv = cutListCSV(rows);
  check(csv.split('\n')[1].startsWith('Hard Maple 3/4,'), 'csv rows');
  console.log('cut list:\n' + rows.map((r) => `  ${r.qty}x ${r.part} ${fraction(r.length)} x ${fraction(r.width)} x ${fraction(r.thickness)} [${r.cabinets}]`).join('\n'));
}

// --- tabs ---
{
  const tabCfg = { ...cfg, tabs: { on: true, length: 0.375, thickness: 0.125, spacing: 18, min: 2, maxArea: 0 } };
  const g = groupParts(parts.filter((p) => p.include)).find((x) => x.key.startsWith('3/4 Baltic'));
  const n = nestParts(g.parts, { ...cfg.sheet, respectGrain: true });
  for (const skin of [0, 0.02]) {
    const tp = sheetToolpaths(n.sheets[0], { ...tabCfg, holdDown: skin ? 'both' : 'tabs', onionSkin: skin, thickness: g.thickness });
    const tabZ = -(g.thickness - 0.125);
    const tabMoves = tp.moves.filter((m) => m.op === 'tab');
    check(tabMoves.length >= 2 * n.sheets[0].placements.length, `tabs cut (skin ${skin}): ${tabMoves.length} tab moves for ${n.sheets[0].placements.length} parts`);
    check(tabMoves.every((m) => Math.abs(m.z - tabZ) < 1e-9), 'tab moves sit at the tab top');
    // ramped tabs: no stop-and-lift against the part, slopes on and off each tab
    const rp = sheetToolpaths(n.sheets[0], { ...tabCfg, tabs: { ...tabCfg.tabs, ramp: 0.25 }, holdDown: skin ? 'both' : 'tabs', onionSkin: skin, thickness: g.thickness });
    let prevR = null, straightUp = 0, badSlope = 0, ramps = 0, flats = 0;
    for (const m of rp.moves) {
      if (m.x == null) continue;
      if (prevR && m.g === 1 && (m.op === 'tab' || m.op === 'profile')) {
        const dxy = Math.hypot(m.x - prevR.x, m.y - prevR.y), dz = m.z - prevR.z;
        if (dz > 1e-9 && dxy < 1e-6) straightUp++;          // a lift on the spot
        if (m.ramp) {
          // slope = (tab top - pass depth) / 0.25: the pass depth it implies must be a real one
          ramps++;
          const passZ = tabZ - (Math.abs(dz) / dxy) * 0.25;
          if (!(passZ < tabZ - 1e-6 && passZ >= -(g.thickness + cfg.overcut) - 1e-6) || dxy > 0.25 + 1e-6 || Math.max(m.z, prevR.z) > tabZ + 1e-9) badSlope++;
        }
        if (m.op === 'tab' && !m.ramp) { flats++; if (Math.abs(m.z - tabZ) > 1e-9) badSlope++; }
      }
      prevR = m;
    }
    check(straightUp === 0, `ramped tabs: no straight-up lifts (${straightUp})`);
    check(ramps >= 2 * flats && flats >= 2 * n.sheets[0].placements.length && badSlope === 0, `ramped tabs: a ramp up and down around every flat (${ramps} ramps, ${flats} flats, ${badSlope} bad)`);
    check(rp.stats.minZ <= -(g.thickness + cfg.overcut) + 1e-9, 'ramped tabs: still cuts through between tabs');
    check(!tp.warnings.some((w) => /no straight run/.test(w)), 'every part got its tabs');
  }
  // tabs only (no vacuum): no skin pass, every part cut to full depth in one
  // trip (tabbed parts don't need small-first), tabs on every outline
  {
    const sh = n.sheets[0];
    const tp = sheetToolpaths(sh, { ...tabCfg, holdDown: 'tabs', onionSkin: 0.02, smallPartArea: 1e9, thickness: g.thickness });
    check(!tp.moves.some((m) => m.comment && /skin/i.test(m.comment)), 'tabs only: no onion skin pass');
    check(Math.abs(tp.stats.minZ + g.thickness + cfg.overcut) < 1e-9, 'tabs only: cuts to full depth');
    const outlines = tp.moves.filter((m) => m.comment && sh.placements.some((pl) => m.comment === (pl.label || pl.part.name)));
    check(outlines.length === sh.placements.length, `tabs only: one visit per part (${outlines.length} for ${sh.placements.length})`);
    const skinOnly = sheetToolpaths(sh, { ...tabCfg, holdDown: 'skin', onionSkin: 0.02, thickness: g.thickness });
    check(!skinOnly.moves.some((m) => m.op === 'tab'), 'onion skin only: tabs setting ignored');
    const none = sheetToolpaths(sh, { ...tabCfg, holdDown: 'none', onionSkin: 0.02, thickness: g.thickness });
    check(!none.moves.some((m) => m.op === 'tab' || (m.comment && /skin/i.test(m.comment))), 'nothing: no tabs, no skin');
    // settings saved before the choice keep what they did
    check(mergeSettings({ onionSkin: 0, tabs: { on: true } }).holdDown === 'tabs' && mergeSettings({ tabs: { on: true } }).holdDown === 'both'
      && mergeSettings({ onionSkin: 0 }).holdDown === 'none' && mergeSettings({}).holdDown === 'skin' && mergeSettings(null).holdDown === 'skin', 'old settings map to a hold-down');
  }
  // sheet-wide tab plan: no tab where the sheet edge (or less than 1/4" of it)
  // is past the cut, and a tab on an edge facing another tabbed part is one
  // bridge: both parts lift over the same stretch
  {
    const all = normalizeAll(sampleKitchen()).parts.filter((p) => p.include);
    all.forEach((p) => { p.qty = (p.qty || 1) * 3; });
    const tcfg = { ...tabCfg, holdDown: 'tabs', tabs: { ...tabCfg.tabs, ramp: 0.25 } };
    const r = cfg.tool.dia / 2;
    const seg = (p, a, b) => { const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
    const dOut = (p, o) => Math.min(...o.map((q, i) => seg(p, q, o[(i + 1) % o.length])));
    let flatsN = 0, offSheet = 0, unmatched = 0, bridges = 0, partsNoTab = 0, crowded = 0;
    for (const g of groupParts(all)) {
      for (const sh of nestParts(g.parts, { ...cfg.sheet, respectGrain: true }).sheets) {
        const tp = sheetToolpaths(sh, { ...tcfg, thickness: g.thickness });
        const outl = sh.placements.map((pl) => placedGeometry(pl).outline);
        const flats = []; let prev = null, owner = null;
        for (const m of tp.moves) {
          if (m.comment) owner = sh.placements.findIndex((pl) => m.comment === (pl.label || pl.part.name) || m.comment.startsWith((pl.label || pl.part.name) + ' '));
          if (m.x == null) continue;
          if (prev && m.op === 'tab' && !m.ramp && m.g === 1) flats.push({ a: [prev.x, prev.y], b: [m.x, m.y] });
          prev = m;
        }
        for (const f of flats) {
          flatsN++;
          const M = [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2];
          const own = outl.findIndex((o) => Math.abs(dOut(M, o) - r) < 0.01);
          f.own = own;
          const L = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]), u = [(f.b[0] - f.a[0]) / L, (f.b[1] - f.a[1]) / L];
          let n = [u[1], -u[0]];
          if (dOut([M[0] + n[0] * 0.01, M[1] + n[1] * 0.01], outl[own]) < r) n = [-n[0], -n[1]];   // point away from the part
          f.M = M; f.n = n; f.u = u; f.L = L;
        }
        const tabbedParts = new Set(flats.map((f) => f.own));
        // tabs per straight edge of each part's outline path
        sh.placements.forEach((pl, k) => {
          const loop = offset([outl[k]], r, 'miter').sort((a, b) => area([b]) - area([a]))[0];
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i], b = loop[(i + 1) % loop.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (L < 1) continue;
            const n = flats.filter((f) => f.own === k && Math.abs((f.M[0] - a[0]) * (b[1] - a[1]) - (f.M[1] - a[1]) * (b[0] - a[0])) / L < 0.01 &&
              ((f.M[0] - a[0]) * (b[0] - a[0]) + (f.M[1] - a[1]) * (b[1] - a[1])) / L > 0 && ((f.M[0] - a[0]) * (b[0] - a[0]) + (f.M[1] - a[1]) * (b[1] - a[1])) / L < L).length;
            // one per Spacing, rounded up; an edge may carry up to two more when a long
            // part needs a tab near each end and that edge is where its ends can be held
            if (n > Math.max(1, Math.ceil(L / (tcfg.tabs.spacing || 18) - 1e-6)) + 2) crowded++;
          }
        });
        partsNoTab += sh.placements.length - tabbedParts.size;
        for (const f of flats) {
          const Q = [f.M[0] + f.n[0] * (r + 0.24), f.M[1] + f.n[1] * (r + 0.24)];
          // across the gap: another part's cut overlaps ours
          const nb = outl.findIndex((o, i) => i !== f.own && dOut([f.M[0] + f.n[0] * (r + 0.02), f.M[1] + f.n[1] * (r + 0.02)], o) < 2 * r - 1e-3);
          if (nb < 0 && (Q[0] < 0 || Q[1] < 0 || Q[0] > sh.w || Q[1] > sh.h)) offSheet++;
          if (nb >= 0) {
            const mate = flats.find((h) => h.own === nb && Math.abs(h.u[0] * f.u[0] + h.u[1] * f.u[1]) > 0.999 &&
              Math.abs((f.M[0] - h.M[0]) * h.u[0] + (f.M[1] - h.M[1]) * h.u[1]) < 1e-6);
            if (mate) bridges++; else unmatched++;
          }
        }
      }
    }
    check(offSheet === 0, `no tabs toward the sheet edge (${offSheet})`);
    check(crowded === 0, `no straight edge has more than one tab per Spacing, rounded up, plus its end tabs (${crowded} crowded)`);
    check(unmatched === 0 && bridges > 0, `tabs facing a neighbour are shared bridges (${bridges / 2} bridges, ${unmatched} unmatched)`);
    check(partsNoTab === 0, `every part still gets a tab (${partsNoTab} without)`);
    console.log(`tab plan: ${flatsN} tab lifts, ${bridges / 2} shared bridges`);
  }
  // a 4" stretcher at 34.75 long gets 2 tabs; a 34.5 x 23.25 side gets ~6
  const side = g.parts.find((p) => /Left Side/.test(p.name));
  const pl = { part: side, copy: 1, x: 0, y: 0, rotated: false };
  const loop = offset([placedGeometry(pl).outline], cfg.tool.dia / 2, 'miter')[0];
  const iv = placeTabs(loop, { length: 0.375, spacing: 18, min: 2 }, cfg.tool);
  check(iv.length >= 5 && iv.length <= 7, `side gets about 6 tabs (${iv.length})`);
  check(iv.every(([a, b]) => Math.abs(b - a - (0.375 + cfg.tool.dia)) < 1e-9), 'tab lift = tab length + tool diameter');
}

// nest search: never worse than the quick nest; a stored solution rebuilds the same layout
{
  const g = groupParts(parts.filter((p) => p.include)).find((x) => x.key.startsWith('3/4 Baltic'));
  const o = { ...cfg.sheet, respectGrain: true };
  const big = g.parts.map((p) => ({ ...p, qty: (p.qty || 1) * 4 }));
  const quick = nestParts(big, o);
  const found = nestParts(big, { ...o, searchMs: 800, seed: 3 });
  check(found.sheets.length <= quick.sheets.length, `search no worse than quick (${found.sheets.length} vs ${quick.sheets.length}, ${found.stats.tries} tries)`);
  check(found.sheets.length >= found.stats.lowerBound, 'not below the area minimum');
  const again = applySolution(big, o, found.solution);
  const same = again && again.sheets.length === found.sheets.length && again.sheets.every((sh, i) => sh.placements.every((pl, j) => {
    const q = found.sheets[i].placements[j];
    return q && pl.part === q.part && pl.copy === q.copy && Math.abs(pl.x - q.x) < 1e-9 && Math.abs(pl.y - q.y) < 1e-9 && pl.rotated === q.rotated;
  }));
  check(same, 'stored nest rebuilds the identical layout');
  check(applySolution(big.slice(1), o, found.solution) === null, 'stored nest refused when the parts changed');
  check(nestKey(big, o) !== nestKey(big, { ...o, spacing: o.spacing + 0.1 }) && nestKey(big, o) === nestKey(big.slice(), { ...o }), 'nest key follows the inputs');
  const lo = found.sheets.at(-1).offcut;
  check(lo && lo.w > 0 && lo.h > 0, 'last sheet reports its offcut');
  console.log(`\nnest search: ${big.reduce((a, p) => a + p.qty, 0)} parts, quick ${quick.sheets.length} sheets, search ${found.sheets.length} (minimum ${found.stats.lowerBound}), last offcut ${lo.w.toFixed(1)} x ${lo.h.toFixed(1)}`);
}
// remnants: nested on before full sheets, offcuts kept on the zero corner, cut free on their inside edges
{
  const o = { ...cfg.sheet, respectGrain: true, remnantTrim: 0.25, remnantMin: { side: 8, area: 288 } };
  const side = { id: 's', name: 'side', width: 34.5, height: 23.25, qty: 3, include: true, grain: 'length', outline: [[0, 0], [34.5, 0], [34.5, 23.25], [0, 23.25]], holes: [], pockets: [] };
  const plain = nestParts([side], o);
  const withRem = nestParts([side], { ...o, remnants: [{ id: 'R1', no: 1, w: 40, h: 30 }] });
  check(plain.fullSheets === 1 && withRem.fullSheets === 1 && withRem.sheets.some((x) => x.remnant?.id === 'R1'), 'a part goes on the remnant first');
  const rs = withRem.sheets.find((x) => x.remnant);
  check(rs.w === 40 && rs.h === 30 && rs.placements.every((pl) => pl.x >= 0.25 - 1e-9 && pl.y >= 0.25 - 1e-9 && pl.x + pl.part.width <= 40 - 0.25 + 1e-9 && pl.y + pl.part.height <= 30 - 0.25 + 1e-9), 'remnant parts inside its trim');
  const full = withRem.sheets.find((x) => !x.remnant);
  const oc = full.offcuts[0];
  check(oc && oc.x === 0 && oc.y === 0, `offcut kept on the zero corner (${oc && [oc.x, oc.y, oc.w.toFixed(2), oc.h.toFixed(2)]})`);
  check(full.placements.every((pl) => pl.x >= oc.x + oc.w + o.spacing - 1e-6 || pl.y >= oc.y + oc.h + o.spacing - 1e-6), 'parts clear of the offcut by the spacing');
  const lines = offcutCutLines(oc, 96, 48, 0.1875);
  check(lines.length === 1 && !lines[0].closed && lines[0].pts.every(([x, y]) => x >= 0 && y >= 0 && x <= 96 && y <= 48), 'offcut cut free along its inside edges only, on the sheet');
  const tp = sheetToolpaths(full, { ...cfg, thickness: 0.75 });
  check(tp.moves.some((m) => m.comment && /Cut offcut free/.test(m.comment)), 'offcut cut-free pass emitted');
  const tr = sheetToolpaths(rs, { ...cfg, thickness: 0.75 });
  check(tr.stats.minX >= -0.2 && tr.stats.maxX <= 40.2 && tr.stats.maxY <= 30.2, 'remnant toolpaths stay on the remnant');
}
// L-shaped keepers and remnants: an offcut can be two adjacent rectangles (one
// piece); it's cut free along the outside of the L only; parts nested on an L
// remnant stay inside it (trim included)
{
  const o = { ...cfg.sheet, respectGrain: true, remnantTrim: 0.25, remnantMin: { side: 8, area: 288 } };
  const rect = (id, w, h, qty) => ({ id, name: id, width: w, height: h, qty, include: true, grain: 'length', outline: [[0, 0], [w, 0], [w, h], [0, h]], holes: [], pockets: [] });
  // a 60 x 30 panel and a 30 x 14 strip leave an L of clear sheet
  const n = nestParts([rect('big', 60, 30, 1), rect('strip', 30, 14, 1)], o);
  const sh = n.sheets[0];
  const L = sh.offcuts.find((oc) => oc.rects?.length === 2);
  check(!!L, `an L-shaped keeper is found (${sh.offcuts.map((oc) => oc.rects ? 'L ' + oc.rects.map((q) => `${q.w.toFixed(1)}x${q.h.toFixed(1)}`).join('+') : `${oc.w.toFixed(1)}x${oc.h.toFixed(1)}`).join(', ')})`);
  if (L) {
    const [a, b] = L.rects;
    const touch = Math.abs(a.x + a.w - b.x) < 1e-6 || Math.abs(b.x + b.w - a.x) < 1e-6 || Math.abs(a.y + a.h - b.y) < 1e-6 || Math.abs(b.y + b.h - a.y) < 1e-6;
    check(touch, 'its two rectangles are adjacent');
    const inL = (x, y) => L.rects.some((q) => x > q.x + 1e-6 && x < q.x + q.w - 1e-6 && y > q.y + 1e-6 && y < q.y + q.h - 1e-6);
    check(sh.placements.every((pl) => { const bx = placedGeometry(pl).box; return !L.rects.some((q) => bx.x0 < q.x + q.w - 1e-6 && q.x < bx.x1 - 1e-6 && bx.y0 < q.y + q.h - 1e-6 && q.y < bx.y1 - 1e-6); }), 'no part in the L');
    const lines = offcutCutLines(L, sh.w, sh.h, 0.1875);
    // no cut line runs through the inside of the L (between its two rectangles)
    let inside = 0;
    for (const ln of lines) for (let k = 0; k + 1 < ln.pts.length; k++) {
      const [p, q] = [ln.pts[k], ln.pts[k + 1]];
      for (let t = 0.1; t < 1; t += 0.2) if (inL(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)) inside++;
    }
    check(lines.length >= 1 && inside === 0 && lines.every((ln) => ln.pts.every(([x, y]) => x >= 0 && y >= 0 && x <= sh.w && y <= sh.h)), `L cut free around its outside only (${lines.length} line(s), ${inside} points inside)`);
  }
  // an L remnant: 48 x 48 box, the top-right 28 x 28 missing
  const Lrem = { id: 'RL', no: 9, w: 48, h: 48, rects: [{ x: 0, y: 0, w: 48, h: 20 }, { x: 0, y: 20, w: 20, h: 28 }] };
  const on = nestParts([rect('a', 40, 16, 1), rect('b', 16, 24, 1), rect('c', 20, 20, 1)], { ...o, respectGrain: false, remnants: [Lrem] });
  const rsh = on.sheets.find((x) => x.remnant?.id === 'RL');
  check(!!rsh && rsh.remnant.rects?.length === 2, 'parts go on the L remnant');
  if (rsh) {
    // inside the box less its trim, and the trim clear of the missing 28 x 28 corner
    const inside = (bx) => bx.x0 >= 0.25 - 1e-6 && bx.y0 >= 0.25 - 1e-6 && bx.x1 <= 47.75 + 1e-6 && bx.y1 <= 47.75 + 1e-6
      && !(bx.x1 > 20 - 0.25 + 1e-6 && bx.y1 > 20 - 0.25 + 1e-6);
    check(rsh.placements.every((pl) => inside(placedGeometry(pl).box)), `parts on the L remnant stay inside it, trim included (${rsh.placements.map((pl) => pl.part.name).join(', ')})`);
    check(!rsh.placements.some((pl) => pl.part.name === 'c' && placedGeometry(pl).box.x1 > 20 && placedGeometry(pl).box.y1 > 20), 'nothing in the missing corner');
  }
}
// labels: one per part (numbered like the preview), a sheet label, offcut labels; valid ZPL
{
  const { sheetLabels, toZPL, numberPlacements, remnantLabel } = await import('../public/lib/labels.js');
  const g = groupParts(parts.filter((p) => p.include)).find((x) => x.key.startsWith('3/4 Baltic'));
  const n = nestParts(g.parts, { ...cfg.sheet, respectGrain: true });
  const sh = n.sheets.at(-1);
  const item = { sheet: sh, group: g };
  const lbs = sheetLabels(item, { job: 'Test_job ^~', sheetLabel: 'Sheet 3 of 3', date: '11/7/2026' });
  const partL = lbs.filter((l) => l.kind === 'part');
  check(lbs[0].kind === 'sheet' && partL.length === sh.placements.length && lbs.filter((l) => l.kind === 'offcut').length === sh.offcuts.length, 'sheet label + one per part + offcuts');
  const nos = numberPlacements(sh);
  check(partL.every((l, i) => l.no === i + 1) && new Set(nos.values()).size === sh.placements.length, 'labels numbered 1..n like the preview');
  const z = toZPL(lbs, { w: 2, h: 1, dpi: 203 });
  check((z.match(/\^XA/g) || []).length === lbs.length && (z.match(/\^XZ/g) || []).length === lbs.length, 'one ^XA..^XZ per label');
  const fdText = z.split('\n').filter((l) => l.includes('^FD')).map((l) => l.slice(l.indexOf('^FD') + 3, l.lastIndexOf('^FS')));
  check(fdText.every((t) => !/[\^~]/.test(t)) && fdText.some((t) => t.includes('_5E')), 'carets and tildes in text are hex-escaped');
  const wide = z.split('\n').filter((l) => l.startsWith('^FO')).every((l) => { const m = /\^FO(\d+),(\d+)/.exec(l); return +m[1] < 406 && +m[2] < 203; });
  check(wide, 'everything inside a 2 x 1 label at 203 dpi');
  const rz = toZPL([remnantLabel({ no: 7, material: 'BB 3/4', thickness: 0.705, w: 40, h: 30 }, 'today')], { w: 4, h: 2, dpi: 300 });
  check(rz.includes('^PW1200') && rz.includes('R7'), 'remnant label at 4 x 2, 300 dpi');
  fs.writeFileSync(path.join(out, 'labels_sample.zpl'), z);
}
// --- drilling first, each bit loaded once; dado ends cleaned up ---
{
  const many = normalizeAll(sampleKitchen()).parts.filter((p) => p.include);
  const s = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s, DEFAULT_LIBRARY, []);
  let sheetsWithDrills = 0, endChecked = 0, pocketsChecked = 0, overtravelChecked = 0;
  const signedAreaT = (l) => l.reduce((a, p, i) => a + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0) / 2;
  // both ways of nesting: Part spacing, and shared cut lines (parts a bit apart)
  for (const cl of [false, true]) for (const g of groupParts(many)) {
    const nOpts = cl ? { ...s.sheet, spacing: tl.tool.dia, commonLine: true, respectGrain: true } : { ...s.sheet, respectGrain: true };
    for (const sh of nestParts(g.parts, nOpts).sheets) {
      // (the shared-lines run also ramps into pockets at 45°, so ramps stay checked)
      const tp = sheetToolpaths(sh, { ...s, ...tl, commonLine: cl, holdDown: cl ? 'tabs' : s.holdDown, pocketRampAngle: cl ? 45 : 0, thickness: g.thickness });
      const loads = tp.moves.filter((m) => m.toolchange).map((m) => m.tool);
      const oneBit = tl.tool === tl.dadoTool || (tl.tool.dia === tl.dadoTool.dia && tl.tool.name === tl.dadoTool.name);
      // dados before holes (dadosFirst): with one bit and a drill bit, the main
      // bit is loaded again after the drill for the profiles; otherwise once each
      const reload = oneBit && loads.length >= 3 && loads[0] === loads[loads.length - 1];
      const uniq = reload ? loads.slice(0, -1) : loads;
      check(new Set(uniq).size === uniq.length, `each bit loaded once per sheet${reload ? ' (main bit again after the drill)' : ''} (${loads.map((t) => t.name).join(', ')})`);
      // every pocket on the sheet is cut before any drill-only bit drills, and
      // no profile move comes before a drill move of another bit
      let pocketAfterDrill = 0, sawDrillOnly = false, curT = null;
      for (const m of tp.moves) {
        if (m.toolchange) { curT = m.tool; continue; }
        if (m.g !== 1) continue;
        const isMain = curT === tl.tool || curT === tl.dadoTool;
        if (m.op === 'drill' && !isMain) sawDrillOnly = true;
        if (m.op === 'pocket' && sawDrillOnly) pocketAfterDrill++;
      }
      check(pocketAfterDrill === 0, 'every dado cut before a drill bit drills');
      const drillOnly = loads.filter((t) => t !== tl.tool && t !== tl.dadoTool);
      if (drillOnly.length) {
        sheetsWithDrills++;
        if (!oneBit) check(loads.slice(1, 1 + drillOnly.length).every((t) => drillOnly.includes(t)), 'drill-only bits right after the dado bit');
      }
      // Every pocket floor is fully cut wherever the bit can reach (the floor
      // opened by the bit radius): no bumps on ends or walls, no ridges between
      // passes. Closed-end pockets are spirals; open dados run past the edge.
      const r = tl.dadoTool.dia / 2;
      const segAll = [];
      let prev = null, cur = null;
      for (const m of tp.moves) {
        if (m.comment) { cur = / pocket /.test(m.comment) ? m.comment : null; if (cur) { endChecked += /d[0-9.]+\/[0-9.]/.test(cur) ? 1 : 0; } continue; }
        if (m.x == null) continue;
        if (cur && prev && m.g === 1 && m.z < 0 && prev.z < 0) segAll.push({ a: [prev.x, prev.y], b: [m.x, m.y], z: Math.max(m.z, prev.z) });
        prev = m;
      }
      const segD = (p, a, b) => { const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
      for (const pl of sh.placements) {
        const geo = placedGeometry(pl);
        for (const q of geo.pockets) {
          if (q.loops.length === 1 && q.loops[0].length > 12 && Math.abs(signedAreaT(q.loops[0])) < 0.2) continue;   // drilled holes
          const open = offset(offset(union(q.loops, []), -r - 0.004, 'round'), r, 'round');
          if (!open.length) continue;
          const xs = open.flat().map((p) => p[0]), ys = open.flat().map((p) => p[1]);
          const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
          // every pocket, whatever its size: the grid only gets coarser on a big floor
          const fa = area(open);
          const step = fa < 60 ? 0.03 : fa < 200 ? 0.05 : 0.1;
          const near = segAll.filter((sg) => sg.z <= -q.depth + 1e-6 && Math.max(sg.a[0], sg.b[0]) > bx0 - r && Math.min(sg.a[0], sg.b[0]) < bx1 + r && Math.max(sg.a[1], sg.b[1]) > by0 - r && Math.min(sg.a[1], sg.b[1]) < by1 + r);
          let miss = 0, worst = 0;
          for (let x = bx0 + 0.01; x < bx1; x += step) for (let y = by0 + 0.01; y < by1; y += step) {
            if (!inRegion([x, y], open)) continue;
            let d = Infinity;
            for (const sg of near) { d = Math.min(d, segD([x, y], sg.a, sg.b)); if (d <= r + 1e-3) break; }
            if (d > r + 1e-3) { miss++; worst = Math.max(worst, d - r); }
          }
          pocketsChecked++;
          check(miss === 0, `${pl.label || pl.part.name} pocket floor fully cut (${miss} spots missed, up to ${worst.toFixed(3)}")`);
        }
      }
      // open-ended dados: every row that leaves the part runs at least half the
      // bit past its edge
      {
        let cur = null, prevM = null, short = 0, rowsOut = 0;
        const outl = sh.placements.map((pl) => ({ name: pl.label || pl.part.name, o: placedGeometry(pl).outline }));
        for (const m of tp.moves) {
          if (m.comment) { cur = / pocket /.test(m.comment) && !/\((spiral|inside out)\)/.test(m.comment) ? outl.find((x) => m.comment.startsWith(x.name + ' ')) : null; prevM = null; continue; }
          if (m.x == null) continue;
          if (cur && prevM && m.g === 1 && m.z < 0 && Math.hypot(m.x - prevM.x, m.y - prevM.y) > 2) {
            for (const e of [[prevM.x, prevM.y], [m.x, m.y]]) {
              if (inRegion(e, [cur.o])) continue;
              rowsOut++;
              const d = Math.min(...cur.o.map((q, i) => segD(e, q, cur.o[(i + 1) % cur.o.length])));
              // short is only allowed where another part stopped it (bit edge 0.03 clear of it)
              const dn = Math.min(Infinity, ...outl.filter((x) => x !== cur).map((x) => Math.min(...x.o.map((q, i) => segD(e, q, x.o[(i + 1) % x.o.length])))));
              if (d < r - 1e-3 && !(dn < r + 0.045)) short++;
            }
          }
          prevM = m;
        }
        overtravelChecked += rowsOut;
        check(short === 0, `open dado rows run half the bit past the edge (${short} of ${rowsOut} short)`);
      }
      // each pocket operation: the bit is never deeper than the floor anywhere
      // under it (any depth order is fine), and at each depth nothing is
      // cleared after its finishing pass has started
      {
        const geoms = sh.placements.map((pl) => placedGeometry(pl));
        let cur = null, prevM = null, finAt = new Set(), tooDeep = 0, badFin = 0;
        for (const m of tp.moves) {
          if (m.comment) { cur = / pocket /.test(m.comment) ? m.comment : null; finAt = new Set(); prevM = null; continue; }
          if (m.x == null) continue;
          if (cur && prevM && m.g === 1 && m.z < -1e-6 && Math.hypot(m.x - prevM.x, m.y - prevM.y) > 1e-6) {
            // (corner reliefs cut past the drawn floor on purpose)
            if (m.op !== 'relief') for (let t = 0; t <= 1.0001; t += 0.1) {
              const cx = prevM.x + (m.x - prevM.x) * t, cy = prevM.y + (m.y - prevM.y) * t, cz = prevM.z + (m.z - prevM.z) * t;
              if (cz >= -1e-6) continue;
              for (let a = 0; a < 17; a++) {
                const rr = a === 16 ? 0 : r - 0.003;
                const q = [cx + rr * Math.cos((a * Math.PI) / 8), cy + rr * Math.sin((a * Math.PI) / 8)];
                const gg = geoms.find((x) => inRegion(q, [x.outline, ...x.holes]));
                if (!gg) continue;
                if (!gg.pockets.some((f) => f.depth >= -cz - 1e-4 && inRegion(q, f.loops))) tooDeep++;
              }
            }
            // (per area: a dado taken down by itself finishes its walls before the next one is cleared)
            const zk = m.z.toFixed(4);
            if (m.op === 'finish') finAt.add([zk, m.x, m.y]);
            if (m.op === 'pocket' && !m.ramp && Math.hypot(m.x - prevM.x, m.y - prevM.y) > 0.3) {
              const mid = [(m.x + prevM.x) / 2, (m.y + prevM.y) / 2];
              if ([...finAt].some(([z, x, y]) => z === zk && Math.hypot(x - mid[0], y - mid[1]) < Math.hypot(m.x - prevM.x, m.y - prevM.y) / 2 + 1)) badFin++;
            }
          }
          prevM = m;
        }
        check(tooDeep === 0, `pocket moves never deeper than the floor under the bit (${tooDeep} spots)`);
        check(badFin === 0, `walls finished last at each depth (${badFin} clearing moves after the finishing pass)`);
      }
      // each part: its dados / rabbets, then its cutouts, then its outline
      {
        const seen = [];
        for (const m of tp.moves) if (m.comment) seen.push(m.comment);
        for (const pl of sh.placements) {
          const name = pl.label || pl.part.name;
          const lastPocket = seen.findLastIndex((c) => c.startsWith(name + ' pocket'));
          const profile = seen.findIndex((c) => c === name);
          if (lastPocket >= 0 && profile >= 0) check(lastPocket < profile, `${name}: dados before its outline`);
        }
      }
    }
  }
  check(overtravelChecked > 0, `overtravel check ran (${overtravelChecked} row ends past an edge)`);
  check(sheetsWithDrills > 0 && endChecked > 0 && pocketsChecked > 10, `order and floor checks ran (${sheetsWithDrills} sheets with drills, ${endChecked} grouped pockets, ${pocketsChecked} floors sampled)`);
}

// --- shared cut lines: parts one bit apart, a shared edge cut once ---
{
  const all = normalizeAll(sampleKitchen()).parts.filter((p) => p.include);
  all.forEach((p) => { p.qty = (p.qty || 1) * 3; });
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const dia = tl.tool.dia, r = dia / 2;
  let profOff = 0, profOn = 0, sharedTot = 0, missed = 0, gouge = 0, sheetsOff = 0, sheetsOn = 0, pocketHits = 0, missingWork = 0, outlineEarly = 0;
  const segD = (p, a, b) => { const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
  const profLen = (tp) => { let L = 0, pm = null; for (const m of tp.moves) { if (m.x == null) continue; if (pm && m.g === 1 && (m.op === 'profile' || m.op === 'tab')) L += Math.hypot(m.x - pm.x, m.y - pm.y); pm = m; } return L; };
  for (const g of groupParts(all)) {
    for (const sh of nestParts(g.parts, { ...s0.sheet, respectGrain: true }).sheets) {
      sheetsOff++;
      profOff += profLen(sheetToolpaths(sh, { ...s0, ...tl, commonLine: false, thickness: g.thickness }));
    }
    for (const sh of nestParts(g.parts, { ...s0.sheet, spacing: dia, commonLine: true, respectGrain: true }).sheets) {
      sheetsOn++;
      for (const hold of ['skin', 'tabs']) {
        const tp = sheetToolpaths(sh, { ...s0, ...tl, commonLine: true, holdDown: hold, tabs: { ...s0.tabs, on: true }, thickness: g.thickness });
        if (hold === 'skin') { profOn += profLen(tp); sharedTot += tp.stats.sharedLength; }
        const full = g.thickness + s0.overcut;
        const deep = [], prof = [];
        let pm = null;
        for (const m of tp.moves) {
          if (m.x == null) continue;
          if (pm && m.g === 1 && (m.op === 'profile' || m.op === 'tab')) {
            prof.push([[pm.x, pm.y], [m.x, m.y]]);
            if ((m.z <= -full + 1e-6 && pm.z <= -full + 1e-6) || m.op === 'tab') deep.push([[pm.x, pm.y], [m.x, m.y]]);
          }
          pm = m;
        }
        const outl = sh.placements.map((pl) => placedGeometry(pl).outline);
        // every part's outline path is cut to full depth (tabs aside)
        for (const o of outl) {
          const loop = offset([o], r, 'miter').sort((a, b) => area([b]) - area([a]))[0];
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i], b = loop[(i + 1) % loop.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            for (let t = 0; t <= L; t += 0.25) {
              const p = [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
              if (!deep.some(([u, v]) => segD(p, u, v) < 0.003)) missed++;
            }
          }
        }
        // every part's own work is there, and comes before its perimeter is cut
        const order = [];
        { let pm2 = null, sec = null;
          for (const m of tp.moves) {
            if (m.comment) { sec = m.comment; continue; }
            if (m.x == null) continue;
            if (pm2 && m.g === 1 && m.z < 0 && (m.op === 'profile' || m.op === 'tab')) order.push({ sec, p: [(pm2.x + m.x) / 2, (pm2.y + m.y) / 2] });
            pm2 = m;
          } }
        const comments = tp.moves.filter((m) => m.comment).map((m) => m.comment);
        sh.placements.forEach((pl, k) => {
          const name = pl.label || pl.part.name;
          const gq = placedGeometry(pl);
          // (a dado joined across parts is labelled "A + B pocket ...")
          const pocketOf = (c) => / pocket /.test(c) && c.split(' pocket ')[0].split(' + ').includes(name);
          if (!comments.some((c) => c === name || c.startsWith(name + ' ') || pocketOf(c))) missingWork++;
          if (gq.pockets.length && !comments.some((c) => c.startsWith(name + ' pocket') || pocketOf(c))) missingWork++;
          // the first cut along this part's outline comes after its own work started
          const loop = offset([gq.outline], r, 'miter').sort((a, b) => area([b]) - area([a]))[0];
          const firstOutline = tp.moves.findIndex((m, i) => i > 0 && m.g === 1 && m.z < 0 && (m.op === 'profile' || m.op === 'tab') && tp.moves[i - 1].x != null &&
            loop.some((q, j) => segD([(m.x + tp.moves[i - 1].x) / 2, (m.y + tp.moves[i - 1].y) / 2], q, loop[(j + 1) % loop.length]) < 0.003));
          const ownStart = tp.moves.findIndex((m) => m.comment && (m.comment === name || m.comment.startsWith(name + ' ') || pocketOf(m.comment)));
          if (firstOutline >= 0 && ownStart > firstOutline) outlineEarly++;
        });
        // no outline move cuts into any part
        // part material = outline minus its cutouts
        const keepRegs = sh.placements.map((pl) => { const gq = placedGeometry(pl); return offset(difference([gq.outline], gq.holes), r - 0.004, 'miter'); });
        for (const [u, v] of prof) for (let t = 0; t <= 1.0001; t += 0.25) {
          const p = [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t];
          if (keepRegs.some((rg) => inRegion(p, rg))) gouge++;
        }
        // dado run-outs never reach a neighbour
        const geoms = sh.placements.map((pl) => placedGeometry(pl));
        let cur = null; pm = null;
        for (const m of tp.moves) {
          if (m.comment) { cur = / pocket /.test(m.comment) ? m.comment : null; pm = null; continue; }
          if (m.x == null) continue;
          if (cur && pm && m.g === 1 && m.z < 0 && m.op !== 'relief') {
            for (let t = 0; t <= 1.0001; t += 0.1) {
              const c = [pm.x + (m.x - pm.x) * t, pm.y + (m.y - pm.y) * t];
              for (let k = 0; k < 16; k++) {
                const q = [c[0] + (r - 0.003) * Math.cos((k * Math.PI) / 8), c[1] + (r - 0.003) * Math.sin((k * Math.PI) / 8)];
                const gg = geoms.find((x) => inRegion(q, [x.outline, ...x.holes]));
                if (gg && !gg.pockets.some((f) => inRegion(q, f.loops))) pocketHits++;
              }
            }
          }
          pm = m;
        }
      }
    }
  }
  console.log(`shared cut lines: ${sheetsOn} sheets (vs ${sheetsOff}), ${sharedTot.toFixed(0)}in shared, outline cutting ${profOn.toFixed(0)}in vs ${profOff.toFixed(0)}in (${(100 * (1 - profOn / profOff)).toFixed(1)}% less)`);
  check(sheetsOn <= sheetsOff, 'shared cut lines never need more sheets');
  check(missed === 0, `shared cut lines: every outline cut to full depth (${missed} spots missed)`);
  check(gouge === 0, `shared cut lines: no outline move cuts into a part (${gouge})`);
  check(pocketHits === 0, `shared cut lines: dado run-outs stay out of neighbouring parts (${pocketHits})`);
  check(profOn < profOff * 0.85, 'shared cut lines cut at least 15% less outline');
  check(missingWork === 0, `shared cut lines: every part's dados and cutouts are cut (${missingWork} missing)`);
  check(outlineEarly === 0, `shared cut lines: a part's perimeter is never cut before its own holes, dados and cutouts (${outlineEarly})`);
}

// --- machine time model ---
{
  const prof = { machine: { maxXY: 240, maxZ: 90, accelXY: 10, accelZ: 10, toolChangeSec: 60 }, spinupSeconds: 0 };
  const line = machineTime([{ g: 0, x: 0, y: 0, z: 0.5 }, { g: 1, x: 10, y: 0, z: 0.5, f: 240 }], prof);
  check(Math.abs(line.total - (10 / 4 + 4 / 10)) < 1e-6, `10" at 240 ipm with 10 in/s² takes 2.9 s (${line.total.toFixed(3)})`);
  const short = machineTime([{ g: 0, x: 0, y: 0, z: 0 }, { g: 1, x: 0.4, y: 0, z: 0, f: 240 }], prof);
  check(Math.abs(short.total - 2 * Math.sqrt((2 * 0.2) / 10)) < 1e-6, `a short move never reaches full speed: speeds up halfway, slows down halfway (${short.total.toFixed(3)} s)`);
  const sq = [{ g: 0, x: 0, y: 0, z: 0 }, { g: 1, x: 5, y: 0, z: 0, f: 240 }, { g: 1, x: 5, y: 5, z: 0, f: 240 }];
  const st = [{ g: 0, x: 0, y: 0, z: 0 }, { g: 1, x: 5, y: 0, z: 0, f: 240 }, { g: 1, x: 10, y: 0, z: 0, f: 240 }];
  check(machineTime(sq, prof).total > machineTime(st, prof).total + 0.3 && Math.abs(machineTime(st, prof).total - 2.9) < 1e-6, 'a square corner costs time (slow down and speed up again), straight on does not');
  const tc = machineTime([{ toolchange: true, tool: {} }, { g: 0, x: 0, y: 0, z: 0 }, { toolchange: true, tool: {} }, { g: 0, x: 1, y: 0, z: 0 }], prof);
  check(Math.abs(tc.toolchange - 60) < 1e-9, 'the first bit is already loaded; each later change costs the profile\'s seconds');
  check(mergeSettings({ jogXY: 6, jogZ: 2 }).machine.maxXY === 360 && mergeSettings({ jogXY: 6, jogZ: 2 }).machine.maxZ === 120, 'old jog speeds become the machine profile');
}

// --- cut simulation: every sample sheet carves to the model; planted faults are caught ---
{
  const all = normalizeAll(sampleKitchen()).parts.filter((p) => p.include);
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  let sheetsChecked = 0, bad = [];
  let faultsCaught = { uncut: false, deep: false, notThrough: false };
  for (const cl of [false, true]) for (const hold of ['skin', 'tabs']) for (const g of groupParts(all)) {
    const nOpts = cl ? { ...s0.sheet, spacing: tl.tool.dia, commonLine: true, respectGrain: true } : { ...s0.sheet, respectGrain: true };
    for (const sh of nestParts(g.parts, nOpts).sheets) {
      const cfgS = { ...s0, ...tl, commonLine: cl, holdDown: hold, tabs: { ...s0.tabs, on: true }, thickness: g.thickness };
      const tp = sheetToolpaths(sh, cfgS);
      const opts = { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: g.thickness, holdDown: hold };
      const res = simCheck(sh, carve(sh, tp.moves, { res: 0.04, dia: tl.tool.dia }), opts);
      sheetsChecked++;
      if (!res.ok) bad.push(`${g.key} ${cl ? 'shared' : 'spaced'} ${hold}: ${res.uncut} uncut, ${res.deep} deep, ${res.notThrough} not through`);
      // plant faults on the first sheet with pockets
      if (!faultsCaught.uncut && tp.moves.some((m) => m.op === 'finish')) {
        const i = tp.moves.findIndex((m) => m.op === 'finish' && m.g === 1);
        const lost = tp.moves.filter((_, k) => k !== i && k !== i + 1 && k !== i + 2);   // drop a stretch of wall pass
        faultsCaught.uncut = simCheck(sh, carve(sh, lost, { res: 0.04, dia: tl.tool.dia }), opts).uncut > 0;
        const deeper = tp.moves.map((m) => (m.op === 'pocket' && m.g === 1 ? { ...m, z: m.z - 0.05 } : m));
        faultsCaught.deep = simCheck(sh, carve(sh, deeper, { res: 0.04, dia: tl.tool.dia }), opts).deep > 0;
      }
      if (!faultsCaught.notThrough && hold === 'tabs') {
        const full = -(g.thickness + s0.overcut);
        const shallow = tp.moves.map((m) => (m.op === 'profile' && Math.abs(m.z - full) < 1e-9 ? { ...m, z: full + 0.1 } : m));
        faultsCaught.notThrough = simCheck(sh, carve(sh, shallow, { res: 0.04, dia: tl.tool.dia }), opts).notThrough > 0;
      }
    }
  }
  check(bad.length === 0, `simulated cuts match the model (${sheetsChecked} sheets)${bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''}`);
  check(faultsCaught.uncut && faultsCaught.deep && faultsCaught.notThrough, `simulation catches planted faults ${JSON.stringify(faultsCaught)}`);
  console.log(`cut simulation: ${sheetsChecked} sheets carved and checked`);
}

// --- a wide rabbet is cleared from its open edge in toward its wall ---
{
  const W = 20, H = 10;
  const part = { name: 'RABBET', width: W, height: H, outline: [[0, 0], [W, 0], [W, H], [0, H]], holes: [],
    pockets: [{ depth: 0.25, loops: [[[0, H - 2], [W, H - 2], [W, H], [0, H]]] }], grain: 'length' };
  const sheet = { w: 48, h: 48, placements: [{ part, copy: 1, x: 5, y: 5, rotated: false }], offcuts: [] };
  const tp = sheetToolpaths(sheet, { ...cfg, thickness: 0.75 });
  const rowsY = [];
  let prevM = null, sawFinish = false, after = 0;
  for (const m of tp.moves) {
    if (m.x == null) continue;
    if (prevM && m.g === 1 && m.z < 0 && Math.abs(m.y - prevM.y) < 1e-6 && Math.abs(m.x - prevM.x) > 5) {
      if (m.op === 'pocket') { rowsY.push(m.y); if (sawFinish) after++; }
      if (m.op === 'finish') sawFinish = true;
    }
    prevM = m;
  }
  // wall at y = 5 + 8 = 13; open edge at y = 15: rows go from high y down toward the wall
  const decreasing = rowsY.every((y, i) => i === 0 || y <= rowsY[i - 1] + 1e-6);
  check(rowsY.length >= 4 && decreasing && after === 0 && sawFinish, `rabbet cleared from the open edge toward the wall (${rowsY.map((y) => y.toFixed(2)).join(' > ')})`);
  check(rowsY[0] + cfg.tool.dia / 2 > 15, 'first rabbet row: the bit runs past the open edge');
}

// --- screw hold-downs: 2 per third of the sheet, drilled first, then a stop;
// no cut comes inside a screw's clearance ---
{
  const many = normalizeAll(sampleKitchen()).parts;
  many.forEach((p) => { p.include = p.cnc !== false; p.qty = (p.qty || 1) * 3; });
  let sheets = 0, spots = 0, missing = 0, worst = Infinity, extraSheets = 0, thinN = 0, keeperN = 0, centreWorst = 0;
  const faults = { planted: false };
  for (const cl of [false, true]) {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.screws = { on: true, head: 0.375, clear: 0.125, depth: 0.25 };
    s.commonLine = cl;
    const tl = resolveTools(s, DEFAULT_LIBRARY, []);
    const R = screwR(s.screws);
    for (const g of groupParts(many.filter((p) => p.include))) {
      const sheetOpts = { ...s.sheet, respectGrain: true, ...(cl ? { spacing: tl.tool.dia, commonLine: true } : {}) };
      const plain = nestParts(g.parts, { ...sheetOpts, searchMs: 1500 });
      const n = nestParts(g.parts, { ...sheetOpts, screws: { R }, searchMs: 1500 });
      extraSheets += n.fullSheets - plain.fullSheets;
      for (const sh of n.sheets) {
        sheets++; spots += sh.screws.length; missing += sh.screwsMissing; thinN += sh.screwsThin;
        // five: four corners + centre of the parts' area (unless reported missing)
        check(sh.screws.length + sh.screwsMissing === 5, `screws: 5 per sheet (${sh.screws.length}, ${sh.screwsMissing} missing)`);
        if (!sh.remnant && sh.screws.length) {
          let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
          for (const pl of sh.placements) { const b = placedGeometry(pl).box; px0 = Math.min(px0, b.x0); py0 = Math.min(py0, b.y0); px1 = Math.max(px1, b.x1); py1 = Math.max(py1, b.y1); }
          const cx = (px0 + px1) / 2, cy = (py0 + py1) / 2;
          const dc = Math.min(...sh.screws.map((q) => Math.hypot(q.x - cx, q.y - cy)));
          centreWorst = Math.max(centreWorst, dc);
        }
        check(sh.screws.every((q) => q.x > R && q.y > R && q.x < sh.w - R && q.y < sh.h - R), 'screws inside the sheet');
        const cfgS = { ...s, ...tl, thickness: g.thickness };
        const tp = sheetToolpaths(sh, cfgS);
        // the first thing on the sheet: screw holes, then a park and a stop
        const firstCut = tp.moves.findIndex((m) => m.g === 1 && m.op !== 'screw');
        const pauseAt = tp.moves.findIndex((m) => m.pause);
        if (sh.screws.length) check(pauseAt > 0 && pauseAt < firstCut && tp.moves.slice(0, pauseAt).filter((m) => m.op === 'screw' && m.plunge).length >= sh.screws.length, 'screw holes drilled first, then a stop');
        // no cutter edge inside the clearance (screw holes themselves aside)
        let prev = null, r = 0;
        for (const m of tp.moves) {
          if (m.toolchange) { r = m.tool.dia / 2; continue; }
          if (m.x == null) continue;
          if (prev && m.g === 1 && m.op !== 'screw' && Math.min(prev.z, m.z) < 0) {
            for (const q of sh.screws) {
              const dx = m.x - prev.x, dy = m.y - prev.y, L2 = dx * dx + dy * dy;
              const t = L2 ? Math.max(0, Math.min(1, ((q.x - prev.x) * dx + (q.y - prev.y) * dy) / L2)) : 0;
              worst = Math.min(worst, Math.hypot(prev.x + t * dx - q.x, prev.y + t * dy - q.y) - r);
            }
          }
          prev = m;
        }
        const sbp = postShopBot(tp.moves, { ...cfgS, post: 'sbp' }, {});
        const gc = postGcode(tp.moves, { ...cfgS, post: 'fluidnc' }, {});
        if (sh.screws.length) check(/C7\n'Drive a screw[^\n]*\nPAUSE/.test(sbp) && /M5\n\(Drive a screw[^\n]*\)\nM0/.test(gc), 'posts: spindle off and a stop after the screw holes');
        // screw holes in their own file: the sheet's file has no screw holes and no
        // stop and cuts the same; the screw file is the same first bit, every hole, parked
        if (sh.screws.length) {
          const sep = sheetToolpaths(sh, { ...cfgS, screws: { ...s.screws, separate: true } });
          check(!sep.moves.some((m) => m.op === 'screw' || m.pause), 'separate screw file: none of it in the sheet file, no stop');
          // (the order can shift a little: the bit no longer starts from the park position)
          const cutLen = (mv) => { let L = 0, p = null; for (const m of mv) { if (m.x == null) continue; if (p && m.g === 1 && m.op !== 'screw' && Math.min(p.z, m.z) < 0) L += Math.hypot(m.x - p.x, m.y - p.y); p = m; } return L; };
          const la = cutLen(tp.moves), lb = cutLen(sep.moves);
          check(Math.abs(la - lb) <= 0.01 * la, `separate screw file: the sheet cuts the same (${la.toFixed(1)} vs ${lb.toFixed(1)} in)`);
          const sm = sep.screwMoves || [];
          const firstTool = tp.moves.find((m) => m.toolchange)?.tool;
          check(sm[0]?.toolchange && sm[0].tool === firstTool && sep.moves.find((m) => m.toolchange)?.tool === firstTool, 'separate screw file: drilled with the sheet\'s first bit');
          const holes = new Set(sm.filter((m) => m.op === 'screw' && m.plunge).map((m) => `${m.x.toFixed(3)},${m.y.toFixed(3)}`));
          check(holes.size === sh.screws.length && !sm.some((m) => m.pause || (m.g === 1 && m.op !== 'screw')), `separate screw file: ${sh.screws.length} holes and nothing else (${holes.size})`);
          const park = cfgS.park || { x: 0, y: 0 };
          const last = [...sm].reverse().find((m) => m.x != null);
          check(last && Math.abs(last.x - park.x) < 1e-6 && Math.abs(last.y - park.y) < 1e-6 && last.z >= cfgS.safeZ - 1e-6, 'separate screw file: ends parked at safe Z');
          const sgc = postGcode(sm, { ...cfgS, post: 'fluidnc' }, {});
          const ssb = postShopBot(sm, { ...cfgS, post: 'sbp' }, {});
          check(!/Drive a screw/.test(sgc + ssb) && /M30|M2\b/.test(sgc) && /END/.test(ssb), 'separate screw file: posts as a complete program with no stop for screws');
        }
        // simulation: clear; and a screw planted on a part is caught
        if (!faults.planted && sh.screws.length) {
          const sim = carve(sh, tp.moves, { res: 0.04, dia: tl.tool.dia });
          const opts = { dia: tl.tool.dia, profileDia: tl.tool.dia, thickness: g.thickness, holdDown: holdDownOf(cfgS), screws: sh.screws, screwR: R, screwHoleR: tl.tool.dia / 2 };
          const ok = simCheck(sh, sim, opts);
          check(ok.screw === 0, `simulation: nothing cut inside a screw clearance (${ok.screw})`);
          const pl = sh.placements[0], pg = placedGeometry(pl);
          const bad = simCheck(sh, sim, { ...opts, screws: [{ x: (pg.box.x0 + pg.box.x1) / 2, y: pg.box.y0 }] });
          faults.planted = bad.screw > 0;
        }
      }
    }
  }
  console.log(`screw hold-downs: ${sheets} sheets, ${spots} spots, ${missing} without room, ${thinN} in thin strips, ${keeperN} in a keeper offcut, centre screw within ${centreWorst.toFixed(1)}\" of the parts' centre, ${extraSheets} extra sheet(s), closest cut ${worst.toFixed(3)}" from a screw centre`);
  check(worst >= screwR(DEFAULT_SETTINGS.screws) - 0.01, `no cut inside a screw's clearance (closest ${worst.toFixed(3)}")`);
  check(faults.planted, 'simulation catches a screw spot that gets cut');
}

// --- custom shapes: fitted by outline among the cabinet parts, turned only as
// their grain allows; never touching, inside the sheet, cut cleanly ---
{
  const attrs = [{ cabinetPart: true, custom: true, material: '3/4 Baltic Birch', cabinetCode: 'CUSTOM', role: 'PANEL', cnc: true }];
  const custom = (name, poly, pockets = []) => rawPart(name, poly, 0.75, pockets, { attributes: attrs });
  const raw = [...sampleKitchen()];
  for (let i = 0; i < 4; i++) raw.push(custom('Trap' + i, [[0, 0], [20, 0], [14, 10], [0, 10]]));
  for (let i = 0; i < 6; i++) raw.push(custom('Tri' + i, [[0, 0], [16, 0], [0, 12]]));
  for (let i = 0; i < 4; i++) raw.push(custom('Brk' + i, [[0, 0], [18, 0], [18, 5], [5, 5], [5, 14], [0, 14]], [{ poly: [[8, 0], [8.75, 0], [8.75, 5], [8, 5]], depth: 0.25 }]));
  raw.push(custom('Plain', [[0, 0], [12, 0], [12, 6], [0, 6]]));   // a rectangular custom part: nested as now
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const base = normalizeAll(raw).parts;
  // everything the rectangle nester sees (cabinet parts and the plain custom part)
  const cabinetOnly = groupParts(applyGrain(base.filter((p) => p.include && !isShapePart(p, { shapeStep: 15 }))))[0];
  check(!base.some((p) => !p.custom && isShapePart(p, { shapeStep: 15 })), 'cabinet parts are never nested as shapes');
  check(base.some((p) => p.name === 'Plain' && p.custom && !isShapePart(p, { shapeStep: 15 })), 'a rectangular custom part nests as a rectangle');
  for (const grain of ['fixed', 'free']) {
    const all = structuredClone(base);
    all.forEach((p) => { if (p.custom && grain === 'free') { p.grain = 'none'; p.modelGrain = 'none'; } });
    let bad = [], angled = 0, shapes = 0, sheetsWith = 0, sheetsWithout = 0, mirrored = 0;
    for (const cl of [false, true]) for (const hold of ['skin', 'tabs']) for (const g of groupParts(applyGrain(all.filter((p) => p.include)))) {
      const nOpts = { ...s0.sheet, respectGrain: true, shapeStep: 15, shapeSpacing: s0.sheet.spacing, ...(cl ? { spacing: tl.tool.dia, commonLine: true } : {}) };
      const rect = nestParts(g.parts, nOpts);
      const nest = placeShapes(rect, g.parts, nOpts);
      if (!cl && hold === 'skin') { sheetsWith += nest.sheets.length; sheetsWithout += nestParts(g.parts, { ...nOpts, shapeStep: 0 }).sheets.length; }
      // same layout again (reopening a job), and replayed from its spots
      const again = placeShapes(nestParts(g.parts, nOpts), g.parts, nOpts);
      const replay = placeShapes(nestParts(g.parts, nOpts), g.parts, nOpts, nest.spots);
      const sig = (n) => JSON.stringify(n.sheets.map((sh) => sh.placements.filter((pl) => pl.shape).map((pl) => [pl.label, pl.angle, +pl.x.toFixed(4), +pl.y.toFixed(4)])));
      if (sig(again) !== sig(nest)) bad.push('not the same layout twice');
      if (sig(replay) !== sig(nest)) bad.push('replay differs');
      for (const sh of nest.sheets) {
        const P = sh.placements, G = P.map((pl) => placedGeometry(pl).outline);
        const sp = cl ? tl.tool.dia : s0.sheet.spacing;
        for (const [i, pl] of P.entries()) {
          if (!pl.shape) continue;
          shapes++;
          if (pl.angle % 90) angled++;
          if (pl.mirror) { mirrored++; if (pl.part.pockets.length) bad.push(`${pl.label}: a part with a dado turned over`); }
          const g0 = pl.part.grain;
          if (g0 === 'length' && ![0, 180].includes(pl.angle)) bad.push(`${pl.label} turned ${pl.angle} against its grain`);
          const tx = sh.trimX ?? sh.trim;
          if (G[i].some(([x, y]) => x < tx - 1e-3 || y < sh.trim - 1e-3 || x > sh.w - tx + 1e-3 || y > sh.h - sh.trim + 1e-3)) bad.push(`${pl.label} outside the usable sheet`);
          const grown = offset([G[i]], Math.max(sp, s0.sheet.spacing) - 0.004, 'round');
          for (let j = 0; j < P.length; j++) if (j !== i && intersect(grown, [G[j]]).length) bad.push(`${pl.label} closer than the spacing to ${P[j].label}`);
        }
        const cfgS = { ...s0, ...tl, commonLine: cl, holdDown: hold, tabs: { ...s0.tabs, on: true }, thickness: g.thickness };
        const tp = sheetToolpaths(sh, cfgS);
        const res = simCheck(sh, carve(sh, tp.moves, { res: 0.04, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: g.thickness, holdDown: hold });
        if (!res.ok) bad.push(`${cl ? 'shared' : 'spaced'} ${hold}: ${res.uncut} uncut, ${res.deep} deep, ${res.notThrough} not through`);
      }
    }
    check(!bad.length, `custom shapes (${grain} grain): ${shapes} placed, ${angled} at odd angles, ${sheetsWith} sheets (as rectangles: ${sheetsWithout})${bad.length ? ' - ' + [...new Set(bad)].slice(0, 4).join('; ') : ''}`);
    if (grain === 'free') check(angled > 0, 'free-grain shapes do use odd angles');
    check(!bad.some((b) => /dado turned over/.test(b)), 'a shape with a dado is never turned over');
    if (grain === 'fixed') check(mirrored > 0, `shapes without dados get turned over when it helps (${mirrored})`);
    check(sheetsWith <= sheetsWithout, 'fitting by outline never uses more sheets than nesting shapes as rectangles');
  }
  // the cabinet parts' own nest is untouched by shapes being present
  const withShapes = groupParts(applyGrain(base.filter((p) => p.include)))[0];
  const o = { ...s0.sheet, respectGrain: true, shapeStep: 15 };
  const a = nestParts(cabinetOnly.parts, o), b = nestParts(withShapes.parts, o);
  const cab = (n) => JSON.stringify(n.sheets.map((sh) => sh.placements.map((pl) => [pl.label, +pl.x.toFixed(4), +pl.y.toFixed(4), pl.rotated])));
  check(cab(a) === cab(b), 'cabinet parts nest exactly the same with custom shapes in the job');
}

// --- a hole drilled through a dado's wall line (Blum Tandem hook hole at the back of
// a drawer side): the dado is cut straight across it, not round it ---
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const d = tl.dadoTool.dia, r = d / 2;
  const bboxOf = (loops) => { const pts = loops.flat(); return { x0: Math.min(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), x1: Math.max(...pts.map((q) => q[0])), y1: Math.max(...pts.map((q) => q[1])) }; };
  const areaOf = (loops) => area(loops);
  const circ = (cx, cy, rr, n = 64) => Array.from({ length: n }, (_, k) => [cx + rr * Math.cos((2 * Math.PI * k) / n), cy + rr * Math.sin((2 * Math.PI * k) / n)]);
  // back dado 0.5" wide at x 18.75..19.25, the hole centred on its left wall
  const dado = [[18.75, 0], [19.25, 0], [19.25, 5], [18.75, 5]];
  const floor = difference([dado], [circ(18.75, 0.75, r)]);
  const fb = bboxOf(floor);
  const pocket = { loops: floor, depth: 0.25, x0: fb.x0, y0: fb.y0, x1: fb.x1, y1: fb.y1 };
  const out = fillHoleBites(pocket, [{ cx: 18.75, cy: 0.75, d, depth: Infinity }]);
  const ob = bboxOf(out.loops);
  check(Math.abs(areaOf(out.loops) - 2.5) < 0.003 && ob.x0 > 18.75 - 0.005 && out.loops.length === 1,
    `a hole on a dado wall: the floor is filled straight across (area ${areaOf(out.loops).toFixed(4)} of 2.5, left edge ${ob.x0.toFixed(4)})`);
  // a hole in the inside corner of an L pocket (rabbet meeting a dado): the
  // corner comes back square, and nothing outside the L is added
  const L = union([[[0, 0], [2, 0], [2, 0.5], [0, 0.5]]], [[[0, 0], [0.5, 0], [0.5, 2], [0, 2]]], 'nonzero');
  for (const [cx, cy] of [[0.5, 0.5], [0.6, 0.6], [0.45, 0.45]]) {
    const fl = difference(L, [circ(cx, cy, r)]);
    const b2 = bboxOf(fl);
    const got = fillHoleBites({ loops: fl, depth: 0.25, ...b2 }, [{ cx, cy, d, depth: Infinity }]);
    const outside = area(difference(got.loops, L));
    check(Math.abs(area(got.loops) - 1.75) < 0.003 && outside < 1e-4,
      `a hole at (${cx}, ${cy}) in an L pocket's inside corner: the L comes back as it was (area ${area(got.loops).toFixed(4)} of 1.75, ${outside.toFixed(5)} outside it)`);
  }
  // a hole wholly inside the floor: the floor is solid there
  const inner = fillHoleBites({ loops: difference([dado], [circ(19, 3, 0.1)]), depth: 0.25, x0: 18.75, y0: 0, x1: 19.25, y1: 5 }, [{ cx: 19, cy: 3, d: 0.2, depth: Infinity }]);
  check(inner.loops.length === 1 && Math.abs(area(inner.loops) - 2.5) < 1e-3, 'a hole inside a dado floor: no island left to cut round');
  // a hole near a dado but not touching it changes nothing
  const apart = fillHoleBites(pocket, [{ cx: 18.4, cy: 2, d, depth: Infinity }]);
  check(apart === pocket, 'a hole beside a dado (not touching it) changes nothing');
  const shallow = fillHoleBites(pocket, [{ cx: 18.75, cy: 0.75, d, depth: 0.1 }]);
  check(shallow === pocket, 'a hole shallower than the floor changes nothing');
  // through the whole pipeline: the dado's moves at floor depth never go round the hole
  const part = { id: 'ds', name: 'Drawer side', include: true, qty: 1, grain: 'none', thickness: 0.5, width: 20, height: 5,
    outline: [[0, 0], [20, 0], [20, 5], [0, 5]], holes: [circ(18.75, 0.75, r).reverse()], pockets: [pocket], material: 'BB 1/2', custom: true };
  const sh = nestParts([part], { ...s0.sheet, respectGrain: true }).sheets[0];
  const pl = sh.placements[0];
  const cfgS = { ...s0, ...tl, holdDown: 'skin', thickness: 0.5 };
  const tp = sheetToolpaths(sh, cfgS);
  const res = simCheck(sh, carve(sh, tp.moves, { res: 0.04, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: 0.5, holdDown: 'skin' });
  check(res.ok, `drawer side with a hole on its dado wall cuts clean (${res.uncut} uncut, ${res.deep} deep)`);
  // the wall pass on the hole's side is one straight line: no move at floor depth
  // lies left of the wall line (in the part) by more than the bit radius
  // the dado's moves stay between its two straight walls (a bit radius in from
  // each): nothing bulges toward the hole
  const g = placedGeometry(pl);
  const pb = bboxOf(g.pockets[0].loops);
  const across = pb.x1 - pb.x0 < pb.y1 - pb.y0 ? [pb.x0, pb.x1, 'x'] : [pb.y0, pb.y1, 'y'];
  const inDado = tp.moves.filter((m) => m.g === 1 && m.op !== 'drill' && m.op !== 'profile' && m.op !== 'tab' && m.op !== 'screw' && m.z < -0.01 && m.z > -0.3);
  const vals = inDado.map((m) => m[across[2]]);
  const lo = Math.min(...vals) - across[0], hi = across[1] - Math.max(...vals), rr = tl.dadoTool.dia / 2;
  check(inDado.length > 0 && lo > rr - 0.004 && hi > rr - 0.004, `the dado runs straight past the hole (bit centre ${lo.toFixed(4)}" and ${hi.toFixed(4)}" from the walls, radius ${rr.toFixed(4)})`);
}

// --- curved custom shapes (arcs as many short segments), turned and turned over:
// never closer than the spacing, and quick ---
{
  const arcPts = (cx, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  const norm = (pts) => { const mx = Math.min(...pts.map((q) => q[0])), my = Math.min(...pts.map((q) => q[1])); const o = pts.map(([x, y]) => [x - mx, y - my]); return { outline: o, width: Math.max(...o.map((q) => q[0])), height: Math.max(...o.map((q) => q[1])) }; };
  const mk = (name, pts, qty) => ({ id: name, name, custom: true, include: true, qty, grain: 'none', holes: [], pockets: [], ...norm(pts) });
  const parts = [
    mk('Corbel', [[0, 0], [12, 0], [12, 2], ...arcPts(12, 14, 12, -Math.PI / 2, -Math.PI, 120).slice(1)], 8),
    mk('Arch', [[0, 0], [24, 0], [24, 8], ...arcPts(12, 8, 12, 0, Math.PI, 160).slice(1)], 4),
    mk('Blob', arcPts(8, 6, 6, 0, 2 * Math.PI, 200).slice(0, -1).map(([x, y], i) => [x * (1 + 0.15 * Math.sin(i / 7)), y]), 6),
  ];
  const t0 = Date.now();
  const res = placeShapes({ sheets: [], unplaced: [] }, parts, { sheetW: 96, sheetH: 48, trim: 0.5, spacing: 0.45, respectGrain: true, shapeStep: 45, shapeFlip: true });
  const ms = Date.now() - t0;
  let close = 0, flipped = 0, n = 0;
  for (const sh of res.sheets) {
    const G = sh.placements.map((pl) => placedGeometry(pl).outline);
    flipped += sh.placements.filter((pl) => pl.mirror).length; n += G.length;
    for (let i = 0; i < G.length; i++) { const gi = offset([G[i]], 0.45 - 0.004, 'round'); for (let j = i + 1; j < G.length; j++) if (intersect(gi, [G[j]]).length) close++; }
  }
  check(n === 18 && close === 0, `curved shapes at 45° (turned over too): ${n} placed, ${flipped} turned over, ${close} too close`);
  check(ms < 30000, `curved shapes fit in reasonable time (${(ms / 1000).toFixed(1)} s)`);
  // the orders shared out over several workers (as the app does on more cores)
  // give the same layout as one worker trying them all
  const o90 = { sheetW: 96, sheetH: 48, trim: 0.5, spacing: 0.45, respectGrain: true, shapeStep: 90, shapeFlip: true };
  const whole = placeShapes({ sheets: [], unplaced: [] }, parts, o90);
  const sig = (r) => JSON.stringify(r.sheets.map((sh) => sh.placements.map((pl) => [pl.label, pl.angle, pl.mirror ? 1 : 0, +pl.x.toFixed(4), +pl.y.toFixed(4)])));
  for (const n of [2, 3, 8]) {
    const answers = Array.from({ length: n }, (_, w) => placeShapes({ sheets: [], unplaced: [] }, parts, { ...o90, passes: Array.from({ length: SHAPE_ORDERS }, (_, k) => k).filter((k) => k % n === w) }).spots);
    const better = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-6) return true; if (a[i] > b[i] + 1e-6) return false; } return false; };
    const win = answers.reduce((b, a) => (!b || better(a.cost, b.cost) || (!better(b.cost, a.cost) && a.pass < b.pass) ? a : b), null);
    const rebuilt = placeShapes({ sheets: [], unplaced: [] }, parts, o90, win);
    check(sig(rebuilt) === sig(whole), `custom shapes split over ${n} workers: same layout as one`);
  }
}

// --- merging identical parts: a half turn still merges, a mirror image never does ---
{
  // a back with a notch at one bottom corner, its half-turned twin, and its mirror image
  const notchL = [[0, 0.5], [1.4, 0.5], [1.4, 0], [12, 0], [12, 4.5], [0, 4.5]];
  const turned = notchL.map(([x, y]) => [12 - x, 4.5 - y]);
  const mirrored = notchL.map(([x, y]) => [12 - x, y]).reverse();
  const res = normalizeAll([rawPart('Back A', notchL, 0.5, [], { role: 'BACK' }), rawPart('Back AB', turned, 0.5, [], { role: 'BACK' }), rawPart('Back ABC', mirrored, 0.5, [], { role: 'BACK' })]);
  const rows = res.parts.map((p) => `${p.qty}:${p.sourceNames.join('+')}`).sort();
  check(res.parts.length === 2 && res.parts.some((p) => p.qty === 2), `half-turned twin merges, mirror image stays its own row (${rows.join(', ')})`);
}
{
  // sides with a dado and an end rabbet that meet in one L-shaped pocket: the
  // mirror image has the same pocket bounding box and area, but isn't the same part
  const out = [[0, 0], [30, 0], [30, 12], [0, 12]];
  // bottom dado across the depth at x 4..4.75; back rabbet along the rear edge
  // (y 11.5..12) from the top down to the dado; the right side is the mirror image
  const L = [[4, 0], [4.75, 0], [4.75, 11.5], [30, 11.5], [30, 12], [4, 12]];
  const Lm = L.map(([x, y]) => [x, 12 - y]).reverse();
  const mk = (name, poly) => rawPart(name, out, 0.75, [{ poly, depth: 0.25 }], { role: 'SIDE' });
  const res = normalizeAll([mk('Side L', L), mk('Side R', Lm), mk('Side L2', L)]);
  const rows = res.parts.map((p) => `${p.qty}:${p.sourceNames.join('+')}`).sort();
  check(res.parts.length === 2 && res.parts.some((p) => p.qty === 2 && p.sourceNames.includes('Side L2')), `mirrored L-shaped pocket (dado meeting a rabbet) stays its own row (${rows.join(', ')})`);
}

// --- separate end trim: parts stay endTrim from the ends (X) and trim from the long edges (Y) ---
{
  const many = normalizeAll(sampleKitchen()).parts;
  many.forEach((p) => { p.include = p.cnc !== false; });
  const g = groupParts(many.filter((p) => p.include))[0];
  const opts = { ...DEFAULT_SETTINGS.sheet, trim: 0.5, endTrim: 2, respectGrain: true };
  const res = nestParts(g.parts, opts);
  let worst = { x: 1e9, y: 1e9 };
  for (const sh of res.sheets) for (const pl of sh.placements) {
    const b = placedGeometry(pl).box;
    worst.x = Math.min(worst.x, b.x0, sh.w - b.x1);
    worst.y = Math.min(worst.y, b.y0, sh.h - b.y1);
  }
  check(worst.x >= 2 - 1e-6 && worst.y >= 0.5 - 1e-6, `end trim 2", edge trim 0.5": closest part to an end ${worst.x.toFixed(3)}, to a long edge ${worst.y.toFixed(3)}`);
  check(nestKey(g.parts, opts) !== nestKey(g.parts, { ...opts, endTrim: null }), 'end trim is part of the nest key');
  check(nestKey(g.parts, { ...opts, endTrim: null }) === nestKey(g.parts, { ...opts, endTrim: 0.5 }), 'end trim blank = same as edge trim');
}

// --- hand-placed screws: drilled even with automatic screws off, cuts keep
// clear of them, and bad spots (on a part, on a cut line, off the sheet) are caught ---
{
  const many = normalizeAll(sampleKitchen()).parts;
  many.forEach((p) => { p.include = p.cnc !== false; });
  const s = structuredClone(DEFAULT_SETTINGS);
  s.screws = { ...s.screws, on: false };
  const tl = resolveTools(s, DEFAULT_LIBRARY, []);
  const g = groupParts(many.filter((p) => p.include))[0];
  const sh = nestParts(g.parts, { ...s.sheet, respectGrain: true }).sheets[0];
  const cfg = { ...s, ...tl, thickness: g.thickness };
  const before = sheetToolpaths(sh, cfg);
  check(!before.moves.some((m) => m.op === 'screw' || m.pause), 'no screws: nothing drilled, no stop');
  // a clear spot: on the bare sheet past the parts, else the trim corner
  const R = screwR(s.screws);
  const geoms = sh.placements.map((pl) => placedGeometry(pl));
  // a clear spot: first grid point the check passes against the sheet's toolpath
  let good = null;
  for (let x = 1; x < sh.w && !good; x += 0.5) for (let y = 1; y < sh.h && !good; y += 0.5) {
    if (screwCheck({ ...sh, screws: [{ x, y }] }, before.moves, cfg)[0].ok) good = { x, y };
  }
  check(!!good, 'a clear spot for a screw is found');
  const pg = geoms[0];
  const onPart = { x: (pg.box.x0 + pg.box.x1) / 2, y: (pg.box.y0 + pg.box.y1) / 2 };
  const onEdge = { x: pg.box.x1 + 0.1, y: (pg.box.y0 + pg.box.y1) / 2 };
  const offSheet = { x: 0.05, y: 10 };
  const man = { ...sh, screws: [good, onPart, onEdge, offSheet], screwsManual: true };
  const tp = sheetToolpaths(man, cfg);
  const drilled = tp.moves.filter((m) => m.op === 'screw' && m.plunge).length;
  check(drilled >= 4 && tp.moves.filter((m) => m.pause).length === 1, `hand-placed screws drilled with automatic screws off, then one stop (${drilled})`);
  const chk = screwCheck(man, tp.moves, cfg);
  check(chk[0].ok, `a clear hand-placed spot still passes with its toolpath redone (${chk[0].why || 'ok'} at ${good.x}, ${good.y})`);
  check(!chk[1].ok && /inside a part/.test(chk[1].why), 'a screw on a part is caught');
  check(!chk[2].ok && /cut/.test(chk[2].why), 'a screw on a cut line is caught');
  check(!chk[3].ok && /edge/.test(chk[3].why), 'a screw off the edge is caught');
  const none = sheetToolpaths({ ...sh, screws: [], screwsManual: true }, cfg);
  check(!none.moves.some((m) => m.pause), 'all hand-placed screws removed: no stop');
  console.log(`hand-placed screws: ${chk.map((c) => (c.ok ? 'ok' : c.why)).join(' · ')}`);
}

// --- post files (.pp, Vectric format): the starter posts and a Vectric-style
// ShopBot post must put the tool exactly where the moves say, in order; first
// bit in the header (no stop), one stop per later bit and per screw stop ---
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    ...fs.readdirSync(path.join(here, '..', 'posts')).filter((f) => f.endsWith('.pp')).map((f) => path.join(here, '..', 'posts', f)),
    path.join(here, 'fixtures', 'vectric-shopbot-style.pp'),
  ];
  let junk = false;
  try { parsePP('hello\nworld'); } catch { junk = true; }
  check(junk, 'a file that is not a post is refused');
  const many = normalizeAll(sampleKitchen()).parts;
  many.forEach((p) => { p.include = p.cnc !== false; });
  const s = structuredClone(DEFAULT_SETTINGS);
  s.screws = { on: true, head: 0.375, clear: 0.125, depth: 0.25 };
  const tl = resolveTools(s, DEFAULT_LIBRARY, []);
  const g = groupParts(many.filter((p) => p.include))[0];
  const sh = nestParts(g.parts, { ...s.sheet, respectGrain: true, screws: { R: screwR(s.screws) } }).sheets[0];
  // two bits on the sheet, so there's a bit change
  const cfg0 = { ...s, ...tl, thickness: g.thickness, dadoTool: DEFAULT_LIBRARY.find((t) => t.id === 't-14down'), dadoSameTool: false };
  const tp = sheetToolpaths(sh, cfg0);
  const changes = tp.moves.filter((m) => m.toolchange).length;
  const pauses = tp.moves.filter((m) => m.pause).length;
  // replay a posted file: every position the tool goes to, in order
  const replay = (text, sbp, scale) => {
    const pts = [];
    let X = null, Y = null, Z = null;
    for (const raw of text.split('\n')) {
      const l = raw.split(sbp ? "'" : '(')[0].trim();
      if (!l) continue;
      if (sbp) {
        const a = l.split(',').map((v) => v.trim());
        const num = (v, cur) => (v === '' || v == null ? cur : Number(v) / scale);
        if (a[0] === 'J3' || a[0] === 'M3') { X = num(a[1], X); Y = num(a[2], Y); Z = num(a[3], Z); }
        else if (a[0] === 'J2') { X = num(a[1], X); Y = num(a[2], Y); }
        else if (a[0] === 'JZ' || a[0] === 'MZ') Z = num(a[1], Z);
        else if (a[0] === 'CG') { X = num(a[2], X); Y = num(a[3], Y); }
        else continue;
      } else {
        const w = Object.fromEntries([...l.matchAll(/([A-Z])(-?[\d.]+)/g)].map((m) => [m[1], Number(m[2]) / scale]));
        if (!('G' in w) && !('X' in w) && !('Y' in w) && !('Z' in w)) continue;
        const gg = Math.round((w.G ?? 1) * scale);
        if (![0, 1, 2, 3].includes(gg) && 'G' in w && !('X' in w || 'Y' in w || 'Z' in w)) continue;
        X = w.X ?? X; Y = w.Y ?? Y; Z = w.Z ?? Z;
      }
      if (X != null && Y != null && Z != null) pts.push([X, Y, Z]);
    }
    return pts;
  };
  for (const f of files) {
    const pp = parsePP(fs.readFileSync(f, 'latin1'));
    const name = path.basename(f);
    const sbp = pp.ext === 'sbp';
    const cfg = { ...cfg0, pp };
    const text = postAny(tp.moves, cfg, { title: 'Test (sheet 1)', material: g.material, sheetW: sh.w, sheetH: sh.h, fileName: 'test.' + pp.ext });
    // the moves as posted (arcs fitted when the post has arc blocks)
    const list = pp.hasArcs ? fitArcs(tp.moves) : tp.moves;
    const want = list.filter((m) => m.x != null).map((m) => [m.x, m.y, m.z]);
    const got = replay(text, sbp, 1);
    // every move's target appears, in order (the post may add retracts / home moves)
    let k = 0, bad = 0;
    for (const w of want) {
      while (k < got.length && Math.hypot(got[k][0] - w[0], got[k][1] - w[1], got[k][2] - w[2]) > 2e-3) k++;
      if (k >= got.length) { bad++; break; }
      k++;
    }
    check(bad === 0, `${name}: every move lands where the toolpath says, in order (${want.length} moves)`);
    // nothing cuts that the toolpath didn't: no position below the material top that isn't a move target
    const cutPts = want.filter((w) => w[2] < 0);
    const strays = got.filter((q) => q[2] < -1e-6 && !cutPts.some((w) => Math.hypot(q[0] - w[0], q[1] - w[1], q[2] - w[2]) < 2e-3));
    check(strays.length === 0, `${name}: no extra position in the material (${strays.length}${strays.length ? ': ' + strays.slice(0, 3).map((q) => q.map((v) => v.toFixed(4)).join(',')).join(' ') : ''})`);
    const L = text.split('\n');
    if (name.startsWith('Cabinet CAM')) {
      const stops = sbp ? L.filter((l) => /^C9\b/.test(l) || /^PAUSE\s*$/.test(l)).length : L.filter((l) => l.trim() === 'M0').length;
      check(stops === changes - 1 + pauses, `${name}: first bit already loaded; one stop per later bit and per screw stop (${stops} for ${changes} bits, ${pauses} screw stop)`);
      const firstCut = L.findIndex((l) => sbp ? /^(M3|MZ|CG),/.test(l) : /^G[123]\b/.test(l));
      check(!L.slice(0, firstCut).some((l) => sbp ? /^C9\b|^PAUSE\s*$/.test(l) : l.trim() === 'M0'), `${name}: no stop before the first cut`);
    }
  }
  // millimetres: the same post with UNITS = "MM" scales positions by 25.4
  const fl = fs.readFileSync(path.join(here, '..', 'posts', 'Cabinet CAM FluidNC.pp'), 'latin1').replace('UNITS = "INCHES"', 'UNITS = "MM"').replace('G20 G90', 'G21 G90');
  const ppmm = parsePP(fl);
  const tmm = postAny(tp.moves, { ...cfg0, pp: ppmm }, { title: 'mm' });
  const gotmm = replay(tmm, false, 25.4);
  const want0 = fitArcs(tp.moves).filter((m) => m.x != null);
  check(ppmm.units === 'MM' && gotmm.some((q) => Math.hypot(q[0] - want0[5].x, q[1] - want0[5].y) < 2e-3), 'UNITS "MM" posts positions in millimetres');
  console.log(`post files: ${files.length} posts checked against ${tp.moves.filter((m) => m.x != null).length} moves`);
}

// --- rapid travel must not get worse (RULES.md, toolpaths rule 1) ---
// Sample kitchen x3, default settings. If a change is meant to trade travel for
// something else, update these numbers on purpose and say why.
{
  // 2026-11-10: +3.5% on purpose: drilling first with each bit loaded once
  // (2 fewer manual bit changes on this job) and dado end-wall clean-up passes.
  // 2026-11-10 (3): +12% on purpose: touching pockets are one operation cut
  // shallowest first, each depth cleared before its walls are finished (the
  // bit goes from the shallow pocket to the deep one inside the operation).
  // 2026-11-10 (4): +15% on purpose: pocket wall passes climb-cut (the default;
  // 'either' direction is ~1.7 min faster on this job, back near 2146 / 2538).
  // 2026-11-16: lowered (-12% / -10%): dados and rabbets that run from one part
  // into a lined-up one beside it are cut as one pass across the gap.
  const RAPID_BASELINE = { 0: 2180, 0.02: 2615 };
  const many = normalizeAll(sampleKitchen()).parts;
  many.forEach((p) => { p.include = p.cnc !== false; p.qty = (p.qty || 1) * 3; });
  for (const onion of [0, 0.02]) {
    const s = structuredClone(DEFAULT_SETTINGS); s.onionSkin = onion;
    const tl = resolveTools(s, DEFAULT_LIBRARY, []);
    let tot = 0;
    for (const g of groupParts(many.filter((p) => p.include))) {
      const n = nestParts(g.parts, { ...s.sheet, respectGrain: true });
      for (const sh of n.sheets) tot += sheetToolpaths(sh, { ...s, ...tl, thickness: g.thickness }).stats.rapidLength;
    }
    const base = RAPID_BASELINE[onion];
    console.log(`rapids (onion ${onion}): ${tot.toFixed(0)} in, baseline ${base}`);
    check(tot <= base * 1.02, `rapid travel went up: ${tot.toFixed(0)} in vs baseline ${base} (onion ${onion})`);
  }
}

// ---------- moving parts by hand ----------
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const kitchen = normalizeAll(sampleKitchen()).parts;
  const grp = groupParts(kitchen.filter((p) => p.include)).find((x) => x.key.startsWith('3/4 Baltic'));
  const gap = s0.sheet.spacing;
  const nest = nestParts(grp.parts, { ...s0.sheet, respectGrain: true });
  const sh = nest.sheets[0];
  const tooClose = (sheet, i, g) => {
    const mine = placedGeometry(sheet.placements[i]).outline;
    return sheet.placements.some((q, j) => j !== i && area(intersect(offset([mine], g - 0.003, 'miter'), [placedGeometry(q).outline])) > 1e-6);
  };
  const inside = (sheet, i) => {
    const o = placedGeometry(sheet.placements[i]).outline;
    return o.every(([x, y]) => x >= sheet.trimX - 1e-6 && x <= sheet.w - sheet.trimX + 1e-6 && y >= sheet.trim - 1e-6 && y <= sheet.h - sheet.trim + 1e-6);
  };
  const i = 0, j = 1;
  const room = moveRoom(sh, i, { gap, screws: [], screwClear: 0 });
  // onto the next part: snaps clear of it
  const a = placedGeometry(sh.placements[i]).box, b = placedGeometry(sh.placements[j]).box;
  const onto = room.fit(b.x0 - a.x0 + 1, b.y0 - a.y0 + 1);
  const moved = applyMoves(sh, { [moveKey(sh.placements[i])]: { x: sh.placements[i].x + onto.dx, y: sh.placements[i].y + onto.dy } }, { gap }) ?? sh;
  check(onto.ok && onto.snapped && !tooClose(sh, i, gap) && inside(sh, i), `a part dropped on another snaps to the nearest spot clear of it (moved ${Math.hypot(onto.dx, onto.dy).toFixed(2)}")`);
  // off the sheet: comes back inside the usable area
  applyMoves(sh, null);
  const off = moveRoom(sh, i, { gap, screws: [], screwClear: 0 }).fit(-50, -50);
  applyMoves(sh, { [moveKey(sh.placements[i])]: { x: sh.placements[i].x + off.dx, y: sh.placements[i].y + off.dy } }, { gap });
  check(off.ok && inside(sh, i) && !tooClose(sh, i, gap), 'a part dragged off the sheet comes back to the nearest spot on it');
  // the moved sheet still cuts clean
  const cfgS = { ...s0, ...tl, holdDown: 'skin', thickness: grp.thickness };
  const tp = sheetToolpaths(sh, cfgS);
  const res = simCheck(sh, carve(sh, tp.moves, { res: 0.04, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: grp.thickness, holdDown: 'skin' });
  check(res.ok, `a sheet with a part moved by hand cuts clean (${res.uncut} uncut, ${res.deep} deep)`);
  // a screw is kept clear of
  applyMoves(sh, null);
  const q = placedGeometry(sh.placements[j]).box;
  const scr = [{ x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 }];
  applyMoves(sh, null);
  const r2 = moveRoom({ ...sh, placements: sh.placements.filter((_, k) => k !== j) }, 0, { gap, screws: scr, screwClear: 0.5 });
  const f2 = r2.fit(b.x0 - a.x0, b.y0 - a.y0);
  const o2 = placedGeometry({ ...sh.placements[i], x: sh.placements[i].x + f2.dx, y: sh.placements[i].y + f2.dy }).outline;
  const dmin = Math.min(...o2.map(([x, y], k) => { const [x2, y2] = o2[(k + 1) % o2.length]; const vx = x2 - x, vy = y2 - y; const t = Math.max(0, Math.min(1, ((scr[0].x - x) * vx + (scr[0].y - y) * vy) / (vx * vx + vy * vy || 1))); return Math.hypot(x + t * vx - scr[0].x, y + t * vy - scr[0].y); }));
  const inPoly = o2.reduce((c, [x, y], k) => { const [x2, y2] = o2[(k + 1) % o2.length]; return ((y > scr[0].y) !== (y2 > scr[0].y) && scr[0].x < ((x2 - x) * (scr[0].y - y)) / (y2 - y) + x) ? !c : c; }, false);
  check(f2.ok && f2.snapped && !inPoly && dmin >= 0.5 - 0.003, `a part dropped on a screw keeps its clearance (${dmin.toFixed(3)}" from the screw)`);
  // a part deleted from the sheet and one pasted on: the sheet has them, cuts clean
  {
    applyMoves(sh, null);
    const n0 = sh.placements.length;
    const gone = sh.placements[1];
    const src = sh.placements[0];
    const room0 = moveRoom({ ...sh, placements: [...sh.placements, { ...src, copy: 1001 }] }, n0, { gap, screws: [], screwClear: 0 });
    const f = room0.fit(0, 0);   // on top of the original: goes to the nearest free spot (or none)
    const edits = { removed: [moveKey(gone)], added: f.ok ? [{ partId: partKey(src.part), copy: 1001, label: 'copy', x: src.x + f.dx, y: src.y + f.dy, rotated: src.rotated }] : [] };
    applyMoves(sh, null, { gap, edits, partOf: (k) => grp.parts.find((q) => partKey(q) === k) });
    check(sh.placements.length === n0 - 1 + edits.added.length && !sh.placements.includes(gone) && sh.partsRemoved === 1, `delete / paste on a sheet: ${sh.partsRemoved} deleted, ${sh.partsAdded} pasted`);
    if (f.ok) check(!tooClose(sh, sh.placements.length - 1, gap) && inside(sh, sh.placements.length - 1), 'a pasted part sits clear of the others');
    const tp2 = sheetToolpaths(sh, cfgS);
    const res2 = simCheck(sh, carve(sh, tp2.moves, { res: 0.04, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: grp.thickness, holdDown: 'skin' });
    check(res2.ok, `a sheet with a part deleted and one pasted cuts clean (${res2.uncut} uncut, ${res2.deep} deep)`);
  }
  // hand-placed screws snap to the nearest spot clear of the cuts
  {
    applyMoves(sh, null);
    const tpS = sheetToolpaths(sh, cfgS);
    const S = cfgS.screws || {};
    const sr = screwRoom(sh, { clear: screwR(S), head: (S.head || 0.375) / 2, toolR: tl.tool.dia / 2, lines: [] });
    let bad = 0, snapped = 0;
    for (const pl of sh.placements) {
      const b = placedGeometry(pl).box;
      for (const [fx, fy] of [[0.5, 0.5], [0.05, 0.5], [0.5, 0.97]]) {
        const f = sr.fit(b.x0 + fx * (b.x1 - b.x0), b.y0 + fy * (b.y1 - b.y0));
        if (!f.ok) { bad++; continue; }
        snapped += f.snapped ? 1 : 0;
        const c = screwCheck({ ...sh, screws: [{ x: f.x, y: f.y }] }, tpS.moves, cfgS)[0];
        if (!c.ok) bad++;
      }
    }
    check(bad === 0 && snapped > 0, `screws dropped on parts snap to spots the cut check passes (${snapped} snapped, ${bad} bad)`);
    const off = sr.fit(-3, 20);
    check(off.ok && off.x >= (S.head || 0.375) / 2 - 1e-6, 'a screw dropped off the sheet comes back onto the stock');
  }
  applyMoves(sh, null);
  check(sh.partsMoved === 0 && sh.placements === sh.autoPlacements.placements, 'put back: the nest layout again');
}

// ---------- rule 6: holes and dados each done in one go, both before the part is cut out ----------
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const circ = (cx, cy, rr, n = 48) => Array.from({ length: n }, (_, k) => [cx + rr * Math.cos((-2 * Math.PI * k) / n), cy + rr * Math.sin((-2 * Math.PI * k) / n)]);
  const dado = [[18.75, 0], [19.25, 0], [19.25, 5], [18.75, 5]];
  const mk = (id) => ({ id, name: id, include: true, qty: 1, grain: 'none', thickness: 0.75, width: 20, height: 5,
    outline: [[0, 0], [20, 0], [20, 5], [0, 5]], holes: [circ(10, 2.5, 0.375 / 2), circ(5, 2.5, 0.1969 / 2), circ(14, 2.5, 0.25 / 2)],
    pockets: [{ loops: [dado], depth: 0.25, x0: 18.75, y0: 0, x1: 19.25, y1: 5 }], material: 'T', custom: false });
  const sample = groupParts(normalizeAll(sampleKitchen()).parts.filter((p) => p.include));
  let parts = 0, late = 0, split = 0;
  for (const dadoToolId of ['same', 't-14down']) {
    const s1 = { ...s0, dadoToolId };
    const tl = resolveTools(s1, DEFAULT_LIBRARY, []);
    const sheets = [{ sheet: nestParts([mk('A'), mk('B')], { ...s0.sheet, respectGrain: true }).sheets[0], t: 0.75 }];
    for (const g of sample) for (const sheet of nestParts(g.parts, { ...s0.sheet, respectGrain: true }).sheets) sheets.push({ sheet, t: g.thickness });
    for (const { sheet, t } of sheets) {
      const r = opOrder(sheet, sheetToolpaths(sheet, { ...s1, ...tl, thickness: t }).moves, tl.tool.dia / 2 + 0.02);
      parts += r.parts; late += r.late; split += r.split;
    }
  }
  check(late === 0, `every part's holes and dados are done before it's cut out (${parts} parts, ${late} not)`);
  check(split === 0, `each bit's holes are drilled in one go (${split} split)`);
  // planted faults: a hole drilled after the part's outline, a dado move in the middle of the drilling
  const tl = resolveTools({ ...s0, dadoToolId: 'same' }, DEFAULT_LIBRARY, []);
  const sh1 = nestParts([mk('A'), mk('B')], { ...s0.sheet, respectGrain: true }).sheets[0];
  const mv = sheetToolpaths(sh1, { ...s0, ...tl, thickness: 0.75 }).moves;
  const di = mv.findIndex((m) => m.op === 'drill' && m.plunge);
  const lateHole = [...mv.slice(0, di), ...mv.slice(di + 1), { ...mv[di] }];
  const pk = mv.find((m) => m.op !== 'drill' && m.g === 1 && m.z < 0 && m.x != null);
  const splitHoles = [...mv.slice(0, di + 1), { ...pk }, ...mv.slice(di + 1)];
  const r1 = opOrder(sh1, lateHole, tl.tool.dia / 2 + 0.02), r2 = opOrder(sh1, splitHoles, tl.tool.dia / 2 + 0.02);
  check(r1.late > 0 && r2.split > 0, `the order check catches a hole after the cutout (${r1.late}) and drilling split by a dado (${r2.split})`);
}
// late: a part with a hole or dado move after its first outline move; split: a
// bit whose drilling is broken up by other work before it's finished
function opOrder(sheet, moves, reach) {
  let parts = 0, late = 0, split = 0;
  for (const pl of sheet.placements) {
    const g = placedGeometry(pl);
    const inPart = (m) => m.x >= g.box.x0 - 1e-6 && m.x <= g.box.x1 + 1e-6 && m.y >= g.box.y0 - 1e-6 && m.y <= g.box.y1 + 1e-6;
    const cutting = (m) => m.g === 1 && m.z < -1e-4 && inPart(m);
    // the cut round it (a bit radius out; a shared line cut from the next part counts too)
    const near = (m) => m.x >= g.box.x0 - reach && m.x <= g.box.x1 + reach && m.y >= g.box.y0 - reach && m.y <= g.box.y1 + reach;
    const firstOutline = moves.findIndex((m) => (m.op === 'profile' || m.op === 'tab') && m.g === 1 && m.z < -1e-4 && near(m));
    // holes and dado work (drilling, clearing, finishing passes, corner reliefs)
    const lastWork = moves.reduce((k, m, i) => (m.op && !['profile', 'tab', 'screw', 'offcut'].includes(m.op) && cutting(m) ? i : k), -1);
    if (lastWork < 0) continue;
    parts++;
    if (firstOutline >= 0 && lastWork > firstOutline) late++;
  }
  // each bit load: its drill moves in one unbroken run
  let tool = null;
  const runs = new Map();
  moves.forEach((m, i) => {
    if (m.toolchange) { tool = m; return; }
    if (m.g !== 1 || m.z >= -1e-4) return;
    const r = runs.get(tool) || { first: -1, last: -1, other: [] };
    if (m.op === 'drill') { if (r.first < 0) r.first = i; r.last = i; } else r.other.push(i);
    runs.set(tool, r);
  });
  for (const r of runs.values()) if (r.first >= 0 && r.other.some((i) => i > r.first && i < r.last)) split++;
  return { parts, late, split };
}

// ---------- shared cut lines: neighbours' dados done in the order that travels least ----------
{
  // laid out like a real sheet (Carmel bathroom): two sides on the left, a long
  // bottom and stretcher on the right, all sharing cut lines, every part with dados
  const s0 = structuredClone(DEFAULT_SETTINGS);
  s0.commonLine = true;
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const g = tl.tool.dia;
  const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
  const P = (id, w, h, pockets) => ({ id, name: id, include: true, qty: 1, grain: 'none', thickness: 0.75, width: w, height: h, outline: rect(w, h), holes: [], pockets, material: 'T', custom: false });
  const pk = (x0, y0, x1, y1) => ({ loops: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], depth: 0.25, x0, y0, x1, y1 });
  const x2 = 1 + 23.125 + g;
  const sheet = { w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], placements: [
    { part: P('SIDE-R', 23.125, 21.5, [pk(22.4, 0, 23.125, 21.5), pk(0, 0.5, 23.125, 1.2)]), copy: 1, x: 1, y: 0.125, rotated: false },
    { part: P('SIDE-L', 23.125, 21.5, [pk(0, 0, 0.725, 21.5), pk(0, 20.3, 23.125, 21.0)]), copy: 1, x: 1, y: 0.125 + 21.5 + g, rotated: false },
    { part: P('STRETCHER-F', 61, 3.5, [pk(29.8, 0, 30.5, 3.5)]), copy: 1, x: x2, y: 0.125, rotated: false },
    { part: P('BOTTOM', 61, 20, [pk(30.5, 0, 31.2, 20)]), copy: 1, x: x2, y: 0.125 + 3.5 + g, rotated: false },
  ] };
  // this checks the per-part order (each part's dados with its profile), which
  // only runs with Dados before holes off; with it on every dado goes first and
  // the extra travel is accepted (checked just below)
  const tp = sheetToolpaths(sheet, { ...s0, ...tl, thickness: 0.75, holdDown: 'tabs', dadosFirst: false });
  {
    const mvA = sheetToolpaths(sheet, { ...s0, ...tl, thickness: 0.75, holdDown: 'tabs' }).moves;
    const lastPk = mvA.map((m, i) => (m.op === 'pocket' && m.g === 1 ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstPr = mvA.findIndex((m) => m.op === 'profile' && m.g === 1 && m.z < 0);
    check(lastPk >= 0 && lastPk < firstPr, `dados first: every dado on the sheet before the first outline (last dado ${lastPk}, first outline ${firstPr})`);
  }
  let rap = 0, prev = null;
  for (const m of tp.moves) { if (m.x == null) continue; if (prev && m.g === 0) rap += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; }
  // in the order the neighbours happen to be listed this was 189" (SIDE-R > SIDE-L > STRETCHER-F > BOTTOM)
  check(rap <= 160, `neighbours' dados before a shared line, least travel first (${rap.toFixed(0)}" of rapids, was 189")`);
  check(opOrder(sheet, tp.moves, tl.tool.dia / 2 + 0.02).late === 0, 'and still every part\'s dados before its cutout');
}

// ---------- hand-placed tabs ----------
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const grp = groupParts(normalizeAll(sampleKitchen()).parts.filter((p) => p.include)).find((x) => x.key.startsWith('3/4 Baltic'));
  const sh = nestParts(grp.parts, { ...s0.sheet, respectGrain: true }).sheets[0];
  const cfgT = { ...s0, ...tl, thickness: grp.thickness, holdDown: 'tabs', tabs: { ...s0.tabs, maxArea: 0 } };
  const auto = sheetToolpaths(sh, cfgT);
  const tabLifts = (tp) => tp.moves.filter((m) => m.op === 'tab').length;
  check(auto.tabs.length > 0 && auto.tabPaths.length === sh.placements.length, `the sheet reports its tabs (${auto.tabs.length}) and the bit's paths`);
  // the automatic tabs placed by hand: the same tabs
  const same = sheetToolpaths({ ...sh, tabsManual: auto.tabs.map((t) => ({ x: t.x, y: t.y })) }, cfgT);
  check(same.tabs.length === auto.tabs.length && Math.abs(tabLifts(same) - tabLifts(auto)) <= 2, `the automatic tabs placed by hand cut the same (${same.tabs.length} tabs)`);
  const res = simCheck(sh, carve(sh, same.moves, { res: 0.04, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: grp.thickness, holdDown: 'tabs' });
  check(res.ok, `hand-placed tabs: the sheet cuts clean (${res.uncut} uncut, ${res.deep} deep, ${res.notThrough} not through outside tabs)`);
  // one tab clicked a little off the first part's edge: only that part has a tab, on its path
  const b = placedGeometry(sh.placements[0]).box;
  const one = sheetToolpaths({ ...sh, tabsManual: [{ x: (b.x0 + b.x1) / 2, y: b.y0 - 0.5 }] }, cfgT);
  const path0 = one.tabPaths[0];
  const onPath = one.tabs.length === 1 && path0.some((q, i) => distSeg([one.tabs[0].x, one.tabs[0].y], q, path0[(i + 1) % path0.length]) < 1e-3);
  check(onPath && tabLifts(one) > 0 && tabLifts(one) < tabLifts(auto), `one tab clicked near an edge goes on that part's path (${one.tabs.length} tab, ${tabLifts(one)} tab moves)`);
  // hand-placed tabs are cut even when the job holds parts with onion skin
  const skin = sheetToolpaths({ ...sh, tabsManual: [{ x: (b.x0 + b.x1) / 2, y: b.y0 }] }, { ...cfgT, holdDown: 'skin' });
  check(tabLifts(skin) > 0, 'hand-placed tabs are cut with onion skin too');
  const far = sheetToolpaths({ ...sh, tabsManual: [{ x: -20, y: -20 }] }, cfgT);
  check(far.tabs.length === 0 && far.warnings.some((w) => /hand-placed tab/.test(w)), 'a tab nowhere near a part: not cut, and it says so');
  const none = sheetToolpaths({ ...sh, tabsManual: [] }, cfgT);
  check(tabLifts(none) === 0, 'Remove all: no tabs on the sheet');
}
function distSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2)) : 0;
  return Math.hypot(a[0] + t * vx - p[0], a[1] + t * vy - p[1]);
}

// ---------- dados joined across parts: a dado that runs out of one part into a lined-up one in the next is one pass ----------
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  s0.holdDown = 'tabs';
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const T = 0.75, W = 30, H = 20, gap = tl.tool.dia;   // common line: the parts the bit apart
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const panel = (id, y0) => ({ id, name: id, include: true, qty: 1, grain: 'none', thickness: T, width: W, height: H, outline: rect(0, 0, W, H), holes: [],
    pockets: [{ loops: [rect(0, y0, W, y0 + 0.75)], depth: 0.25, x0: 0, y0, x1: W, y1: y0 + 0.75 }], material: 'T', custom: false });
  const sheetOf = (yB) => ({ w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], placements: [
    { part: panel('PA', 10), copy: 1, x: 2, y: 2, rotated: false }, { part: panel('PB', yB), copy: 1, x: 2 + W + gap, y: 2, rotated: false }] });
  const cfgJ = { ...s0, ...tl, thickness: T };
  const run = (yB, join = true) => { const sh = sheetOf(yB); return { sh, tp: sheetToolpaths(sh, { ...cfgJ, joinDados: join }) }; };
  const pocketLifts = (tp) => {
    let on = false, n = 0, prev = null;
    for (const m of tp.moves) {
      if (m.comment) { on = / pocket /.test(m.comment); prev = null; continue; }
      if (!on || m.x == null) continue;
      if (prev && m.g === 0 && m.z > 0 && Math.hypot(m.x - prev.x, m.y - prev.y) > 1) n++;
      prev = m;
    }
    return n;
  };
  const crosses = (tp) => { let prev = null; return tp.moves.some((m) => { const ok = prev && m.g === 1 && m.z < -0.2 && Math.min(prev.x, m.x) < 2 + W - 0.1 && Math.max(prev.x, m.x) > 2 + W + gap + 0.1; if (m.x != null) prev = m; return ok; }); };
  const joined = (tp) => tp.moves.some((m) => m.comment && / \+ .* pocket /.test(m.comment));
  const a = run(10), off = run(10, false);
  check(joined(a.tp) && crosses(a.tp), 'lined-up dados in two parts are one pass, cut straight through the gap');
  check(a.tp.stats.estMinutes < off.tp.stats.estMinutes, `joined dados are quicker (${a.tp.stats.estMinutes.toFixed(3)} vs ${off.tp.stats.estMinutes.toFixed(3)} min)`);
  // a short jog: joined, it's one pass with no lifts (kept only when it's quicker)
  const jogSh = sheetOf(10.3), jogTp = sheetToolpaths(jogSh, { ...cfgJ, joinDados: 'all' });
  const jog = { sh: jogSh, tp: jogTp };
  check(joined(jog.tp) && pocketLifts(jog.tp) === 0, `dados a short jog apart can be joined: one pass, no lifts (${pocketLifts(jog.tp)})`);
  const pick = run(10.3).tp, pickOff = run(10.3, false).tp;
  check(pick.stats.estMinutes <= Math.min(jog.tp.stats.estMinutes, pickOff.stats.estMinutes) + 1e-6, 'joined or not, whichever is quicker is kept');
  check(!joined(run(12).tp), 'dados far apart sideways are not joined');
  for (const [nm, r] of [['lined up', a], ['jog', jog]]) {
    const res = simCheck(r.sh, carve(r.sh, r.tp.moves, { res: 0.03, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: T, holdDown: 'tabs' });
    check(res.ok, `joined dados (${nm}) cut clean (${res.uncut} uncut, ${res.deep} deep)`);
  }
}

// ---------- the exact cut (run simulator): true shapes from the moves ----------
{
  const r = 0.1875, opts = { zTop: 0, floorZ: -0.75, W: 30, H: 24 };
  const tri = (o, hs) => ShapeUtils.triangulateShape(o.map(([x, y]) => new Vector2(x, y)), hs.map((h) => h.map(([x, y]) => new Vector2(x, y))));
  const moves = [
    // a 3/4" dado, 0.25 deep: middle row and two wall passes
    { a: [4.375, -0.3, -0.25], b: [4.375, 23, -0.25], r }, { a: [4.1875, 23, -0.25], b: [4.1875, -0.3, -0.25], r }, { a: [4.5625, -0.3, -0.25], b: [4.5625, 23, -0.25], r },
    { a: [10, 10, 0.1], b: [10, 10, -0.5], r: 0.0984 },          // a 5 mm hole 0.5 deep
    { a: [15, 2, -0.8], b: [25, 2, -0.8], r },                   // a cut right through (overcut into the spoilboard)
    { a: [20, 5, 0], b: [21, 5, -0.2], r },                      // a ramp
    { a: [0, 30, 0.5], b: [20, 30, 0.5], r },                    // a rapid above the sheet
  ];
  const { levels } = cutLevels(moves, opts);
  const pts = (z) => levels.find((l) => Math.abs(l.z - z) < 1e-6)?.paths.flat().map((q) => [q.X / 1e5, q.Y / 1e5]) || [];
  const dado = pts(-0.25).filter(([x]) => x < 6);
  check(Math.abs(Math.min(...dado.map((p) => p[0])) - 4.0) < 1e-4 && Math.abs(Math.max(...dado.map((p) => p[0])) - 4.75) < 1e-4, 'exact cut: a 3/4" dado\'s walls are where the bit put them (to 0.0001")');
  const hole = pts(-0.5).map(([x, y]) => Math.hypot(x - 10, y - 10)).filter((d) => d < 1);
  check(hole.length > 30 && Math.max(...hole) - 0.0984 < 2e-4 && 0.0984 - Math.min(...hole) < 2e-4, `exact cut: a drilled hole is round (${hole.length} points, radius ${Math.min(...hole).toFixed(4)}-${Math.max(...hole).toFixed(4)})`);
  check(levels.some((l) => Math.abs(l.z + 0.75) < 1e-6) && !levels.some((l) => l.z < -0.75 - 1e-6), 'exact cut: a cut past the bottom stops at the bottom of the sheet');
  const ramp = levels.filter((l) => l.z > -0.2 - 1e-6 && l.z < 0);
  check(ramp.length >= 15, `exact cut: a ramp is cut in thin slices (${ramp.length})`);
  const m = cutMesh(moves, { ...opts, triangulate: tri });
  let walls = 0, badN = 0;
  for (let i = 0; i < m.kind.length; i++) {
    const nl = Math.hypot(m.normal[3 * i], m.normal[3 * i + 1], m.normal[3 * i + 2]);
    if (Math.abs(nl - 1) > 1e-3) badN++;
    if (m.kind[i] === 1) { walls++; if (Math.abs(m.normal[3 * i + 2]) > 1e-6) badN++; }
  }
  check(m.position.length > 0 && walls > 0 && badN === 0 && m.position.length % 9 === 0, `exact cut: a mesh of triangles, walls straight up and down (${m.position.length / 3} points)`);
  // the top face is the sheet less what was cut
  let topA = 0;
  for (let i = 0; i < m.kind.length; i += 3) if (m.kind[i] === 0) {
    const a = [m.position[3 * i], m.position[3 * i + 1]], b = [m.position[3 * i + 3], m.position[3 * i + 4]], c = [m.position[3 * i + 6], m.position[3 * i + 7]];
    topA += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  const cutA = levels[levels.length - 1].paths.reduce((s2, p) => s2 + ClipperLib.Clipper.Area(p), 0) / 1e10;
  check(Math.abs(topA + cutA - 30 * 24) < 0.01, `exact cut: top face + cut area = the sheet (${(topA + cutA).toFixed(3)} sq in)`);
  // a real sheet's program
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const grp = groupParts(normalizeAll(sampleKitchen()).parts.filter((p) => p.cnc !== false))[0];
  const sh = nestParts(grp.parts, { ...s0.sheet, respectGrain: true }).sheets[0];
  const tp = sheetToolpaths(sh, { ...s0, ...tl, thickness: grp.thickness });
  const seg = [];
  let prev = null;
  for (const mv of tp.moves) { if (mv.x == null) continue; if (prev) seg.push({ a: [prev.x, prev.y, prev.z], b: [mv.x, mv.y, mv.z], r: tl.tool.dia / 2 }); prev = mv; }
  const t0 = Date.now();
  const big = cutMesh(seg, { zTop: 0, floorZ: -grp.thickness, W: 96, H: 48, triangulate: tri });
  const ms = Date.now() - t0;
  check(big.levels.length > 2 && ms < 20000, `exact cut of a full sheet: ${big.levels.length} depths, ${(big.position.length / 3 / 1000).toFixed(0)}k points, ${ms} ms`);
  console.log(`exact cut: a full sheet in ${ms} ms, ${(big.position.length / 3 / 1000).toFixed(0)}k points`);
}

// ---------- a side: bottom dado and top rabbet both running into a back slot ----------
// rows spaced across each dado's own width (was two rows plus the walls, ending
// at the wrong end: 61" of travel)
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const L = 34.5, D = 23.25;
  const pockets = [{ loops: [rect(4.0, 0, 4.75, D - 0.75)], depth: 0.25 }, { loops: [rect(L - 0.75, 0, L, D - 0.75)], depth: 0.375 }, { loops: [rect(0, D - 1.0, L, D - 0.5)], depth: 0.3125 }];
  const part = { id: 'S', name: 'SIDE', include: true, qty: 1, grain: 'none', thickness: 0.75, width: L, height: D, outline: rect(0, 0, L, D), holes: [], pockets, material: 'T', custom: false };
  const sheet = { w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], placements: [{ part, copy: 1, x: 2, y: 2, rotated: false }] };
  const tp = sheetToolpaths(sheet, { ...s0, ...tl, thickness: 0.75 });
  let travel = 0, prev = null;
  for (const m of tp.moves) { if (m.x == null) continue; if (m.op === 'profile') break; if (prev && m.g === 0) travel += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; }
  check(travel < 50, `side with a back slot: ${travel.toFixed(0)}" of travel in its dados (was 61")`);
  const res = simCheck(sheet, carve(sheet, tp.moves, { res: 0.03, dia: tl.tool.dia }), { dia: tl.dadoTool.dia, profileDia: tl.tool.dia, thickness: 0.75, holdDown: s0.holdDown });
  check(res.ok, `side with a back slot cuts clean (${res.uncut} uncut, ${res.deep} deep)`);
}

// ---------- a drawer side's pocket: one end's rabbet, the groove, the other end, without crossing back and forth ----------
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const lib = DEFAULT_LIBRARY.map((t) => (t.id === 't-5mm' ? { ...t, stepover: 0.744, stepdown: 0.13 } : t));
  s0.toolId = 't-5mm'; s0.dadoToolId = 'same'; s0.holdDown = 'tabs';
  const tl = resolveTools(s0, lib, []);
  const L = 20.956, H = 4.531, rb = 0.43;
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const loops = union([rect(0, 0, rb, H), rect(L - rb, 0, L, H), rect(0, 3.532, L, 4.019)], [], 'nonzero');
  const part = { id: 'DS', name: 'DRAWER_SIDE', include: true, qty: 1, grain: 'none', thickness: 0.472, width: L, height: H, outline: rect(0, 0, L, H), holes: [],
    pockets: [{ loops, depth: 0.26, x0: 0, y0: 0, x1: L, y1: H }], material: 'T', custom: false };
  const sheet = { w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], placements: [{ part, copy: 1, x: 2, y: 2, rotated: false }] };
  const tp = sheetToolpaths(sheet, { ...s0, ...tl, thickness: 0.472 });
  const firstProfile = tp.moves.findIndex((m) => m.op === 'profile');
  let hop = 0, long = 0, prev = null;
  tp.moves.slice(0, firstProfile).forEach((m) => { if (m.x == null) return; if (prev && m.g === 0) { const d = Math.hypot(m.x - prev.x, m.y - prev.y); hop += d; if (d > 5) long++; } prev = m; });
  // nearest-next alone crossed the side four times (93" of travel)
  check(hop < 45 && long <= 1, `drawer side pocket: ${hop.toFixed(0)}" of travel, ${long} trip(s) the length of the side (was 93", 4)`);
  const res = simCheck(sheet, carve(sheet, tp.moves, { res: 0.02, dia: tl.tool.dia }), { dia: tl.tool.dia, profileDia: tl.tool.dia, thickness: 0.472, holdDown: 'tabs' });
  check(res.ok, `drawer side pocket cuts clean (${res.uncut} uncut, ${res.deep} deep)`);
}

// ---------- run simulator: the posted file read back and timed ----------
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  s0.dadoToolId = 't-14down';
  s0.screws = { ...(s0.screws || {}), on: true };
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const grp = groupParts(normalizeAll(sampleKitchen()).parts.filter((p) => p.include)).find((x) => x.key.startsWith('3/4 Baltic'));
  const shS = nestParts(grp.parts, { ...s0.sheet, respectGrain: true, screws: { R: screwR(s0.screws) } }).sheets[0];
  for (const pst of ['fluidnc', 'linuxcnc', 'sbp']) {
    const cfg = { ...s0, ...tl, thickness: grp.thickness, post: pst };
    const tp = sheetToolpaths(shS, cfg);
    const prog = parseProgram(postFile(tp.moves, cfg, { title: 'sim' }), pst === 'sbp' ? 'sbp' : 'gcode');
    const T = timeline(prog, cfg);
    const changes = tp.moves.filter((m) => m.toolchange).length - 1;
    const pauses = tp.moves.filter((m) => m.pause).length;
    const tools = T.stops.filter((x) => x.kind === 'tool').length, stopsN = T.stops.filter((x) => x.kind === 'stop').length;
    check(tools === changes && stopsN === pauses, `${pst}: the simulator finds ${tools} bit change(s) and ${stopsN} stop(s) (file has ${changes} and ${pauses})`);
    const est = tp.stats.estMinutes * 60;
    check(Math.abs(T.total - est) / est < 0.08, `${pst}: simulated run time ${(T.total / 60).toFixed(1)} min vs estimate ${(est / 60).toFixed(1)} min`);
    // the simulated tool goes through every cutting end point of the toolpath, in order
    const ends = tp.moves.filter((m) => m.x != null && m.g === 1);
    const last = T.at(T.total);
    const endZ = cfg.zZero === 'table' ? 0 : 0;
    check(last && Math.abs(last.p[2] - (cfg.safeZ ?? 0.5)) < 1e-3 + endZ || pst === 'sbp', `${pst}: run ends at safe Z`);
    // with arcs off every point of the toolpath is a line of the file
    const progL = parseProgram(postFile(tp.moves, { ...cfg, arcs: false }, { title: 'sim' }), pst === 'sbp' ? 'sbp' : 'gcode');
    const q = (x, y, z) => `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
    const simEnds = new Set(progL.moves.map((m) => q(m.b[0], m.b[1], m.b[2])));
    const near = (m) => simEnds.has(q(m.x, m.y, m.z)) || progL.moves.some((n) => Math.abs(n.b[0] - m.x) < 1e-3 && Math.abs(n.b[1] - m.y) < 1e-3 && Math.abs(n.b[2] - m.z) < 1e-3);
    const met = ends.filter(near).length;
    const bad = T.moves.filter((m) => m.t1 < m.t0 - 1e-9).length;
    check(bad === 0 && met === ends.length, `${pst}: the simulator reads back every point of the toolpath (${met} of ${ends.length})`);
  }
}

// ---------- construction sheets ----------
{
  const kitchen = normalizeAll(sampleKitchen()).places;
  check(kitchen.length === 15, `sample kitchen: placements for the 15 placed cabinet parts (got ${kitchen.length})`);
  const b36 = cabinetModel(kitchen.filter((p) => p.cabinet === 'B36'));
  check(Math.abs(b36.W - 36) < 1e-3 && Math.abs(b36.H - 34.5) < 1e-3 && Math.abs(b36.D - 23.25) < 1e-3, `B36 drawn 36 x 34.5 x 23.25 (got ${b36.W} x ${b36.H} x ${b36.D})`);
  const ref = JSON.stringify(cabinetModel(sampleCabinetPlaces(0)).parts.map((p) => [p.name, p.b]));
  for (const turn of [1, 2, 3]) {
    const m = cabinetModel(sampleCabinetPlaces(turn));
    check(JSON.stringify(m.parts.map((p) => [p.name, p.b])) === ref, `cabinet turned ${turn * 90}°: same front, same drawing`);
  }
  const m = cabinetModel(sampleCabinetPlaces(1));
  const door = m.parts.find((p) => p.role === 'DOOR');
  check(door.b[4] <= 0 + 1e-3 && door.b[1] < 0, 'door in front of the case');
  const dr = drawerBoxes(m);
  check(dr.length === 2 && Math.abs(dr[0].h - 10) < 1e-3 && Math.abs(dr[1].h - 6) < 1e-3 && Math.abs(dr[0].w - 12.625) < 1e-3,
    `two drawer boxes, top first (got ${dr.map((d) => `${d.w}x${d.h}x${d.d}`).join(', ')})`);
  const html = constructionHTML([...kitchen, ...sampleCabinetPlaces(3)], { job: 'T', cabinets: new Set(['B30D', 'B24']) });
  check(html && (html.match(/class="page"/g) || []).length === 2, 'one page per chosen cabinet');
  check(constructionHTML([], {}) === null, 'nothing to draw: null');
}

// ---------- slow plunge entry only into the sheet's face ----------
// A stepdown into floor an earlier level already cut has no face to enter: no
// entry-ipm plunge there, and the rapid down stops just above that floor.
{
  const many = normalizeAll(sampleKitchen()).parts.filter((p) => p.cnc !== false);
  const s = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s, DEFAULT_LIBRARY, []);
  for (const k of Object.keys(tl)) if (tl[k] && tl[k].stepdown) tl[k] = { ...tl[k], stepdown: 0.1 };
  const segD = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  let slowInCut = 0, steps = 0, rapidsDown = 0, intoStock = 0;
  for (const g of groupParts(many.map((p) => ({ ...p, include: true })))) {
    for (const sh of nestParts(g.parts, { ...s.sheet, respectGrain: true }).sheets) {
      const tp = sheetToolpaths(sh, { ...s, ...tl, thickness: g.thickness });
      let tool = null, prev = null;
      const cut = [];
      for (const m of tp.moves) {
        if (m.toolchange) { tool = m.tool; continue; }
        if (m.x == null) continue;
        const R = tool ? tool.dia / 2 : 0.125;
        // how deep the cut is at p so far (0 = uncut); footprint: the bit's circle
        const cutTo = (p) => cut.reduce((d, c) => (c.z < d && segD(p, c.a, c.b) <= c.r + 1e-4 ? c.z : d), 0);
        const ring = (x, y) => [[x, y], ...[...Array(12)].map((_, k) => [x + Math.cos(k * Math.PI / 6) * (R - 0.01), y + Math.sin(k * Math.PI / 6) * (R - 0.01)])];
        const footTo = (x, y) => Math.max(...ring(x, y).map(cutTo));
        // a plunge from above the sheet with the slow entry, where the whole footprint is already cut
        if (m.plunge && (m.op === 'pocket' || m.op === 'finish') && prev && prev.z > -1e-6 && footTo(m.x, m.y) < -0.07) slowInCut++;
        if (m.plunge && prev && prev.z < -1e-6 && prev.g === 0) steps++;
        if (m.g === 0 && m.z < -1e-6 && prev && prev.z > m.z + 1e-6) {
          rapidsDown++;
          if (footTo(m.x, m.y) > m.z + 1e-6) intoStock++;
        }
        // a straight-down move cuts its circle to its bottom; a sideways one, conservatively, at its top
        if (prev && m.g === 1) {
          const vert = Math.abs(prev.x - m.x) < 1e-9 && Math.abs(prev.y - m.y) < 1e-9;
          cut.push({ a: [prev.x, prev.y], b: [m.x, m.y], z: vert ? m.z : Math.max(prev.z, m.z), r: R });
        }
        prev = m;
      }
    }
  }
  check(slowInCut === 0, `stepdowns into cleared floor plunge without the slow entry (${slowInCut} still slow)`);
  check(rapidsDown > 10 && steps > 10, `stepdowns rapid down into the cleared floor (${rapidsDown} rapids down, ${steps} plunges from there)`);
  check(intoStock === 0, `no rapid goes down into uncut stock (${intoStock})`);
}

// ---------- holes after dados, from the dado floor; peck drilling ----------
{
  const circ = (cx, cy, d, n = 48) => Array.from({ length: n }, (_, k) => [cx + (d / 2) * Math.cos((2 * Math.PI * k) / n), cy + (d / 2) * Math.sin((2 * Math.PI * k) / n)]);
  const base = normalizeAll(sampleKitchen()).parts.find((p) => p.pockets?.length && /Left Side/.test(p.name));
  const d5 = 5 / 25.4;
  const dadoX = 4.375, inDado = [dadoX, 10], faceBlind = [20, 10], faceThru = [20, 15];
  const part = { ...base, qty: 1, include: true,
    holes: [...(base.holes || []), circ(...inDado, d5), circ(...faceThru, d5)],
    pockets: [...base.pockets, { loops: [circ(...faceBlind, d5)], depth: 0.375 }] };
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const quarter = DEFAULT_LIBRARY.find((t) => Math.abs(t.dia - 0.25) < 1e-6 && !/drill/i.test(t.name));
  const sh = nestParts([part], { ...s0.sheet, respectGrain: true, searchMs: 50 }).sheets[0];
  const pl = sh.placements[0];
  const at = (p) => placedGeometry(pl).map ? null : null;
  // where a part point lands on the sheet: match by the placed geometry of the drilled holes
  for (const [name, tools] of [['one bit', {}], ['separate dado bit', quarter ? { dadoTool: quarter } : null]]) {
    if (!tools) continue;
    const cfg = { ...s0, ...tl, ...tools, thickness: part.thickness };
    const tp = sheetToolpaths(sh, cfg);
    const mv = tp.moves;
    let tool = null;
    const tagged = mv.map((m) => { if (m.toolchange) tool = m.tool; return { ...m, bit: tool }; });
    const isDrillBit = (t) => t && Math.abs(t.dia - d5) < 0.006;
    const lastPocket = tagged.map((m, i) => (m.op === 'pocket' && m.g === 1 ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstDrill = tagged.findIndex((m) => m.op === 'drill' && isDrillBit(m.bit) && m.plunge);
    check(lastPocket >= 0 && firstDrill > lastPocket, `${name}: every dado is cut before the 5 mm holes (last dado move ${lastPocket}, first hole ${firstDrill})`);
    const loads = mv.filter((m) => m.toolchange).map((m) => m.tool.name);
    if (name === 'one bit') check(loads.length === 3 && loads[0] === loads[2] && isDrillBit(mv.filter((m) => m.toolchange)[1].tool), `one bit: main bit, then the drill, then the main bit again for the profiles (${loads.join(' -> ')})`);
    else check(loads.length === 3 && isDrillBit(mv.filter((m) => m.toolchange)[1].tool), `separate dado bit: dado bit, drill, profile bit — no extra loads (${loads.join(' -> ')})`);
    // group the drill plunges by hole
    const holes = new Map();
    tagged.forEach((m, i) => { if (m.op === 'drill' && isDrillBit(m.bit) && m.x != null) { const k = `${m.x.toFixed(3)},${m.y.toFixed(3)}`; if (!holes.has(k)) holes.set(k, []); holes.get(k).push({ ...m, i }); } });
    // every move from a hole's first plunge to its last (lifts carry no x, y)
    const byDepth = [...holes.values()].map((ms0) => { const pl0 = ms0.filter((m) => m.plunge); const ms = tagged.slice(pl0[0].i, pl0[pl0.length - 1].i + 1).map((m, k) => ({ ...m, i: pl0[0].i + k })); return { ms, bottom: Math.min(...ms.map((m) => m.z)), plunges: ms.filter((m) => m.plunge) }; }).filter((h) => h.plunges.length);
    // the hole in the dado: starts at the floor (-0.25), no slow entry, pecks 0.51 deep in <= 3/8 strokes, lifts to floor + 0.05
    const dadoHole = byDepth.find((h) => h.plunges.length && Math.max(...h.ms.map((m) => m.z)) < 0 && h.bottom < -0.7);
    check(!!dadoHole, `${name}: a hole drilled from a dado's floor (never above the sheet between strokes)`);
    if (dadoHole) {
      const firstZ = mv[dadoHole.plunges[0].i - 1].z;
      check(Math.abs(firstZ - (-0.25 + 0.02)) < 1e-6, `${name}: the hole in the dado starts just above its floor (${firstZ})`);
      check(!dadoHole.plunges.some((m) => m.f === m.bit.entryFeed && m.bit.entryFeed !== m.bit.drillFeed), `${name}: no slow entry from a dado floor`);
      const lifts = dadoHole.ms.filter((m) => !m.plunge && m.g === 0 && m.z > -0.25);
      check(lifts.length >= 1 && lifts.every((m) => Math.abs(m.z - (-0.25 + 0.05)) < 1e-6), `${name}: pecks lift to 0.05 over the dado floor (${lifts.map((m) => m.z.toFixed(3))})`);
    }
    // face through hole: 0.76 deep -> strokes of 3/8, lifting to +0.05
    const thru = byDepth.find((h) => h !== dadoHole && h.bottom < -0.7);
    const strokes = (h) => { const zs = []; let z = mv[h.plunges[0].i - 1].z; for (const m of h.ms) { if (m.plunge) zs.push(z - m.z); z = m.z; } return zs; };
    check(thru && thru.plunges.length >= 3 && strokes(thru).every((d) => d <= 0.375 + 0.03), `${name}: through hole from the face pecked in 3/8 strokes (${thru && strokes(thru).map((d) => d.toFixed(3))})`);
    const ups = thru ? thru.ms.filter((m) => !m.plunge && m.g === 0 && m.z > 0) : [];
    check(ups.length >= 2 && ups.every((m) => Math.abs(m.z - 0.05) < 1e-6), `${name}: face hole lifts to 0.05 between pecks (${ups.map((m) => m.z)})`);
    // 3/8 deep blind hole: one plunge
    const blind = byDepth.find((h) => Math.abs(h.bottom + 0.375) < 1e-6);
    check(blind && blind.ms.filter((m) => m.g === 0 && m.z > -0.375 && m.z < 0).length === 0, `${name}: a 3/8 deep hole is one plunge, no pecks`);
  }
}

// one bit and holes it drills itself: still one load; all the dados, then the
// holes (the one in a dado starts at its floor), then the outlines
{
  const circ = (cx, cy, d, n = 48) => Array.from({ length: n }, (_, k) => [cx + (d / 2) * Math.cos((2 * Math.PI * k) / n), cy + (d / 2) * Math.sin((2 * Math.PI * k) / n)]);
  const base = normalizeAll(sampleKitchen()).parts.find((p) => p.pockets?.length && /Left Side/.test(p.name));
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const dm = tl.tool.dia;
  const part = { ...base, qty: 2, include: true, holes: [...(base.holes || []), circ(4.375, 10, dm), circ(20, 15, dm)] };
  const sh = nestParts([part], { ...s0.sheet, respectGrain: true, searchMs: 50 }).sheets[0];
  const mv = sheetToolpaths(sh, { ...s0, ...tl, thickness: part.thickness }).moves;
  const loads = mv.filter((m) => m.toolchange);
  check(loads.length === 1, `one bit, its own holes: one load (${loads.length})`);
  const firstPocket = mv.findIndex((m) => m.op === 'pocket' && m.g === 1);
  const firstDrill = mv.findIndex((m) => m.op === 'drill' && m.plunge);
  check(firstPocket >= 0 && firstDrill > firstPocket, `one bit: dados before its holes (first dado ${firstPocket}, first hole ${firstDrill})`);
  const lowStart = mv.some((m, i) => m.op === 'drill' && m.plunge && mv[i - 1] && Math.abs(mv[i - 1].z - (-0.25 + 0.02)) < 1e-6);
  check(lowStart, 'one bit: the hole in the dado starts just above its floor');
  const firstProfileCut = mv.findIndex((m) => m.op === 'profile' && m.g === 1 && m.z < 0);
  const lastPocketM = mv.map((m, i) => (m.op === 'pocket' && m.g === 1 ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const lastDrill = mv.map((m, i) => (m.op === 'drill' && m.plunge ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  check(lastPocketM < firstProfileCut && lastDrill < firstProfileCut, `one bit: every dado and hole on the sheet before the first outline (last dado ${lastPocketM}, last hole ${lastDrill}, first outline ${firstProfileCut})`);
}

// a side with top, bottom and back dados, one 5 mm bit: the three dados run
// without lifting (the back dado's corner stubs don't drag the bit across and back)
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const bit = { ...tl.tool, id: 't5', name: '5 mm Straight', dia: 0.197, feed: 250, stepdown: 0.185, stepover: 0.85 };
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const pk = (x0, y0, x1, y1) => ({ loops: [rect(x0, y0, x1, y1)], depth: 0.26 });
  const W = 61, D = 23.25;
  const part = { id: 'S', name: 'S', include: true, qty: 1, grain: 'none', thickness: 0.73, width: W, height: D, outline: rect(0, 0, W, D), holes: [],
    pockets: [pk(0.6, 0.4, 1.33, D), pk(W - 1.33, 0.4, W - 0.6, D), pk(0.6, 0.4, W - 0.6, 0.9)], material: 'T', custom: false };
  const sheet = { w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], placements: [{ part, x: 1, y: 1, rot: 0, w: W, h: D, label: 'S' }] };
  const mv = sheetToolpaths(sheet, { ...s0, ...tl, tool: bit, dadoTool: null, dadoSameTool: true, thickness: 0.73, holdDown: 'onion' }).moves;
  let on = false, rap = 0, prev = null;
  for (const m of mv) {
    if (m.comment) { on = / pocket /.test(m.comment); continue; }
    if (!on || m.x == null) continue;
    if (prev && m.g === 0) rap += Math.hypot(m.x - prev.x, m.y - prev.y);
    prev = m;
  }
  check(rap < 5, `side with top, bottom and back dados: ${rap.toFixed(1)}" of rapids inside the dados (was 200")`);
}

// min stepdown (compression bits): a routed first pass shallower than it is
// warned about, the file is still made; drilling is never checked
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const lib = DEFAULT_LIBRARY.map((t) => (t.id === 't-38comp' ? { ...t, minStepdown: 0.3 } : { ...t, minStepdown: 5 }));
  const tl = resolveTools(s0, lib, []);
  const g = groupParts(normalizeAll(sampleKitchen()).parts.map((p) => ({ ...p, include: true })))[0];
  const sh = nestParts(g.parts, { ...s0.sheet, respectGrain: true, searchMs: 50 }).sheets.find((x) => x.placements.some((pl) => pl.part.pockets?.length));
  const tp = sheetToolpaths(sh, { ...s0, ...tl, thickness: g.thickness });
  const w = tp.warnings.filter((x) => x.startsWith('Min stepdown'));
  check(w.length === 1 && /dado/.test(w[0]) && tp.moves.length > 0, `min stepdown: one warning for the shallow dados, file still made (${w.join(' | ') || 'none'})`);
  const tp2 = sheetToolpaths(sh, { ...s0, ...resolveTools(s0, DEFAULT_LIBRARY, []), thickness: g.thickness });
  check(!tp2.warnings.some((x) => x.startsWith('Min stepdown')), 'min stepdown: off (0 / not set) = no warning');
  // the first pass (the one that cuts the surface) is at least the min; the rest split what's left
  const lib3 = DEFAULT_LIBRARY.map((t) => (t.id === 't-38comp' ? { ...t, minStepdown: 0.38 } : t));
  const tp3 = sheetToolpaths(sh, { ...s0, ...resolveTools(s0, lib3, []), thickness: g.thickness });
  const pz = [...new Set(tp3.moves.filter((m) => m.op === 'profile' && m.g === 1 && !m.plunge && m.z < 0).map((m) => +m.z.toFixed(4)))].sort((a, b) => b - a);
  check(Math.abs(pz[0] + 0.38) < 1e-6 && !tp3.warnings.some((x) => /profiles' first pass/.test(x)), `min stepdown: first profile pass at the min, not split equally (passes ${pz.join(', ')})`);
}

// smarter tabs: held at both ends, and a chain back to screwed-down waste
{
  const s0 = structuredClone(DEFAULT_SETTINGS);
  const tl = resolveTools(s0, DEFAULT_LIBRARY, []);
  const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
  const P = (name, w, h) => ({ id: name, name, include: true, qty: 1, grain: 'none', thickness: 0.75, width: w, height: h, outline: rect(w, h), holes: [], pockets: [], material: 'T', custom: false });
  const cfg = { ...s0, ...tl, thickness: 0.75, holdDown: 'tabs', screws: { ...s0.screws, on: true } };
  const place = (part, x, y) => ({ part, x, y, rot: 0, w: part.width, h: part.height, label: part.name });
  const corners = [{ x: 1, y: 1 }, { x: 95, y: 1 }, { x: 95, y: 47 }, { x: 1, y: 47 }];
  // a stack of drawer sides half an inch apart: each one held within the end fifth at both ends
  const stack = Array.from({ length: 5 }, (_, i) => place(P(`Side ${i + 1}`, 18, 6.6), 10, 10 + i * 7.1));
  const tA = sheetTabs({ w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], screws: corners, placements: stack }, cfg).tabs;
  const endsOk = stack.every((pl) => {
    const xs = tA.filter((t) => t.y > pl.y - 0.5 && t.y < pl.y + 7.1 && t.x > pl.x - 0.6 && t.x < pl.x + 18.6).map((t) => t.x - pl.x);
    return xs.some((x) => x <= 3.6 + 0.5) && xs.some((x) => x >= 18 - 3.6 - 0.5);
  });
  check(endsOk, 'tabs: every drawer side in a stack is held near both ends');
  // Min per part is a floor: thin drawer parts stacked a bit apart (edges under the
  // Spacing, shared with neighbours) still get it
  {
    const cfg4 = { ...cfg, tabs: { ...cfg.tabs, length: 1, ramp: 0.125, spacing: 24, min: 4, smallBelow: 0, maxArea: 0 } };
    const thin = Array.from({ length: 5 }, (_, i) => place(P(`Thin ${i + 1}`, 18, 2.062), 10, 10 + i * 2.562));
    const r4 = sheetToolpaths({ w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], screws: corners, screwsManual: true, placements: thin }, cfg4);
    const per = thin.map((pl) => r4.tabs.filter((q) => q.x >= pl.x - 0.3 && q.x <= pl.x + 18.3 && q.y >= pl.y - 0.3 && q.y <= pl.y + 2.362).length);
    check(per.every((n) => n >= 4) && !r4.warnings.some((w) => /tabs — its edges/.test(w)), `tabs: Min per part 4 met on thin stacked drawer parts (${per.join(', ')})`);
    // smaller parts get more: +1 each time the area halves below Small parts below, up to Max
    const o = { min: 3, smallBelow: 300, maxPer: 7 };
    check([802, 230, 119, 71, 37].map((a) => minTabsFor(o, a)).join() === '3,4,5,6,7' && minTabsFor({ ...o, smallBelow: 0 }, 37) === 3, 'tabs: minimum rises as parts get smaller (3,4,5,6,7), off at 0');
    const cfg5 = { ...cfg, tabs: { ...cfg.tabs, length: 0.5, ramp: 0.125, spacing: 24, min: 3, smallBelow: 300, maxPer: 6, maxArea: 0 } };
    const big = place(P('Big', 30, 20), 10, 10), small = place(P('Small', 12, 4), 50, 10);
    const r5 = sheetToolpaths({ w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], screws: corners, screwsManual: true, placements: [big, small] }, cfg5);
    const nb = r5.tabs.filter((q) => q.x < 45).length, ns = r5.tabs.filter((q) => q.x > 45).length;
    check(ns >= 6 && ns > nb - 1, `tabs: a 12x4 part gets more tabs than its floor (${ns}), a 30x20 its spacing count (${nb})`);
  }
  // a part in an island of waste with no screw (a ring of parts around it): no chain, so a warning
  const ring = [place(P('Ring top', 30, 4), 20, 30), place(P('Ring bottom', 30, 4), 20, 14.25), place(P('Ring left', 4, 11.5), 20, 18.5), place(P('Ring right', 4, 11.5), 46, 18.5), place(P('Inner', 8, 4), 31, 22)];
  const sheetB = { w: 96, h: 48, trim: 0.1, trimX: 0.1, offcuts: [], screws: corners, screwsManual: true, placements: ring };
  const wB = sheetToolpaths(sheetB, cfg).warnings.filter((w) => /no chain of tabs/.test(w));
  check(wB.length === 1 && /Inner/.test(wB[0]) && !/Ring/.test(wB[0]), `tabs: a part only next to waste with no screw is reported (${wB.join(' | ') || 'none'})`);
  // a screw in that island anchors it: no warning
  const wC = sheetToolpaths({ ...sheetB, screws: [...corners, { x: 28, y: 24 }] }, cfg).warnings.filter((w) => /no chain of tabs/.test(w));
  check(wC.length === 0, 'tabs: a screw in the island holds the part, no warning');
}

console.log(`\npocket lifts after first entry: ${liftTotal} across ${pocketTotal} pockets`);
check(arcTotal > 20, `G-code uses arcs (${arcTotal} G2/G3 in the sample job)`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
