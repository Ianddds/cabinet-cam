// Grain direction, decided in this order:
//   1. the part's own choice in the parts list (grainOverride)
//   2. what the cabinet builder tagged (modelGrain)
// (rules = per-part-type rules; the app no longer uses them)
// Values: 'length' (along the part's long side), 'width' (across it), and
// 'any' = rotate for the best fit. Grainless stock (modelled 'none') stays free
// unless the part itself is overridden.

export const GRAIN_CHOICES = [
  ['length', 'Along length'],
  ['width', 'Across width'],
  ['any', 'Any (best fit)'],
];
export const grainLabel = (g) => (g === 'none' ? 'No grain' : (GRAIN_CHOICES.find(([k]) => k === g) || [, g])[1]);
export const roleKey = (p) => p.role || '';

export function effectiveGrain(p, rules = {}) {
  if (p.grainOverride) return p.grainOverride;
  const model = p.modelGrain ?? p.grain ?? 'length';
  if (model === 'none') return 'none';
  return rules[roleKey(p)] || model;
}

// Parts as the nester wants them: grain is 'length' | 'width' | 'none' (= free).
export function applyGrain(parts, rules) {
  return parts.map((p) => {
    const g = effectiveGrain(p, rules);
    return { ...p, grain: g === 'any' ? 'none' : g, grainEffective: g };
  });
}

// One merged row -> one row per source part, so a single part can be changed.
export function splitPart(p) {
  const names = p.sourceNames || [p.name];
  if (p.qty <= 1 || names.length !== p.qty) return [p];
  return names.map((n, i) => ({
    ...p,
    name: n,
    qty: 1,
    cabinet: (p.sourceCabinets || [])[i] ?? p.cabinet,
    sourceNames: [n],
    sourceCabinets: [(p.sourceCabinets || [])[i] ?? p.cabinet],
    split: true,
  }));
}

// After re-fetching parts, carry each part's override across by name. A merged
// row whose sources disagree is split so every part keeps its own setting.
export function carryOverrides(oldParts, newParts) {
  const byName = new Map();
  for (const p of oldParts) for (const n of p.sourceNames || [p.name]) if (p.grainOverride) byName.set(n, p.grainOverride);
  if (!byName.size) return newParts;
  const out = [];
  for (const p of newParts) {
    const names = p.sourceNames || [p.name];
    const ov = names.map((n) => byName.get(n) || '');
    if (ov.every((o) => o === ov[0])) out.push(ov[0] ? { ...p, grainOverride: ov[0] } : p);
    else splitPart(p).forEach((q, i) => out.push(ov[i] ? { ...q, grainOverride: ov[i] } : q));
  }
  return out;
}
