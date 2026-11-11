// Default job settings (inches, inches/minute) and part grouping.
export const DEFAULT_SETTINGS = {
  sheet: { sheetW: 96, sheetH: 48, trim: 0.5, spacing: 0.45 },
  respectGrain: true,
  nestSeconds: 6,
  // remnants: use them in nests; trim = clean-up margin around one; offcuts are
  // kept only when both sides >= minSide and the area >= minArea (sq in)
  remnants: { use: true, trim: 0.25, minSide: 8, minArea: 288, cutFree: true },
  // Zebra labels: size in inches, printer dpi; mode download | network (host[:port]) | share (Windows shared printer name)
  labels: { w: 2, h: 1, dpi: 203, header: true, offcuts: true, mode: 'download', host: '', share: '' },       // time spent searching for a better nest (per material, side by side)
  // tools come from the tool library (public/lib/tools.js, data/tools.json)
  profileToolId: 't-38comp',
  dadoToolId: 'same',
  holeToolIds: ['t-5mm', 't-6mm', 't-14drill'],
  safeZ: 0.5,
  hopZ: 0.1,
  // shared cut lines: parts nest exactly the profile bit apart and an edge two
  // parts share is cut once (Part spacing is then not used)
  commonLine: true,
  // pocket wall passes: 'climb' (cleaner walls in ply with a clockwise spindle),
  // 'conventional', or 'either' (whichever direction travels least)
  finishDir: 'climb',
  // pockets: ramp into the cut at this angle instead of plunging (0 = plunge)
  pocketRampAngle: 0,
  // how parts are held while the last pass cuts them free:
  // 'skin' = onion skin, 'tabs', 'both', 'none' (parts cut right through)
  holdDown: 'skin',
  onionSkin: 0.02,
  // tabs left on part outlines; thickness = material left at the bottom, maxArea 0 = all parts
  tabs: { on: false, length: 0.375, thickness: 0.125, ramp: 0.25, spacing: 18, min: 2, maxArea: 0 },  // ramp: length of the slope on and off each tab (0 = straight up and down)
  overcut: 0.01,
  stayDownMax: 3,
  smallPartArea: 50,   // final pass frees parts under this many sq in first (0 = one trip, least travel)      // dados: feed back over cleared floor up to this far instead of lifting
  climb: false,
  zZero: 'top',
  post: 'fluidnc',
  arcs: true,          // G2/G3 arcs in G-code (not ShopBot)
  spinupSeconds: 4,
  park: { x: 0, y: 46 },
  // machine profile: top speeds (ipm), acceleration (in/s²), a manual bit
  // change (seconds). Used for rapids, the time estimate and every choice of
  // cutting order (ShopBot jog speeds come from it too).
  machine: { maxXY: 240, maxZ: 90, accelXY: 10, accelZ: 10, toolChangeSec: 60 },
  // screw hold-downs: 5 screws (corners + centre of the parts' area), in spots the nest
  // keeps clear; the first bit drills them, the machine parks and stops for
  // the operator to drive the screws, then carries on
  screws: { on: false, head: 0.375, clear: 0.125, depth: 0.25 },   // head dia, clearance from the head to any cut, hole depth (0 = through)
  sbpMaxTool: 30,                 // highest tool number ShopBot's C9 accepts
  sbpSpindleOn: 'C6',
  sbpSpindleOff: 'C7',
  sbpSetRpm: false,
};

// Hold-down in use: holdDown if set, else worked out from older settings
// (onion skin > 0 and / or the tabs checkbox).
export function holdDownOf(s) {
  if (['skin', 'tabs', 'both', 'none'].includes(s?.holdDown)) return s.holdDown;
  const skin = (s?.onionSkin || 0) > 0, tabs = !!s?.tabs?.on;
  return skin && tabs ? 'both' : skin ? 'skin' : tabs ? 'tabs' : 'none';
}
export const usesSkin = (s) => ['skin', 'both'].includes(holdDownOf(s));
export const usesTabs = (s) => ['tabs', 'both'].includes(holdDownOf(s));

// One nest per material + thickness.
export function groupParts(parts) {
  const groups = new Map();
  for (const p of parts) {
    const key = `${p.material} @ ${p.thickness.toFixed(3)}"`;
    if (!groups.has(key)) groups.set(key, { key, material: p.material, thickness: p.thickness, parts: [] });
    groups.get(key).parts.push(p);
  }
  return [...groups.values()];
}

export function mergeSettings(saved) {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return d;
  // settings saved before the hold-down choice: keep what they did
  if (saved.holdDown === undefined) saved = { ...saved, holdDown: holdDownOf({ onionSkin: 0.02, ...saved }) };
  // settings saved before the machine profile: their jog speeds (inches/second) become its top speeds
  if (saved.machine === undefined && (saved.jogXY || saved.jogZ)) saved = { ...saved, machine: { ...(saved.jogXY ? { maxXY: saved.jogXY * 60 } : {}), ...(saved.jogZ ? { maxZ: saved.jogZ * 60 } : {}) } };
  for (const k of Object.keys(d)) {
    if (saved[k] === undefined) continue;
    d[k] = typeof d[k] === 'object' && d[k] && !Array.isArray(d[k]) ? { ...d[k], ...saved[k] } : saved[k];
  }
  return d;
}
