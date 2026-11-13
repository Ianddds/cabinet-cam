// Tool library. Every bit — router or drill — has the same fields:
//   num        tool number (ShopBot &Tool / C9; 1-30)
//   dia        cutting diameter (in)
//   rpm        spindle speed
//   feed       cutting feed (ipm), used for profiles and pockets
//   entryFeed  plunge entry ipm: plunge feed for the first entryDepth below the surface
//   entryDepth plunge entry depth: how deep the slow part of the plunge goes (in)
//   drillFeed  plunge ipm after the entry (routing plunges and drilling)
//   stepdown   max depth per pass when routing (in)
//   stepover   fraction of the diameter between pocket rows (used as typed;
//              default 0.85, what pockets have always been cleared at)
//   peck       drilling: peck depth (in), 0 = one plunge
// The library lives on the server (data/tools.json); jobs store the tool ids
// they use plus a snapshot copy, so old jobs regenerate the same code.

export const DEFAULT_LIBRARY = [
  { id: 't-38comp', num: 1, type: 'router', name: '3/8 compression', dia: 0.375, rpm: 18000, feed: 240,
    entryFeed: 30, entryDepth: 0.06, drillFeed: 60, stepdown: 0.4, stepover: 0.85, peck: 0, notes: '' },
  { id: 't-14down', num: 2, type: 'router', name: '1/4 downcut', dia: 0.25, rpm: 18000, feed: 180,
    entryFeed: 25, entryDepth: 0.06, drillFeed: 45, stepdown: 0.25, stepover: 0.85, peck: 0, notes: '' },
  { id: 't-5mm', num: 3, type: 'drill', name: '5 mm drill', dia: 0.1969, rpm: 9000, feed: 60,
    entryFeed: 15, entryDepth: 0.06, drillFeed: 40, stepdown: 0.25, stepover: 0.85, peck: 0, notes: 'shelf pins' },
  { id: 't-6mm', num: 4, type: 'drill', name: '6 mm drill', dia: 0.2362, rpm: 9000, feed: 60,
    entryFeed: 15, entryDepth: 0.06, drillFeed: 40, stepdown: 0.25, stepover: 0.85, peck: 0, notes: 'Tandem hook holes' },
  { id: 't-14drill', num: 5, type: 'drill', name: '1/4 drill', dia: 0.25, rpm: 9000, feed: 60,
    entryFeed: 15, entryDepth: 0.06, drillFeed: 40, stepdown: 0.25, stepover: 0.85, peck: 0.25, notes: '' },
];

export const TOOL_FIELDS = [
  ['num', 'Tool #', 1], ['dia', 'Dia (in)', 0.001], ['rpm', 'RPM', 500], ['feed', 'Cut ipm', 5],
  ['entryFeed', 'Plunge entry ipm', 1], ['entryDepth', 'Plunge entry depth', 0.01], ['drillFeed', 'Plunge ipm (after entry)', 1],
  ['stepdown', 'Stepdown', 0.05], ['stepover', 'Stepover ×D', 0.05], ['peck', 'Peck (0 = off)', 0.05],
];

export function newTool(base = {}, library = []) {
  const id = `t-${Math.random().toString(36).slice(2, 8)}`;
  // next free tool number (a copy never keeps its original's number)
  const taken = new Set(library.map((t) => t.num));
  let num = 1; while (taken.has(num)) num++;
  return { ...DEFAULT_LIBRARY[0], notes: '', ...base, id, num };
}

// Pocket stepover as a fraction of the diameter: the typed value (kept between
// 0.05 and 1 so passes always overlap), 0.85 if none.
export const STEPOVER_DEFAULT = 0.85;
export function stepoverOf(t) {
  const s = +t?.stepover;
  return s > 0 ? Math.min(1, Math.max(0.05, s)) : STEPOVER_DEFAULT;
}

// Built-in bits' stepover before it was used as typed (0.85 was used whatever
// they said): a library still holding these is moved to 0.85 once.
export const OLD_DEFAULT_STEPOVER = { 't-38comp': 0.45, 't-14down': 0.4, 't-5mm': 0.5, 't-6mm': 0.5, 't-14drill': 0.5 };

// Library entry -> tool object the toolpath code uses (plunge = drillFeed).
function norm(t) {
  if (!t) return null;
  return {
    ...t,
    plunge: t.drillFeed || t.plunge || 30,
    entryFeed: t.entryFeed || t.drillFeed || 30,
    stepdown: t.stepdown > 0 ? t.stepdown : 0.25,
    stepover: stepoverOf(t),
    feed: t.feed > 0 ? t.feed : 60,
  };
}

// Pick the job's tools out of the library; fall back to the job's snapshot
// for tools that have since been deleted from the library.
export function resolveTools(settings, library, snapshot = []) {
  const notes = [];
  const find = (id) => {
    const t = library.find((x) => x.id === id);
    if (t) return t;
    const s = snapshot.find((x) => x.id === id);
    if (s) notes.push(`"${s.name}" is no longer in the library; using the copy saved with this job`);
    return s || null;
  };
  let tool = norm(find(settings.profileToolId));
  if (!tool) {
    tool = norm(library.find((t) => t.type === 'router') || library[0]);
    if (tool) notes.push(`Profile tool not found; using "${tool.name}"`);
  }
  const dadoSame = !settings.dadoToolId || settings.dadoToolId === 'same' || settings.dadoToolId === settings.profileToolId;
  const dadoTool = dadoSame ? tool : norm(find(settings.dadoToolId)) || tool;
  const drills = (settings.holeToolIds || []).map(find).filter(Boolean).map(norm);
  const used = [tool, dadoTool, ...drills].filter(Boolean);
  const snapshotOut = used.filter((t, i) => used.findIndex((u) => u.id === t.id) === i).map(({ plunge, ...t }) => t);
  return { tool, dadoTool, dadoSameTool: dadoSame || dadoTool === tool, drills, notes, snapshot: snapshotOut };
}
