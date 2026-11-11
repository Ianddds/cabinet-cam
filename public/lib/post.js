import { runPP } from './vpp.js';
// Post-processors. Input moves are inches, Z relative to material top.
// cfg.post: 'fluidnc' | 'linuxcnc' | 'sbp'
// cfg.zZero: 'top' (Z0 = top of sheet) or 'table' (Z0 = spoilboard).

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

const zOut = (z, cfg) => (cfg.zZero === 'table' ? z + cfg.thickness : z);

// ---------- arc fitting ----------
// Runs of short straight feeds that lie on one circle (rounded corners, cup
// walls, relief arcs, the spiral) become single G2/G3 arcs: smaller files, and
// the controller moves through them smoothly instead of slowing for every
// little segment. A run qualifies when: same Z, same feed and op, at least 4
// segments, every point within ARC_TOL of the circle, each turn small and all
// the same way, and the radius sensible. Straight runs are left alone.
const ARC_TOL = 0.0008;   // inch
function circleOf(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
}
export function fitArcs(moves) {
  const out = [];
  let prev = null;   // last position
  let i = 0;
  const same = (m, f) => m && m.x != null && m.g === 1 && !m.plunge && !m.ramp && m.z === f.z && m.f === f.f && m.op === f.op;
  while (i < moves.length) {
    const m = moves[i];
    if (m.x == null || !prev || !same(m, m) || prev.z !== m.z) { out.push(m); if (m.x != null) prev = m; i++; continue; }
    // try to grow an arc from prev through moves[i..j]
    const pts = [[prev.x, prev.y]];
    let j = i;
    while (j < moves.length && same(moves[j], m)) { pts.push([moves[j].x, moves[j].y]); j++; }
    let best = 0;   // number of moves taken into the arc
    for (let k = pts.length - 1; k >= 4; k--) {
      const c = circleOf(pts[0], pts[Math.floor(k / 2)], pts[k]);
      if (!c || c.r < 0.02 || c.r > 60) continue;
      let ok = true, sign = 0, sweep = 0;
      for (let q = 0; q <= k && ok; q++) if (Math.abs(Math.hypot(pts[q][0] - c.cx, pts[q][1] - c.cy) - c.r) > ARC_TOL) ok = false;
      for (let q = 1; q < k && ok; q++) {
        const ax = pts[q][0] - pts[q - 1][0], ay = pts[q][1] - pts[q - 1][1], bx = pts[q + 1][0] - pts[q][0], by = pts[q + 1][1] - pts[q][1];
        const cr = ax * by - ay * bx, dt = ax * bx + ay * by;
        const ang = Math.atan2(cr, dt);
        if (Math.abs(ang) > 0.5) ok = false;              // a corner, not a curve
        const sg = Math.sign(cr);
        if (sg && sign && sg !== sign) ok = false;
        if (sg) sign = sg;
      }
      if (ok) {
        // swept angle must stay under a full turn
        for (let q = 1; q <= k; q++) {
          const a0 = Math.atan2(pts[q - 1][1] - c.cy, pts[q - 1][0] - c.cx), a1 = Math.atan2(pts[q][1] - c.cy, pts[q][0] - c.cx);
          let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
          sweep += da;
        }
        if (Math.abs(sweep) > 2 * Math.PI - 0.05 || !sign) ok = false;
      }
      if (ok) { best = k; out.push({ ...moves[i + k - 1], arc: true, cw: sign < 0, i: c.cx - pts[0][0], j: c.cy - pts[0][1] }); break; }
    }
    if (best) { prev = moves[i + best - 1]; i += best; }
    else { out.push(m); prev = m; i++; }
  }
  return out;
}
const clean = (t) => String(t).replace(/[()]/g, '');

