// Offline pipeline test: synthetic extraction -> normalize -> nest -> toolpath -> post.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './clipper-node.js';
import { sampleKitchen } from './synthetic.js';
import { inRegion, difference, offset, union, area } from '../public/lib/clip.js';
import { normalizeAll } from '../lib/parts.js';
import { decode } from '../lib/onshape.js';
import { nestParts, placedGeometry, applySolution, nestKey } from '../public/lib/nest.js';
import { sheetToolpaths, placeTabs, legsOf, splitLobes, legsFromWalls, offcutCutLines, screwR, screwCheck } from '../public/lib/toolpath.js';
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
      let prevM = null, bad = 0;
      for (const m of tp.moves) {
        if (m.x == null) continue;
        if (prevM && m.g === 0 && m.z < cfg.safeZ - 1e-9 && Math.hypot(m.x - prevM.x, m.y - prevM.y) > 1e-6 && m.z > 0) {
          const ok = regs.some((rg) => [0, 0.25, 0.5, 0.75, 1].every((t) => inRegion([prevM.x + (m.x - prevM.x) * t, prevM.y + (m.y - prevM.y) * t], rg)));
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
            if (n > Math.max(1, Math.ceil(L / (tcfg.tabs.spacing || 18) - 1e-6)) + 0) crowded++;
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
    check(crowded === 0, `no straight edge has more than one tab per Spacing, rounded up (${crowded} crowded)`);
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
      check(new Set(loads).size === loads.length, `each bit loaded once per sheet (${loads.map((t) => t.name).join(', ')})`);
      // every bit's holes come before anything else it cuts, and drill-only bits come first
      let curT = null, cutYet = false, badDrill = 0;
      for (const m of tp.moves) {
        if (m.toolchange) { curT = m.tool; cutYet = false; continue; }
        if (m.g !== 1) continue;
        if (m.op === 'drill' && cutYet) badDrill++;
        if (m.op !== 'drill') cutYet = true;
      }
      check(badDrill === 0, 'holes drilled before the bit cuts anything else');
      const drillOnly = loads.filter((t) => t !== tl.tool && t !== tl.dadoTool);
      if (drillOnly.length) {
        sheetsWithDrills++;
        check(loads.slice(0, drillOnly.length).every((t) => drillOnly.includes(t)), 'drill-only bits go first');
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
            const zk = m.z.toFixed(4);
            if (m.op === 'finish') finAt.add(zk);
            if (m.op === 'pocket' && !m.ramp && finAt.has(zk) && Math.hypot(m.x - prevM.x, m.y - prevM.y) > 0.3) badFin++;
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
          if (!comments.some((c) => c === name || c.startsWith(name + ' '))) missingWork++;
          if (gq.pockets.length && !comments.some((c) => c.startsWith(name + ' pocket'))) missingWork++;
          // the first cut along this part's outline comes after its own work started
          const loop = offset([gq.outline], r, 'miter').sort((a, b) => area([b]) - area([a]))[0];
          const firstOutline = tp.moves.findIndex((m, i) => i > 0 && m.g === 1 && m.z < 0 && (m.op === 'profile' || m.op === 'tab') && tp.moves[i - 1].x != null &&
            loop.some((q, j) => segD([(m.x + tp.moves[i - 1].x) / 2, (m.y + tp.moves[i - 1].y) / 2], q, loop[(j + 1) % loop.length]) < 0.003));
          const ownStart = tp.moves.findIndex((m) => m.comment && (m.comment === name || m.comment.startsWith(name + ' ')));
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
  const RAPID_BASELINE = { 0: 2480, 0.02: 2890 };
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

console.log(`\npocket lifts after first entry: ${liftTotal} across ${pocketTotal} pockets`);
check(arcTotal > 20, `G-code uses arcs (${arcTotal} G2/G3 in the sample job)`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
