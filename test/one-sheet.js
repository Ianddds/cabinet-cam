// Quick check on one sample sheet: tool order and rapids, dados first on vs off.
import './clipper-node.js';
import { sampleKitchen } from './synthetic.js';
import { normalizeAll } from '../lib/parts.js';
import { nestParts } from '../public/lib/nest.js';
import { sheetToolpaths } from '../public/lib/toolpath.js';
import { DEFAULT_SETTINGS, groupParts } from '../public/lib/settings.js';
import { DEFAULT_LIBRARY, resolveTools } from '../public/lib/tools.js';

const s = structuredClone(DEFAULT_SETTINGS);
const tl = resolveTools(s, DEFAULT_LIBRARY, []);
const g = groupParts(normalizeAll(sampleKitchen()).parts.map((p) => ({ ...p, include: true })))[0];
const sh = nestParts(g.parts, { ...s.sheet, respectGrain: true, searchMs: 50 }).sheets.find((x) => x.placements.length > 2);
for (const dadosFirst of [true, false]) {
  const mv = sheetToolpaths(sh, { ...s, ...tl, dadosFirst, thickness: g.thickness }).moves;
  let rap = 0, p = null;
  for (const m of mv) { if (m.x != null) { if (p && m.g === 0) rap += Math.hypot(m.x - p[0], m.y - p[1]); p = [m.x, m.y]; } }
  const idx = (f) => mv.map((m, i) => (f(m) ? i : -1)).filter((i) => i >= 0);
  const pk = idx((m) => m.op === 'pocket' && m.g === 1), dr = idx((m) => m.op === 'drill' && m.plunge), pr = idx((m) => m.op === 'profile' && m.g === 1 && m.z < 0);
  const ok = !pk.length || !pr.length || Math.max(...pk) < pr[0];
  console.log(`dadosFirst ${dadosFirst}: loads ${mv.filter((m) => m.toolchange).map((m) => m.tool.name).join(' -> ')}; ${pk.length ? 'last dado ' + Math.max(...pk) : 'no dados'}, ${dr.length ? 'holes ' + dr[0] + '-' + Math.max(...dr) : 'no holes'}, first outline ${pr[0]}; all dados before outlines: ${ok}; rapids ${rap.toFixed(0)} in`);
}

// same sheet with 5 mm holes added to its first part with dados (one in a dado)
const circ = (cx, cy, d, n = 48) => Array.from({ length: n }, (_, k) => [cx + (d / 2) * Math.cos((2 * Math.PI * k) / n), cy + (d / 2) * Math.sin((2 * Math.PI * k) / n)]);
const base = normalizeAll(sampleKitchen()).parts.find((p) => p.pockets?.length && /Left Side/.test(p.name));
const part = { ...base, qty: 3, include: true, holes: [...(base.holes || []), circ(4.375, 10, 5 / 25.4), circ(20, 15, 5 / 25.4)] };
const sh2 = nestParts([part], { ...s.sheet, respectGrain: true, searchMs: 50 }).sheets[0];
const mv = sheetToolpaths(sh2, { ...s, ...tl, thickness: part.thickness }).moves;
const idx = (f) => mv.map((m, i) => (f(m) ? i : -1)).filter((i) => i >= 0);
const pk = idx((m) => m.op === 'pocket' && m.g === 1), dr = idx((m) => m.op === 'drill' && m.plunge), pr = idx((m) => m.op === 'profile' && m.g === 1 && m.z < 0);
console.log(`with 5 mm holes: loads ${mv.filter((m) => m.toolchange).map((m) => m.tool.name).join(' -> ')}; last dado ${Math.max(...pk)}, holes ${dr[0]}-${Math.max(...dr)}, first outline ${pr[0]}`);