// ---------- G-code (FluidNC / LinuxCNC) ----------
export function postGcode(moves, cfg, meta = {}) {
  const L = [];
  const msg = (t) => (cfg.post === 'linuxcnc' ? `(MSG, ${clean(t)})` : `(${clean(t)})`);
  const dwell = cfg.spinupSeconds ?? 3;
  L.push(`(${clean(meta.title || 'Cabinet CAM')})`);
  L.push(`(Material ${clean(meta.material || '')} ${n(cfg.thickness)}in - Z0 = ${cfg.zZero === 'table' ? 'spoilboard' : 'material top'})`);
  L.push('G20 G90 G17 G94');
  L.push(`G0 Z${n(zOut(cfg.safeZ, cfg))}`);
  let lastF = null, lastG = null, spindleOn = false, rpm = cfg.tool.rpm, firstBit = true;

  for (const m of (cfg.arcs === false ? moves : fitArcs(moves))) {
    if (m.comment) { L.push(`(${clean(m.comment)})`); continue; }
    if (m.pause) {
      if (spindleOn) { L.push('M5'); spindleOn = false; }
      L.push(msg(m.note));
      L.push('M0');
      lastG = null;
      continue;
    }
    if (m.toolchange) {
      // the first bit is already in the machine: no stop, just a note
      if (firstBit) { firstBit = false; L.push(`(Bit: ${clean(String(m.note).replace(/^Tool:\s*/, ''))} - already loaded)`); rpm = m.tool.rpm; lastG = null; lastF = null; continue; }
      if (spindleOn) { L.push('M5'); spindleOn = false; }
      L.push(`G0 Z${n(zOut(cfg.safeZ, cfg))}`);
      L.push(msg(`Load ${m.note}, then cycle start`));
      L.push('M0');
      rpm = m.tool.rpm;
      lastG = null; lastF = null;
      continue;
    }
    if (!spindleOn) { L.push(`M3 S${rpm}`); L.push(`G4 P${dwell}`); spindleOn = true; }
    const w = [];
    const g = m.arc ? (m.cw ? 2 : 3) : m.g;
    if (g !== lastG || m.arc) w.push(`G${g}`);
    w.push(`X${n(m.x)}`, `Y${n(m.y)}`, `Z${n(zOut(m.z, cfg))}`);
    if (m.arc) w.push(`I${n(m.i)}`, `J${n(m.j)}`);
    if (g !== 0 && m.f !== lastF) { w.push(`F${n(m.f)}`); lastF = m.f; }
    lastG = g;
    L.push(w.join(' '));
  }
  L.push(`G0 Z${n(zOut(cfg.safeZ, cfg))}`);
  L.push('M5');
  if (cfg.park) L.push(`G0 X${n(cfg.park.x)} Y${n(cfg.park.y)}`);
  L.push('M30');
  return dedupe(L, (l) => l.startsWith('(')).join('\n') + '\n';
}

// ---------- ShopBot (.sbp) ----------
// Laid out like ShopBot's own (Vectric / PartWorks) post so it behaves the same
// on their machines: a units check, CN 90 at the start, &Tool + C9 for a bit
// change (ShopBot's routine: change the bit and zero Z), CG arcs, and CN 91 if
// the software is in metric. Speeds are inches per SECOND. No JS: the jog
// speed is a machine setting that outlives the file, so it's left alone.
// C6/C7 are the usual spindle on/off custom cuts (changeable in settings).
export const SBP_MAX_TOOL = 30;
export const toolNumberOk = (t, max = SBP_MAX_TOOL) => Number.isInteger(t?.num) && t.num >= 1 && t.num <= max;

