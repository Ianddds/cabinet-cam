// Vectric-format post-processors (.pp files, as used by VCarve / Aspire /
// PartWorks). Parses a .pp and runs Cabinet CAM's moves through it.
//
// What's understood:
//   POST_NAME, FILE_EXTENSION, UNITS ("INCHES" / "MM"), LINE_NUMBER_START /
//   _INCREMENT / _MAXIMUM, SUBSTITUTE; other settings are ignored.
//   VAR <NAME> = [TAG|mode|prefix|format|multiplier]  mode A = always,
//     C = only when it changed; format "1.4" = at least 1 integer digit and
//     4 decimals ("+1.4" always shows the sign).
//   begin HEADER, FOOTER, TOOLCHANGE, NEW_SEGMENT, RAPID_MOVE, FIRST_RAPID_MOVE,
//     FEED_MOVE, FIRST_FEED_MOVE, PLUNGE_MOVE, FIRST_PLUNGE_MOVE, CW_ARC_MOVE,
//     CCW_ARC_MOVE, FIRST_CW_ARC_MOVE, FIRST_CCW_ARC_MOVE
//   plus one Cabinet CAM block: OPERATOR_STOP (screw hold-downs: stop for
//   the operator). A post without it uses its TOOLCHANGE block for the stop.
//
// How Cabinet CAM's moves map onto it:
//   - HEADER carries the first bit (it's already loaded: no tool change).
//   - Each later bit change: TOOLCHANGE.
//   - NEW_SEGMENT before each part / operation ([TOOLPATH_NAME] = its name),
//     and, in posts whose moves have no feed tag (ShopBot style MS,[FC],[FP]),
//     whenever the cut or plunge speed changes.
//   - Arcs are only fitted when the post has both arc blocks.
//   - Positions and feeds are converted for UNITS "MM".

const BLOCKS = ['HEADER', 'FOOTER', 'TOOLCHANGE', 'NEW_SEGMENT', 'RAPID_MOVE', 'FIRST_RAPID_MOVE', 'FEED_MOVE', 'FIRST_FEED_MOVE',
  'PLUNGE_MOVE', 'FIRST_PLUNGE_MOVE', 'CW_ARC_MOVE', 'CCW_ARC_MOVE', 'FIRST_CW_ARC_MOVE', 'FIRST_CCW_ARC_MOVE', 'OPERATOR_STOP'];
const BLOCK_ALIAS = { TOOL_CHANGE: 'TOOLCHANGE' };

// text tags that need no VAR line (Vectric built-ins, plus a few of ours)
const TEXT_TAGS = ['T', 'TOOLNAME', 'TOOLPATH_NAME', 'TOOLPATHS_OUTPUT', 'PATHNAME', 'FILENAME', 'FILE_NOTES', 'TOOLPATH_NOTES',
  'DATE', 'TIME', 'XY_ORIGIN', 'Z_ORIGIN', 'MESSAGE', 'SPINUP', 'MATERIAL', 'TOOLDIA'];

/**
 * Parse a .pp file. Returns { name, ext, units, vars: { TAG: { name, mode,
 * prefix, dec, int, sign, mult } }, blocks: { NAME: [lines] }, lineNo,
 * subst, warnings, usesToolNumber, feedInMoves, hasArcs }.
 */
