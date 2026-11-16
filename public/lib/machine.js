// Machine time, the way the controller actually moves (GRBL / FluidNC style):
// every move is capped by its feed and by each axis's max speed, speeds up and
// slows down within each axis's acceleration, and only slows at a corner as
// much as the angle needs (junction deviation). Tool changes and spindle
// spin-up are added on top.
//
// profile: { maxXY, maxZ (ipm), accelXY, accelZ (in/s^2), toolChangeSec, junction (in) }

export const MACHINE_DEFAULTS = { maxXY: 240, maxZ: 90, accelXY: 10, accelZ: 10, toolChangeSec: 60, junction: 0.0004 };

export function machineProfile(cfg) {
  return { ...MACHINE_DEFAULTS, ...(cfg?.machine || {}) };
}

/**
 * moves: toolpath moves ({ g, x, y, z, f } plus toolchange / comment entries)
 * returns seconds: { total, cut, rapid, toolchange, spinup }
 */
export function machineTime(moves, cfg) {
  const P = machineProfile(cfg);
  const spin = cfg?.spinupSeconds ?? 3;
  // straight segments with their limits
  const segs = [];
  let pos = null, toolchanges = 0, spinups = 0, spindleOn = false, seenFirst = false;
  for (const m of moves) {
    // the first bit is already loaded: only later changes stop the machine
    if (m.toolchange) { if (seenFirst) toolchanges++; seenFirst = true; spindleOn = false; continue; }
    // an operator stop (screw hold-downs): counted like a bit change
    if (m.pause) { toolchanges++; spindleOn = false; continue; }
    if (m.x == null) continue;
    if (!pos) { pos = m; continue; }
    if (!spindleOn) { spindleOn = true; spinups++; }
    const dx = m.x - pos.x, dy = m.y - pos.y, dz = m.z - pos.z;
    const L = Math.hypot(dx, dy, dz);
    pos = m;
    if (L < 1e-9) continue;
    const u = [dx / L, dy / L, dz / L];
    const lim = (axXY, axZ) => {
      const xy = Math.hypot(u[0], u[1]);
      return Math.min(xy > 1e-9 ? axXY / xy : Infinity, Math.abs(u[2]) > 1e-9 ? axZ / Math.abs(u[2]) : Infinity);
    };
    const vAxis = lim(P.maxXY / 60, P.maxZ / 60);                 // in/s
    const v = m.g === 0 ? vAxis : Math.min(vAxis, (m.f || P.maxXY) / 60);
    const a = lim(P.accelXY, P.accelZ);
    segs.push({ L, u, v, a, rapid: m.g === 0 });
  }
  const n = segs.length;
  if (!n) return { total: toolchanges * P.toolChangeSec + spinups * spin, cut: 0, rapid: 0, toolchange: toolchanges * P.toolChangeSec, spinup: spinups * spin };
  const { times } = planMotion(segs, P);
  let cut = 0, rapid = 0;
  for (let i = 0; i < n; i++) { if (segs[i].rapid) rapid += times[i]; else cut += times[i]; }
  const tc = toolchanges * P.toolChangeSec, sp = spinups * spin;
  return { total: cut + rapid + tc + sp, cut, rapid, toolchange: tc, spinup: sp };
}

/** A straight move's limits: { L, u (unit vector), v (top speed, in/s), a (in/s^2) }. */
export function segLimits(d, f, rapid, P) {
  const L = Math.hypot(d[0], d[1], d[2]);
  const u = L > 1e-12 ? [d[0] / L, d[1] / L, d[2] / L] : [1, 0, 0];
  const lim = (axXY, axZ) => {
    const xy = Math.hypot(u[0], u[1]);
    return Math.min(xy > 1e-9 ? axXY / xy : Infinity, Math.abs(u[2]) > 1e-9 ? axZ / Math.abs(u[2]) : Infinity);
  };
  const vAxis = lim(P.maxXY / 60, P.maxZ / 60);
  return { L, u, v: rapid ? vAxis : Math.min(vAxis, (f || P.maxXY) / 60), a: lim(P.accelXY, P.accelZ), rapid };
}

/**
 * Speeds through a run of straight moves (no stops between them): the speed at
 * each junction (vj, n + 1 of them, 0 at both ends) and each move's time.
 */
export function planMotion(segs, P) {
  const n = segs.length;
  // junction speed limits (start of segment i): GRBL junction deviation
  const vj = new Array(n + 1).fill(0);
  for (let i = 1; i < n; i++) {
    const p = segs[i - 1], q = segs[i];
    const cos = -(p.u[0] * q.u[0] + p.u[1] * q.u[1] + p.u[2] * q.u[2]);   // cos of the angle between the reversed incoming and outgoing
    let lim;
    if (cos > 0.999999) lim = 0;                                  // full reversal
    else if (cos < -0.999999) lim = Infinity;                     // straight on
    else {
      const sinHalf = Math.sqrt(0.5 * (1 - cos));
      lim = Math.sqrt((Math.min(p.a, q.a) * P.junction * sinHalf) / (1 - sinHalf));
    }
    vj[i] = Math.min(lim, p.v, q.v);
  }
  vj[0] = 0; vj[n] = 0;
  // backward then forward pass: reachable with the acceleration
  for (let i = n - 1; i >= 0; i--) vj[i] = Math.min(vj[i], Math.sqrt(vj[i + 1] ** 2 + 2 * segs[i].a * segs[i].L));
  for (let i = 0; i < n; i++) vj[i + 1] = Math.min(vj[i + 1], Math.sqrt(vj[i] ** 2 + 2 * segs[i].a * segs[i].L));
  const times = segs.map((sg, i) => motionOf(sg, vj[i], vj[i + 1]).t);
  return { vj, times };
}

/**
 * One move from speed v0 to v1, cruising at most sg.v, accelerating at sg.a:
 * { t (seconds), at(tau) -> distance along it tau seconds in, speed(tau) }.
 */
export function motionOf(sg, v0, v1) {
  const { L, a } = sg;
  let vp = sg.v;
  let dAcc = (vp * vp - v0 * v0) / (2 * a), dDec = (vp * vp - v1 * v1) / (2 * a);
  if (dAcc + dDec > L) {
    vp = Math.sqrt(Math.max(v0 * v0, v1 * v1, (2 * a * L + v0 * v0 + v1 * v1) / 2));
    dAcc = Math.max(0, (vp * vp - v0 * v0) / (2 * a));
    dDec = Math.max(0, (vp * vp - v1 * v1) / (2 * a));
  }
  const tA = Math.max(0, (vp - v0) / a), tD = Math.max(0, (vp - v1) / a);
  const dC = Math.max(0, L - dAcc - dDec), tC = vp > 0 ? dC / vp : 0;
  const t = L < 1e-12 ? 0 : tA + tC + tD;
  const at = (tau) => {
    if (tau <= 0) return 0;
    if (tau < tA) return v0 * tau + 0.5 * a * tau * tau;
    if (tau < tA + tC) return dAcc + vp * (tau - tA);
    const r = Math.min(tau - tA - tC, tD);
    return Math.min(L, dAcc + dC + vp * r - 0.5 * a * r * r);
  };
  const speed = (tau) => (tau < tA ? v0 + a * tau : tau < tA + tC ? vp : Math.max(v1, vp - a * (tau - tA - tC)));
  return { t, at, speed };
}
