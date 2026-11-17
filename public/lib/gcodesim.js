// Run simulation of a posted file: the G-code (FluidNC / LinuxCNC / .pp G-code
// posts) or ShopBot .sbp text is read back line by line, the way the
// controller would, and timed with the machine profile (accelerations, top
// speeds, cornering: machine.js). Then where the tool is at any moment, which
// line it's on and how fast it's going can be looked up for playback.
import { machineProfile, segLimits, planMotion, motionOf } from './machine.js';

const ARC_STEP = (1.5 * Math.PI) / 180;   // arcs as short straight moves: at most 1.5 degrees each
const ARC_CHORD = 0.01;                    //   ... and at most 0.01" long

/**
 * Read a posted file. Returns { lines, moves, stops }:
 *  moves: { a: [x,y,z], b: [x,y,z], f (ipm), rapid, line (0-based), tool (index), spindle }
 *  stops: { before (move index), line, kind: 'tool' | 'stop' | 'dwell', text, sec }
 * Coordinates as in the file (inches).
 */
export function parseProgram(text, kind = 'gcode') {
  const lines = String(text).replace(/\r/g, '').split('\n');
  return kind === 'sbp' ? parseSbp(lines) : parseGcode(lines);
}

function parseGcode(lines) {
  const moves = [], stops = [];
  let pos = [0, 0, 0], have = false, mode = 0, f = 0, scale = 1, abs = true, tool = 0, spindle = false, lastMsg = '';
  const push = (b, rapid, line) => {
    if (!have) { pos = b; have = true; return; }
    if (Math.hypot(b[0] - pos[0], b[1] - pos[1], b[2] - pos[2]) > 1e-9) moves.push({ a: pos, b, f, rapid, line, tool, spindle });
    pos = b;
  };
  lines.forEach((raw, li) => {
    // comments: (...) and ; ... - the last message is kept for the stop that follows
    const cm = raw.match(/\(([^)]*)\)/g);
    if (cm) lastMsg = cm.map((c) => c.slice(1, -1).replace(/^MSG,\s*/i, '')).join(' ');
    const code = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const w = {};
    const gs = [], msx = [];
    for (const [, L, v] of code.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
      if (L === 'G') gs.push(+v); else if (L === 'M') msx.push(+v); else w[L] = +v;
    }
    for (const g of gs) {
      if (g === 20) scale = 1; else if (g === 21) scale = 1 / 25.4;
      else if (g === 90) abs = true; else if (g === 91) abs = false;
      else if (g === 4) stops.push({ before: moves.length, line: li, kind: 'dwell', text: 'Dwell', sec: w.P != null ? w.P : 0 });
      else if ([0, 1, 2, 3].includes(g)) mode = g;
    }
    if (w.F != null) f = w.F * scale;
    if (msx.includes(6)) { tool++; stops.push({ before: moves.length, line: li, kind: 'tool', text: lastMsg || 'Tool change' }); }
    if (msx.includes(0) || msx.includes(1)) {
      const isTool = /\bload\b|tool|bit/i.test(lastMsg);
      if (isTool) tool++;
      stops.push({ before: moves.length, line: li, kind: isTool ? 'tool' : 'stop', text: lastMsg || 'Program stop' });
    }
    if (msx.includes(3) || msx.includes(4)) spindle = true;
    if (msx.includes(5)) spindle = false;
    const hasXYZ = w.X != null || w.Y != null || w.Z != null;
    if (!hasXYZ || gs.includes(4)) return;
    const val = (k, i) => (w[k] == null ? pos[i] : abs ? w[k] * scale : pos[i] + w[k] * scale);
    const b = [val('X', 0), val('Y', 1), val('Z', 2)];
    if ((mode === 2 || mode === 3) && have && (w.I != null || w.J != null)) {
      arc(pos, b, [pos[0] + (w.I || 0) * scale, pos[1] + (w.J || 0) * scale], mode === 2).forEach((q) => push(q, false, li));
    } else push(b, mode === 0, li);
  });
  return { lines, moves, stops };
}