export function postShopBot(moves, cfg, meta = {}) {
  const L = [];
  const spOn = cfg.sbpSpindleOn || 'C6';
  const spOff = cfg.sbpSpindleOff || 'C7';
  const dwell = cfg.spinupSeconds ?? 3;
  const maxTool = cfg.sbpMaxTool || SBP_MAX_TOOL;
  const safe = n(zOut(cfg.safeZ, cfg));
  const bitName = (m) => String(m.note).replace(/^Tool:\s*/, '');
  L.push(`'${meta.title || 'Cabinet CAM'}`);
  L.push(`'SHOPBOT ROUTER FILE IN INCHES - Cabinet CAM`);
  L.push(`'Material ${meta.material || ''} ${n(cfg.thickness)}in`);
  L.push(`'Z zero = ${cfg.zZero === 'table' ? 'SPOILBOARD (table surface)' : 'MATERIAL SURFACE (top of the sheet)'}`);
  L.push(`'Safe Z = ${safe}`);
  L.push(`'UNITS:Inches`);
  L.push(`IF %(25)=1 THEN GOTO UNIT_ERROR	'check to see software is set to standard`);
  L.push('SA');
  L.push('CN, 90');

  let xyF = cfg.tool.feed, zF = cfg.tool.plunge, lastMS = null, spindleOn = false;
  const ms = () => {
    const k = `MS,${n(xyF / 60)},${n(zF / 60)}`;
    if (k !== lastMS) { L.push(k); lastMS = k; }
  };
  const setTool = (m) => {
    if (toolNumberOk(m.tool, maxTool)) L.push(`&Tool = ${m.tool.num}	'${bitName(m)}`);
  };

  let firstBit = true;
  for (const m of (cfg.arcs === false ? moves : fitArcs(moves))) {
    if (m.comment) { L.push(`'${m.comment}`); continue; }
    if (m.pause) {
      if (spindleOn) { L.push(spOff); spindleOn = false; }
      L.push(`'${m.note}`);
      L.push('PAUSE');
      continue;
    }
    if (m.toolchange) {
      if (firstBit) {
        // the first bit is already in the machine: tell ShopBot which one, no C9
        firstBit = false;
        L.push(`'Bit: ${bitName(m)} - already loaded`);
        setTool(m);
        if (cfg.sbpSetRpm && m.tool.rpm) L.push(`TR,${m.tool.rpm}`);
        xyF = m.tool.feed || xyF; zF = m.tool.plunge || zF;
        continue;
      }
      if (spindleOn) { L.push(spOff); spindleOn = false; }
      L.push(`JZ,${safe}`);
      if (toolNumberOk(m.tool, maxTool)) {
        setTool(m);
        L.push(`C9	'Change tool (and zero Z)`);
      } else {
        // no usable tool number: stop, and the operator zeroes Z himself
        L.push(`'Load ${bitName(m)}, ZERO Z (C2), then press Continue`);
        L.push('PAUSE');
      }
      if (cfg.sbpSetRpm && m.tool.rpm) L.push(`TR,${m.tool.rpm}`);
      xyF = m.tool.feed || xyF; zF = m.tool.plunge || zF;
      lastMS = null;
      continue;
    }
    if (!spindleOn) { L.push(spOn); L.push(`PAUSE ${dwell}`); spindleOn = true; }
    const z = n(zOut(m.z, cfg));
    if (m.arc) {
      xyF = m.f; ms();
      // CG, diameter (blank = arc to a point), end X, end Y, centre offsets I, J, T = on the line, 1 = CW / -1 = CCW
      L.push(`CG, ,${n(m.x)},${n(m.y)},${n(m.i)},${n(m.j)},T,${m.cw ? 1 : -1}`);
    } else if (m.g === 0) {
      L.push(`J3,${n(m.x)},${n(m.y)},${z}`);
    } else if (m.plunge) {
      zF = m.f; ms();
      L.push(`MZ,${z}`);
    } else {
      xyF = m.f; ms();
      L.push(`M3,${n(m.x)},${n(m.y)},${z}`);
    }
  }
  L.push(`JZ,${safe}`);
  if (cfg.park) L.push(`J2,${n(cfg.park.x)},${n(cfg.park.y)}`);
  L.push(`'Turning router OFF`);
  L.push(spOff);
  L.push('END');
  L.push(`'`);
  L.push('UNIT_ERROR:');
  L.push(`CN, 91	'Run file explaining unit error`);
  L.push('END');
  return dedupe(L, (l) => l.startsWith("'")).join('\n') + '\n';
}

// Drop consecutive identical motion lines (comments are kept).
function dedupe(lines, isComment) {
  return lines.filter((l, i) => i === 0 || isComment(l) || l !== lines[i - 1]);
}

// cfg.pp: a parsed Vectric-format post (.pp file, see vpp.js) - used instead
// of the built-in posts when the job's post is one of the post files.
export function post(moves, cfg, meta) {
  if (cfg.pp) return runPP(cfg.pp, moves, cfg, meta, { fitArcs, zOut }).text;
  return cfg.post === 'sbp' ? postShopBot(moves, cfg, meta) : postGcode(moves, cfg, meta);
}
export function postWithWarnings(moves, cfg, meta) {
  if (cfg.pp) return runPP(cfg.pp, moves, cfg, meta, { fitArcs, zOut });
  return { text: post(moves, cfg, meta), warnings: [] };
}

export const fileExtension = (cfg) => (cfg.pp ? cfg.pp.ext : cfg.post === 'sbp' ? 'sbp' : cfg.post === 'linuxcnc' ? 'ngc' : 'nc');