export function parsePP(text) {
  const out = { name: '', ext: 'txt', units: 'INCHES', vars: {}, blocks: {}, lineNo: { start: 0, inc: 10, max: 999999 }, subst: [], warnings: [] };
  let block = null;
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k];
    const l = raw.trim();
    if (!l || l.startsWith('+')) continue;
    let m;
    if ((m = /^begin\s+(\w+)/i.exec(l))) {
      const nm = BLOCK_ALIAS[m[1].toUpperCase()] || m[1].toUpperCase();
      block = nm;
      if (!BLOCKS.includes(nm)) out.warnings.push(`block "${m[1]}" isn't used by Cabinet CAM (ignored)`);
      out.blocks[nm] = [];
      continue;
    }
    if ((m = /^VAR\s+(\w+)\s*=\s*\[(.*)\]\s*$/i.exec(l))) {
      const f = m[2].split('|');
      const tag = (f[0] || '').trim().toUpperCase();
      const fmt = /^([+]?)(\d*)(?:\.(\d*))?/.exec((f[3] || '1.4').trim());
      out.vars[tag] = { name: m[1].toUpperCase(), mode: (f[1] || 'A').trim().toUpperCase(), prefix: f[2] ?? '',
        sign: fmt[1] === '+', int: Number(fmt[2] || 1), dec: Number(fmt[3] || 0), mult: f[4] != null && f[4].trim() !== '' ? Number(f[4]) : 1 };
      block = null;
      continue;
    }
    if (block && l.startsWith('"')) {
      // a line of output: everything between the first and the last quote
      const a = raw.indexOf('"'), b = raw.lastIndexOf('"');
      out.blocks[block].push(b > a ? raw.slice(a + 1, b) : raw.slice(a + 1));
      continue;
    }
    if ((m = /^(\w+)\s*=\s*(.*)$/.exec(l))) {
      block = null;
      const key = m[1].toUpperCase();
      const val = m[2].trim().replace(/^"(.*)"$/, '$1');
      if (key === 'POST_NAME') out.name = val;
      else if (key === 'FILE_EXTENSION') out.ext = val.replace(/^\./, '') || 'txt';
      else if (key === 'UNITS') out.units = /MM|METRIC/i.test(val) ? 'MM' : 'INCHES';
      else if (key === 'LINE_NUMBER_START') out.lineNo.start = Number(val) || 0;
      else if (key === 'LINE_NUMBER_INCREMENT') out.lineNo.inc = Number(val) || 10;
      else if (key === 'LINE_NUMBER_MAXIMUM') out.lineNo.max = Number(val) || 999999;
      else if (key === 'SUBSTITUTE') out.subst = parseSubst(val);
      continue;
    }
    if (block) continue;   // stray text inside a block
  }
  if (!out.blocks.HEADER && !out.blocks.RAPID_MOVE) throw new Error('Not a Vectric post-processor (.pp): no HEADER or RAPID_MOVE block');
  for (const b of ['RAPID_MOVE', 'FEED_MOVE']) if (!out.blocks[b]) out.warnings.push(`no ${b} block`);
  const all = Object.values(out.blocks).flat().join('\n');
  out.usesToolNumber = /\[T\]/i.test(all);
  const moveText = ['FEED_MOVE', 'FIRST_FEED_MOVE', 'PLUNGE_MOVE', 'FIRST_PLUNGE_MOVE'].map((b) => (out.blocks[b] || []).join('\n')).join('\n');
  out.feedInMoves = Object.entries(out.vars).some(([tag, v]) => v.name === 'FEED_RATE' && new RegExp(`\\[${tag}\\]`, 'i').test(moveText));
  out.hasArcs = !!(out.blocks.CW_ARC_MOVE && out.blocks.CCW_ARC_MOVE);
  if (!out.name) out.name = 'Post';
  return out;
}

// SUBSTITUTE = "([91])[93]" : pairs of characters, a character or [code]
function parseSubst(s) {
  const toks = [];
  const re = /\[(\d+)\]|./g;
  let m;
  while ((m = re.exec(s))) toks.push(m[1] ? String.fromCharCode(Number(m[1])) : m[0]);
  const pairs = [];
  for (let i = 0; i + 1 < toks.length; i += 2) pairs.push([toks[i], toks[i + 1]]);
  return pairs;
}

/**
 * Run moves through a parsed post.
 * moves: Cabinet CAM toolpath moves (inches, Z relative to the material top).
 * cfg: { thickness, zZero, safeZ, park, tool, spinupSeconds, arcs }
 * meta: { title, material, fileName, sheetW, sheetH }
 * helpers: { fitArcs, zOut }
 * returns { text, warnings }
 */