// ShopBot: J/M moves (2 = XY, 3 = XYZ, X/Y/Z single axis), CG arcs, MS / JS
// speeds in inches per SECOND, PAUSE (with seconds: a wait, without: a stop),
// C6/C7 spindle, C9 tool change.
function parseSbp(lines) {
  const moves = [], stops = [];
  let pos = [0, 0, 0], have = false, fxy = 1, fz = 0.5, tool = 0, spindle = false, lastMsg = '';
  const push = (b, rapid, f, line) => {
    if (!have) { pos = b; have = true; return; }
    if (Math.hypot(b[0] - pos[0], b[1] - pos[1], b[2] - pos[2]) > 1e-9) moves.push({ a: pos, b, f, rapid, line, tool, spindle });
    pos = b;
  };
  lines.forEach((raw, li) => {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith("'")) { lastMsg = t.slice(1).trim(); return; }
    const parts = t.replace(/'.*$/, '').split(',').map((s) => s.trim());
    const cmd = parts[0].toUpperCase();
    const num = (i, d) => (parts[i] === undefined || parts[i] === '' ? d : +parts[i]);
    if (cmd === 'END') return;
    if (cmd === 'MS') { fxy = num(1, fxy); fz = num(2, fz); return; }
    if (cmd === 'C6') { spindle = true; return; }
    if (cmd === 'C7') { spindle = false; return; }
    if (cmd === 'C9') { tool++; stops.push({ before: moves.length, line: li, kind: 'tool', text: lastMsg || 'Change tool (C9)' }); return; }
    if (cmd.startsWith('PAUSE')) {
      const sec = parseFloat(cmd.slice(5)) || num(1, NaN);
      if (Number.isFinite(sec)) stops.push({ before: moves.length, line: li, kind: 'dwell', text: 'Pause', sec });
      else {
        const isTool = /\bload\b|zero z/i.test(lastMsg);
        if (isTool) tool++;
        stops.push({ before: moves.length, line: li, kind: isTool ? 'tool' : 'stop', text: lastMsg || 'Pause' });
      }
      return;
    }
    const rapid = cmd[0] === 'J';
    const f = rapid ? 0 : fxy * 60;
    if (/^[JM][23XYZ]$/.test(cmd)) {
      const ax = cmd[1];
      const b = pos.slice();
      if (ax === '2' || ax === '3') { b[0] = num(1, pos[0]); b[1] = num(2, pos[1]); if (ax === '3') b[2] = num(3, pos[2]); }
      else b['XYZ'.indexOf(ax)] = num(1, pos['XYZ'.indexOf(ax)]);
      const zOnly = b[0] === pos[0] && b[1] === pos[1];
      push(b, rapid, zOnly && !rapid ? fz * 60 : f, li);
      return;
    }
    if (cmd === 'CG' && have) {
      // CG, dia, x, y, i, j, T/I/O, dir (1 = CW), ...
      const b = [num(2, pos[0]), num(3, pos[1]), pos[2]];
      arc(pos, b, [pos[0] + num(4, 0), pos[1] + num(5, 0)], num(7, 1) === 1).forEach((q) => push(q, false, fxy * 60, li));
    }
  });
  return { lines, moves, stops };
}

// an arc from a to b round centre c as short straight moves (z changes evenly)
function arc(a, b, c, cw) {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let sweep = a1 - a0;
  if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; } else if (sweep <= 1e-9) sweep += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(sweep) / ARC_STEP, (Math.abs(sweep) * r) / ARC_CHORD)));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n, ang = a0 + sweep * t;
    out.push(k === n ? b.slice() : [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang), a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/**
 * The program's timeline: each move's start time and motion, and the stops.
 * opts: { cfg (machine profile, spin-up), stopSec (seconds a bit change /
 * operator stop counts for) }. Returns { total, moves (with t0, t1, m), stops
 * (with t), at(t) }.
 */
export function timeline(prog, cfg, opts = {}) {
  const P = machineProfile(cfg);
  const stopSec = opts.stopSec ?? P.toolChangeSec;
  const moves = prog.moves.map((m) => ({ ...m, lim: segLimits([m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]], m.f, m.rapid, P) }));
  // runs of moves between stops are planned together (the machine stops dead at a stop)
  const stopAt = new Map();
  for (const s of prog.stops) { if (!stopAt.has(s.before)) stopAt.set(s.before, []); stopAt.get(s.before).push(s); }
  let t = 0;
  const stops = [];
  let i = 0;
  const flushStops = (k) => {
    for (const s of stopAt.get(k) || []) {
      const sec = s.kind === 'dwell' ? s.sec : s.kind === 'tool' || s.kind === 'stop' ? stopSec : 0;
      stops.push({ ...s, t, sec });
      t += sec;
    }
  };
  while (i < moves.length) {
    flushStops(i);
    let j = i + 1;
    while (j < moves.length && !stopAt.has(j)) j++;
    const run = moves.slice(i, j);
    const { vj } = planMotion(run.map((m) => m.lim), P);
    run.forEach((m, k) => {
      const mo = motionOf(m.lim, vj[k], vj[k + 1]);
      m.t0 = t; m.t1 = t + mo.t; m.mo = mo;
      t = m.t1;
    });
    i = j;
  }
  flushStops(moves.length);
  const total = t;
  // where everything is at time t (binary search on the moves)
  const at = (tt) => {
    if (!moves.length) return null;
    let lo = 0, hi = moves.length - 1;
    if (tt <= moves[0].t0) return state(moves[0], 0, 0);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (moves[mid].t0 <= tt) lo = mid; else hi = mid - 1;
    }
    const m = moves[lo];
    if (tt >= m.t1) return state(m, lo, m.lim.L, 0, true);
    const tau = tt - m.t0;
    return state(m, lo, m.mo.at(tau), m.mo.speed(tau));
  };
  const state = (m, idx, d, v = 0, done = false) => {
    const L = m.lim.L || 1, k = Math.min(1, d / L);
    return {
      idx, line: m.line, rapid: m.rapid, tool: m.tool, spindle: m.spindle, done,
      p: [m.a[0] + (m.b[0] - m.a[0]) * k, m.a[1] + (m.b[1] - m.a[1]) * k, m.a[2] + (m.b[2] - m.a[2]) * k],
      ipm: v * 60, frac: k,
    };
  };
  return { total, moves, stops, at };
}
