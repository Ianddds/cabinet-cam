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
  let cut = 0, rapid = 0;
  for (let i = 0; i < n; i++) {
    const { L, v, a } = segs[i];
    const v0 = vj[i], v1 = vj[i + 1];
    // trapezoid (or triangle) from v0 to v1 with cruise at most v
    const dAcc = (v * v - v0 * v0) / (2 * a), dDec = (v * v - v1 * v1) / (2 * a);
    let t;
    if (dAcc + dDec <= L) t = (v - v0) / a + (v - v1) / a + (L - dAcc - dDec) / v;
    else {
      const vp = Math.sqrt(Math.max(v0 * v0, v1 * v1, (2 * a * L + v0 * v0 + v1 * v1) / 2));
      t = Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
    }
    if (segs[i].rapid) rapid += t; else cut += t;
  }
  const tc = toolchanges * P.toolChangeSec, sp = spinups * spin;
  return { total: cut + rapid + tc + sp, cut, rapid, toolchange: tc, spinup: sp };
}