export function runPP(pp, moves, cfg, meta = {}, helpers) {
  const warn = new Set();
  const S = pp.units === 'MM' ? 25.4 : 1;
  const zOut = helpers.zOut;
  const out = [];
  let lineNo = pp.lineNo.start;
  const last = {};                    // modal: last text printed per tag
  const st = {
    x: null, y: null, z: null, i: 0, j: 0, ia: 0, ja: 0,
    f: cfg.tool?.feed || 0, fc: cfg.tool?.feed || 0, fp: cfg.tool?.plunge || 0,
    tool: null, path: meta.title || '', message: '',
  };
  const safeZ = zOut(cfg.safeZ, cfg);
  const park = cfg.park || { x: 0, y: 0 };
  const now = new Date();
  // extents of the cut, for [XMIN] ... in headers
  let ex = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const m of moves) if (m.x != null) {
    const z = zOut(m.z, cfg);
    ex = { x0: Math.min(ex.x0, m.x), y0: Math.min(ex.y0, m.y), z0: Math.min(ex.z0, z), x1: Math.max(ex.x1, m.x), y1: Math.max(ex.y1, m.y), z1: Math.max(ex.z1, z) };
  }
  if (!Number.isFinite(ex.x0)) ex = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };

  const sub = (t) => pp.subst.reduce((s, [a, b]) => s.split(a).join(b), String(t ?? ''));
  const numberOf = (name) => {
    switch (name) {
      case 'X_POSITION': return st.x * S;
      case 'Y_POSITION': return st.y * S;
      case 'Z_POSITION': return st.z * S;
      case 'ARC_CENTRE_I_INC_POSITION': case 'ARC_CENTER_I_INC_POSITION': return st.i * S;
      case 'ARC_CENTRE_J_INC_POSITION': case 'ARC_CENTER_J_INC_POSITION': return st.j * S;
      case 'ARC_CENTRE_I_ABS_POSITION': case 'ARC_CENTER_I_ABS_POSITION': return st.ia * S;
      case 'ARC_CENTRE_J_ABS_POSITION': case 'ARC_CENTER_J_ABS_POSITION': return st.ja * S;
      case 'FEED_RATE': return st.f * S;
      case 'CUT_RATE': return st.fc * S;
      case 'PLUNGE_RATE': return st.fp * S;
      case 'SPINDLE_SPEED': return st.tool?.rpm ?? cfg.tool?.rpm ?? 0;
      case 'LINE_NUMBER': return lineNo;
      case 'TOOL_NUMBER': return st.tool?.num ?? '';
      case 'X_HOME_POSITION': return park.x * S;
      case 'Y_HOME_POSITION': return park.y * S;
      case 'Z_HOME_POSITION': case 'SAFE_Z_HEIGHT': case 'SAFE_Z': return safeZ * S;
      case 'X_MIN': return ex.x0 * S;
      case 'Y_MIN': return ex.y0 * S;
      case 'Z_MIN': return ex.z0 * S;
      case 'X_MAX': return ex.x1 * S;
      case 'Y_MAX': return ex.y1 * S;
      case 'Z_MAX': return ex.z1 * S;
      case 'X_LENGTH': return (meta.sheetW ?? ex.x1 - ex.x0) * S;
      case 'Y_LENGTH': return (meta.sheetH ?? ex.y1 - ex.y0) * S;
      case 'Z_LENGTH': return (cfg.thickness || 0) * S;
      case 'DWELL_TIME': return cfg.spinupSeconds ?? 3;
      default: return undefined;
    }
  };
  const textOf = (tag) => {
    switch (tag) {
      case 'T': return st.tool?.num != null ? String(st.tool.num) : '';
      case 'TOOLNAME': return sub(st.tool?.name || (st.tool ? `${st.tool.dia}in` : ''));
      case 'TOOLDIA': return st.tool ? String(Math.round(st.tool.dia * S * 10000) / 10000) : '';
      case 'TOOLPATH_NAME': case 'TOOLPATHS_OUTPUT': return sub(st.path);
      case 'PATHNAME': case 'FILENAME': return sub(meta.fileName || meta.title || '');
      case 'FILE_NOTES': case 'TOOLPATH_NOTES': return sub(meta.title || '');
      case 'MATERIAL': return sub(meta.material || '');
      case 'DATE': return now.toLocaleDateString();
      case 'TIME': return now.toLocaleTimeString();
      case 'XY_ORIGIN': return 'Bottom Left Corner';
      case 'Z_ORIGIN': return cfg.zZero === 'table' ? 'Table Surface' : 'Material Surface';
      case 'MESSAGE': return sub(st.message);
      case 'SPINUP': return String(cfg.spinupSeconds ?? 3);
      default: return undefined;
    }
  };
  const fmt = (v, d) => {
    if (typeof v !== 'number') return String(v);
    let s = Math.abs(v * d.mult).toFixed(d.dec);
    const [ip, fp] = s.split('.');
    s = ip.padStart(d.int, '0') + (fp != null ? '.' + fp : '');
    const neg = v * d.mult < 0 && Number(s) !== 0;
    return (neg ? '-' : d.sign ? '+' : '') + s;
  };
  // one output line with its tags filled in
  const fill = (line) => {
    let usedN = false;
    const res = line.replace(/(\s?)\[([A-Za-z_0-9]+)\]/g, (all, sp, tagRaw) => {
      const tag = tagRaw.toUpperCase();
      const d = pp.vars[tag];
      if (d) {
        const v = numberOf(d.name);
        if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) { warn.add(`[${tagRaw}] (${d.name}) has no value in Cabinet CAM - left blank`); return sp; }
        if (d.name === 'LINE_NUMBER') usedN = true;
        const s = d.prefix + fmt(v, d);
        if (d.mode === 'C') {
          if (last[tag] === s) return '';      // unchanged: left out, with its leading space
          last[tag] = s;
        }
        return sp + s;
      }
      const t = textOf(tag);
      if (t !== undefined) return sp + t;
      warn.add(`[${tagRaw}] isn't known to Cabinet CAM - left blank`);
      return sp;
    });
    if (usedN) { lineNo += pp.lineNo.inc; if (lineNo > pp.lineNo.max) lineNo = pp.lineNo.start; }
    return res;
  };
  const emit = (name, only) => { for (const l of pp.blocks[name] || []) if (!only || only(l)) out.push(fill(l)); };
  const resetModal = () => { for (const k of Object.keys(last)) delete last[k]; };
  const has = (b) => !!pp.blocks[b];
  // which axes a block writes (a FIRST_ block that leaves out an axis that
  // moves must not be used: the machine would stay where it is on that axis)
  const axisTags = { X: [], Y: [], Z: [] };
  for (const [tag, d] of Object.entries(pp.vars)) {
    if (d.name === 'X_POSITION') axisTags.X.push(tag);
    if (d.name === 'Y_POSITION') axisTags.Y.push(tag);
    if (d.name === 'Z_POSITION') axisTags.Z.push(tag);
  }
  const writes = (b, ax) => (pp.blocks[b] || []).some((l) => axisTags[ax].some((t) => new RegExp(`\\[${t}\\]`, 'i').test(l)));
  // speed lines of NEW_SEGMENT (MS,[FC],[FP]): repeated alone when only a speed changes
  const speedTags = Object.entries(pp.vars).filter(([, d]) => d.name === 'CUT_RATE' || d.name === 'PLUNGE_RATE' || d.name === 'FEED_RATE').map(([t]) => t);
  const isSpeedLine = (l) => speedTags.some((t) => new RegExp(`\\[${t}\\]`, 'i').test(l));

  // first bit: carried by the header
  const first = moves.find((m) => m.toolchange);
  st.tool = first?.tool || cfg.tool || null;
  if (st.tool) { st.fc = st.tool.feed || st.fc; st.fp = st.tool.plunge || st.fp; st.f = st.fc; }
  const useArcs = cfg.arcs !== false && pp.hasArcs && helpers.fitArcs;
  const list = useArcs ? helpers.fitArcs(moves) : moves;

  st.x = park.x; st.y = park.y; st.z = safeZ;
  emit('HEADER');
  resetModal();
  let firstBit = true, prevKind = null, pendingSeg = false, pendingSpeed = false, segFc = st.fc, segFp = st.fp, fresh = true;
  const newSegment = () => {
    if (!has('NEW_SEGMENT')) return;
    emit('NEW_SEGMENT');
    segFc = st.fc; segFp = st.fp;
    resetModal();
  };
  const toSafe = () => {
    if (st.x != null && st.z < safeZ - 1e-9) {
      st.z = safeZ;
      emit('RAPID_MOVE');
      prevKind = 'rapid';
    }
  };

  for (const m of list) {
    if (m.comment) { st.path = m.comment; pendingSeg = true; continue; }
    if (m.toolchange) {
      if (firstBit) { firstBit = false; continue; }   // already in the header
      toSafe();
      st.tool = m.tool;
      st.fc = m.tool.feed || st.fc; st.fp = m.tool.plunge || st.fp; st.f = st.fc;
      emit('TOOLCHANGE');
      resetModal();
      prevKind = null; pendingSeg = true; fresh = true;
      continue;
    }
    if (m.pause) {
      toSafe();
      st.message = m.note || 'Operator stop';
      if (has('OPERATOR_STOP')) emit('OPERATOR_STOP');
      else { warn.add('this post has no OPERATOR_STOP block: the screw stop uses its TOOLCHANGE block (same bit)'); emit('TOOLCHANGE'); }
      resetModal();
      prevKind = null; pendingSeg = true; fresh = true;
      continue;
    }
    if (m.x == null) continue;
    // speeds for this move
    if (m.g === 1) {
      st.f = m.f || st.f;
      if (m.plunge) st.fp = m.f || st.fp; else st.fc = m.f || st.fc;
    }
    // posts that only set speeds per segment (ShopBot MS,[FC],[FP]): when a
    // speed changes, repeat just the segment's speed lines
    if (m.g === 1 && !pp.feedInMoves && (st.fc !== segFc || st.fp !== segFp)) pendingSpeed = true;
    if (pendingSeg) { pendingSeg = false; pendingSpeed = false; newSegment(); }
    else if (pendingSpeed) {
      pendingSpeed = false;
      if (has('NEW_SEGMENT')) { emit('NEW_SEGMENT', isSpeedLine); segFc = st.fc; segFp = st.fp; }
    }
    const px = st.x, py = st.y, pz = st.z;
    st.x = m.x; st.y = m.y; st.z = zOut(m.z, cfg);
    let kind, block;
    if (m.g === 0) { kind = 'rapid'; block = 'RAPID_MOVE'; }
    else if (m.arc) {
      kind = m.cw ? 'cw' : 'ccw';
      st.i = m.i; st.j = m.j;                  // centre, from the arc's start
      st.ia = px + m.i; st.ja = py + m.j;      // centre, absolute
      block = m.cw ? 'CW_ARC_MOVE' : 'CCW_ARC_MOVE';
    } else if (m.plunge && has('PLUNGE_MOVE')) { kind = 'plunge'; block = 'PLUNGE_MOVE'; }
    else { kind = 'feed'; block = 'FEED_MOVE'; }
    // FIRST_ blocks: a rapid only as the first move after the header / a bit
    // change / a stop; feeds, plunges and arcs as the first of a run. Never
    // when it leaves out an axis that moves.
    const firstOk = kind === 'rapid' ? fresh : kind !== prevKind;
    if (firstOk && has('FIRST_' + block)) {
      const moved = { X: Math.abs(st.x - px) > 1e-9, Y: Math.abs(st.y - py) > 1e-9, Z: Math.abs(st.z - pz) > 1e-9 };
      if (['X', 'Y', 'Z'].every((ax) => !moved[ax] || writes('FIRST_' + block, ax))) block = 'FIRST_' + block;
    }
    emit(block);
    prevKind = kind;
    fresh = false;
  }
  toSafe();
  st.x = park.x; st.y = park.y;
  emit('FOOTER');
  return { text: out.join('\n') + '\n', warnings: [...warn] };
}
