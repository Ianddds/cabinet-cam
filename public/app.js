import { DEFAULT_SETTINGS, groupParts, mergeSettings, holdDownOf, usesSkin, usesTabs } from './lib/settings.js';
import { carve, check, shade } from './lib/sim.js';
import { nestParts, applySolution, nestKey, placedGeometry, partExits, rectMinus, compareKeep } from './lib/nest.js';
import { placeShapes, isShapePart, labelPoint, SHAPE_ORDERS } from './lib/shapes.js';
import { sheetToolpaths, sheetTabs, screwR, rectsOutline, screwCheck, offcutCutLines, tabOnPaths } from './lib/toolpath.js';
import { post, postWithWarnings, fileExtension, SBP_MAX_TOOL, toolNumberOk } from './lib/post.js';
import { parsePP } from './lib/vpp.js';
import { DEFAULT_LIBRARY, TOOL_FIELDS, newTool, resolveTools } from './lib/tools.js';
import { cutListRows, cutListCSV, fraction, roleName } from './lib/cutlist.js';
import { layoutsHTML } from './lib/printsheets.js';
import { constructionHTML } from './lib/construction.js';
import { moveRoom, turnTo, applyMoves, moveKey, copyAt, partKey, screwRoom } from './lib/moveparts.js';
import { sheetLabels, remnantLabel, toZPL, labelSVG, numberPlacements } from './lib/labels.js';
import { GRAIN_CHOICES, grainLabel, effectiveGrain, applyGrain, splitPart, carryOverrides, roleKey } from './lib/grain.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f3 = (v) => (+v).toFixed(3).replace(/\.?0+$/, '');

const SETTINGS_KEY = 'cabinet-cam-settings';
function loadSavedSettings() {
  try { return mergeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY))); } catch { return mergeSettings(null); }
}
function rememberSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(job.settings)); } catch {}
}

let job = { id: null, name: '', source: null, parts: [], settings: loadSavedSettings() };
let results = []; // [{ group, sheets: [{ sheet, tp, file, text }] , unplaced }]
// Parts, tools or settings changed since the sheets were made: they wait for
// Update sheets instead of re-nesting / re-planning every sheet on each change.
let stale = false;
function markStale() {
  if (!results.length) return;
  stale = true;
  showStale();
}
function showStale() {
  $('#staleBar').hidden = !stale;
  // files, layouts and labels from out-of-date sheets would be wrong
  const busy = results.some((r) => r.sheets.some((x) => x.replanning || x.replanError || !x.tp || x.tpStale));   // files need every sheet's toolpaths, up to date
  const todo = results.flatMap((r) => r.sheets).filter((x) => !x.tp || x.tpStale).length;
  $('#toolpathBtn').disabled = stale || !todo || !!results.pendingShapes;
  $('#toolpathBtn').title = stale ? 'Update the sheets first' : todo ? `Plan the toolpaths for ${todo} sheet${todo === 1 ? '' : 's'}` : results.length ? 'Every sheet has its toolpaths' : 'Nest first';   // a sheet's toolpaths are being redone
  const off = stale || busy || !!results.pendingShapes;
  for (const id of ['#saveFilesBtn', '#saveFilesMore']) $(id).disabled = off;
  $('#printMenuBtn').disabled = stale;   // layouts, labels and cut lists don't need toolpaths
  $('#markCut').disabled = (stale || busy || !!results.pendingShapes) && !job.cut;
}
let activeSheet = 0;
let moveEdit = false;   // sheet view: drag parts by hand (they snap to the nearest spot that fits)
let screwEdit = false;
let showPaths = true;   // sheet view: draw the toolpaths
let showSim = false;    // sheet view: Check cut (carve and check against the model)
let tabEdit = false;    // sheet view: click to add a tab, drag to move, right-click to remove  // sheet view: click to add a hold-down screw, drag to move, right-click to remove
let library = structuredClone(DEFAULT_LIBRARY);
let remnants = []; // shared inventory from the server

// ---------- api ----------
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function refreshStatus() {
  const el = $('#onshapeStatus');
  try {
    const s = await api('/api/status');
    if (s.connected) {
      el.innerHTML = `Onshape: connected (${s.authMode === 'apikey' ? 'API keys' : 'OAuth'}) · ${s.callsThisYear} API call${s.callsThisYear === 1 ? '' : 's'} this year` +
        (s.authMode === 'apikey' ? ' · <a href="#" data-keys>keys</a>' : '');
      el.className = 'status ok';
    }
    else if (s.authMode === 'oauth') { el.innerHTML = 'Onshape: <a href="/auth/onshape">sign in</a>'; el.className = 'status'; }
    else { el.innerHTML = 'Onshape: not connected — <a href="#" data-keys>enter API keys</a>'; el.className = 'status'; }
  } catch { el.textContent = 'Server offline'; }
}

// Onshape API keys dialog (saved on this computer, with the app's data)
$('#onshapeStatus').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-keys]')) return;
  e.preventDefault();
  const k = await api('/api/keys').catch(() => ({}));
  $('#keysNow').textContent = k.hasKeys ? `Keys are set (access key ending …${k.accessKeyEnd})${k.fromEnv ? ', from the .env file: change them there.' : '. Enter a new pair to replace them.'}` : 'No keys saved yet.';
  $('#keyAccess').value = ''; $('#keySecret').value = ''; $('#keysErr').textContent = '';
  $('#keysClear').hidden = !k.hasKeys || k.fromEnv;
  $('#keysSave').disabled = !!k.fromEnv;
  $('#keysDlg').showModal();
});
$('#keysSave').onclick = async () => {
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify({ accessKey: $('#keyAccess').value, secretKey: $('#keySecret').value }) });
    $('#keysDlg').close();
    refreshStatus();
  } catch (err) { $('#keysErr').textContent = err.message; }
};
$('#keysClear').onclick = async () => {
  if (!confirm('Remove the saved Onshape keys from this computer?')) return;
  await api('/api/keys', { method: 'DELETE' });
  $('#keysDlg').close();
  refreshStatus();
};

async function refreshJobs() {
  const sel = $('#openJob');
  const jobs = await api('/api/jobs').catch(() => []);
  sel.innerHTML = '<option value="">Open job…</option>' +
    jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.name || j.id)} · ${j.parts} lines</option>`).join('');
}

// ---------- messages ----------
function showMessages(list) {
  $('#messages').innerHTML = list.filter((m) => m.items?.length || m.text).map((m) =>
    `<div class="msg ${m.error ? 'error' : ''}">${esc(m.text || '')}${m.items?.length ? `<ul>${m.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}</div>`).join('');
}

// the desktop app's extras (electron/preload.cjs), and its per-PC choices
const desk = window.desktop || null;
const DESK_KEY = 'cabinetcam.desktop';
function deskPrefs() { try { return JSON.parse(localStorage.getItem(DESK_KEY) || '{}') || {}; } catch { return {}; } }
function setDeskPrefs(patch) { try { localStorage.setItem(DESK_KEY, JSON.stringify({ ...deskPrefs(), ...patch })); } catch { /* not kept */ } }

let lastRaw = null;
function setParts(data) {
  lastRaw = data.raw || null;
  $('#saveRaw').hidden = !lastRaw || !!desk;   // (the desktop app has it in the Help menu)
  delete data.raw;
  const sameSource = job.source?.url && data.source?.url === job.source.url;
  job.parts = sameSource ? carryOverrides(job.parts, data.parts) : data.parts;
  job.places = data.places || [];
  if (!sameSource) { job.nests = {}; job.manualScrews = {}; job.offCabinets = []; }
  if (job.cut) {
    // a cut job is a record of what was cut: new parts start a new job
    job = { ...job, id: null, cut: null, nests: {}, manualScrews: {}, name: job.name ? `${job.name} (2)` : '' };
    $('#jobName').value = job.name;
  }
  job.source = data.source;
  if (!job.name) {
    const codes = [...new Set(data.parts.flatMap((p) => (p.cabinet || '').split(', ')).filter(Boolean))].sort();
    const day = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    job.name = data.source?.documentName ||
      (codes.length ? `${codes.slice(0, 4).join(', ')}${codes.length > 4 ? ` +${codes.length - 4}` : ''} (${day})` : `Job ${day}`);
  }
  $('#jobName').value = job.name;
  results = [];
  $('#resultsCard').hidden = true;
  const src = data.source || {};
  $('#sourceInfo').textContent = [src.documentName, src.elementName, data.rawCount != null ? `${data.rawCount} bodies` : '', data.ms ? `${(data.ms / 1000).toFixed(1)}s` : ''].filter(Boolean).join(' · ');
  showMessages([
    { error: true, text: data.errors?.length ? 'Some bodies could not be read:' : '', items: data.errors },
    { text: data.notices?.length ? 'Onshape notices:' : '', items: data.notices },
    { text: data.untagged ? `${data.untagged} untagged bod${data.untagged === 1 ? 'y' : 'ies'} left unticked. Tag custom parts with "Tag cabinet part" in Onshape, or tick them here to cut anyway.` : '' },
  ]);
  renderParts();
  renderRemnants();
}

// ---------- cabinets in this run ----------
// job.offCabinets: cabinet codes left out of this run. Each copy of a merged
// part knows its cabinet (sourceCabinets), so only those copies drop out.
const NO_CAB = '(no cabinet)';
const cabOf = (c) => c || NO_CAB;
function jobCabinets() {
  const set = new Set();
  for (const p of job.parts) for (const c of p.sourceCabinets || [p.cabinet]) set.add(cabOf(c));
  return [...set].sort((a, b) => (a === NO_CAB) - (b === NO_CAB) || a.localeCompare(b, undefined, { numeric: true }));
}
function forRun(p) {
  const off = new Set(job.offCabinets || []);
  if (!off.size) return p;
  const cabs = (p.sourceCabinets?.length ? p.sourceCabinets : [p.cabinet]).map(cabOf);
  if (!cabs.some((c) => off.has(c))) return p;
  if (cabs.length === p.qty) {
    const keep = cabs.map((c, i) => (off.has(c) ? -1 : i)).filter((i) => i >= 0);
    const names = p.sourceNames || [];
    const srcCabs = p.sourceCabinets || [];
    return { ...p, qty: keep.length, sourceNames: keep.map((i) => names[i] ?? p.name), sourceCabinets: keep.map((i) => srcCabs[i] ?? p.cabinet),
      cabinet: [...new Set(keep.map((i) => srcCabs[i] ?? p.cabinet).filter(Boolean))].join(', ') };
  }
  // quantity changed by hand: can't tell copies apart, so drop it only if every cabinet is off
  return cabs.every((c) => off.has(c)) ? { ...p, qty: 0 } : p;
}
const runParts = () => job.parts.map(forRun);

function renderCabFilter() {
  const el = $('#cabFilter');
  const cabs = jobCabinets();
  if (cabs.length < 2) { el.innerHTML = ''; el.hidden = true; return; }
  const off = new Set(job.offCabinets || []);
  el.hidden = false;
  el.innerHTML = `<span class="muted small">Cabinets (${cabs.length - cabs.filter((c) => off.has(c)).length} of ${cabs.length}):</span>
    <button class="link mini" data-cab-all>All</button> <button class="link mini" data-cab-none>None</button>
    ${cabs.map((c) => `<label class="cab-chip${off.has(c) ? ' off' : ''}"><input type="checkbox" data-cab="${esc(c)}" ${off.has(c) ? '' : 'checked'}> ${esc(c)}</label>`).join('')}`;
}
function setOffCabinets(list) {
  job.offCabinets = list;
  renderParts();
  markStale();
}
$('#cabFilter').addEventListener('change', (e) => {
  const c = e.target.dataset.cab;
  if (c == null) return;
  const off = new Set(job.offCabinets || []);
  if (e.target.checked) off.delete(c); else off.add(c);
  setOffCabinets([...off]);
});
$('#cabFilter').addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-cab-all')) setOffCabinets([]);
  if (e.target.hasAttribute('data-cab-none')) setOffCabinets(jobCabinets());
});

// ---------- parts table ----------
// Grain cell: override select; "Auto" shows what the job rule / model gives.
function grainCell(p) {
  if (p.cnc === false) return '';
  const auto = effectiveGrain({ ...p, grainOverride: '' });
  const opts = [['', `Auto: ${grainLabel(auto)}`], ...GRAIN_CHOICES];
  return `<select data-k="grain" class="${p.grainOverride ? 'overridden' : ''}">${opts.map(([v, l]) =>
    `<option value="${v}" ${v === (p.grainOverride || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

function renderParts() {
  const wrap = $('#partsTable');
  if (!job.parts.length) {
    wrap.innerHTML = '<p class="muted empty">Paste a Part Studio URL and click Get parts, or <button class="link" data-sample>load the sample job</button>.</p>';
    $('#nestBtn').disabled = true;
    $('#partsSummary').textContent = '';
    renderCabFilter();
    return;
  }
  renderCabFilter();
  const groups = groupParts(job.parts);
  let rows = '';
  for (const g of groups) {
    const count = g.parts.filter((p) => p.include).reduce((a, p) => a + (forRun(p).qty || 0) + pendingOf(p), 0);
    const open = groupOpen(g);
    // tick for the whole material: all on, all off, or a dash when some are
    const on = g.parts.filter((p) => p.include).length;
    const gTick = `<input type="checkbox" data-ginc title="Tick or untick every part in ${esc(g.key)}" ${on === g.parts.length ? 'checked' : ''} ${on && on < g.parts.length ? 'data-mixed' : ''}>`;
    rows += `<tr class="group${open ? '' : ' shut'}" data-g="${esc(g.key)}" title="Click to ${open ? 'collapse' : 'expand'}"><td class="gtick">${gTick}</td><td colspan="9"><span class="caret">${open ? '▾' : '▸'}</span> ${esc(g.key)} — ${count} pcs${open ? '' : ` <span class="muted small">(${g.parts.length} line${g.parts.length === 1 ? '' : 's'} hidden)</span>`}</td></tr>`;
    if (!open) continue;
    for (const p of g.parts) {
      const i = job.parts.indexOf(p);
      const runQty = forRun(p).qty;
      const names = p.sourceNames?.length > 1 ? p.sourceNames.join('\n') : '';
      const warn = (p.cnc === false ? '<span class="badge cl" title="Not cut on the CNC — on the cut list">cut list</span> ' : '') +
        (p.untagged ? '<span class="badge" title="No cabinetPart tag">not tagged</span> ' : '') +
        (p.warnings?.length - (p.untagged ? 1 : 0) > 0 ? `<span class="badge" title="${esc(p.warnings.join('\n'))}">${p.warnings.length - (p.untagged ? 1 : 0)} warn</span>` : '');
      rows += `<tr class="${p.include && runQty > 0 ? '' : 'off'}" data-i="${i}">
        <td><input type="checkbox" data-k="include" ${p.include ? 'checked' : ''}></td>
        <td class="name-cell" title="${esc(names)}">${esc(p.name)}${p.sourceNames?.length > 1 ? ` <span class="muted">+${p.sourceNames.length - 1}</span>` : ''}${
          p.cnc !== false && p.qty > 1 && (p.sourceNames || []).length === p.qty ? ' <button class="link mini" data-split title="Split into one row per part, to change one of them">split</button>' : ''}</td>
        <td>${esc(p.cabinet)}</td>
        <td><input class="qty" type="number" min="0" step="1" data-k="qty" value="${effQty(p)}">${pendingOf(p) ? ` <span class="badge pend" title="Copied or deleted on the sheets: Nest &amp; toolpath nests the new count">${pendingOf(p) > 0 ? '+' : ''}${pendingOf(p)} on sheet</span>` : ''}${runQty !== p.qty ? ` <span class="muted small" title="Copies in the cabinets ticked above">→ ${runQty}</span>` : ''}</td>
        <td class="num">${f3(p.width)}</td><td class="num">${f3(p.height)}</td><td class="num">${f3(p.thickness)}</td>
        <td>${grainCell(p)}</td>
        <td class="num">${p.pockets.length || ''}${p.holes.length ? ` / ${p.holes.length} cut` : ''}</td>
        <td>${warn}</td>
      </tr>`;
    }
  }
  wrap.innerHTML = `<table><thead><tr><th></th><th>Part</th><th>Cab</th><th>Qty</th><th>Length</th><th>Width</th><th>Thk</th><th>Grain</th><th>Dados</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  for (const cb of wrap.querySelectorAll('input[data-ginc][data-mixed]')) cb.indeterminate = true;
  const total = runParts().filter((p) => p.include).reduce((a, p) => a + (p.qty || 0) + pendingOf(p), 0);
  $('#partsSummary').textContent = `${job.parts.length} unique · ${total} pcs · ${groups.length} material group${groups.length === 1 ? '' : 's'}`;
  $('#nestBtn').disabled = total === 0;
  $('#groupsToggle').hidden = groups.length < 2;
  $('#groupsToggle').textContent = groups.every(groupOpen) ? 'Collapse all' : 'Expand all';
  renderCutList();
}

// Material groups in the parts table fold up: click a group's row. Unassigned
// material starts folded (it's usually stray bodies); the rest start open.
// Remembered while the app is open.
const groupState = new Map();
function groupOpen(g) {
  return groupState.get(g.key) ?? !/^unassigned\b/i.test(g.material || g.key);
}
$('#groupsToggle').onclick = () => {
  const groups = groupParts(job.parts);
  const open = !groups.every(groupOpen);
  for (const g of groups) groupState.set(g.key, open);
  renderParts();
};

function cutListHtml(rows) {
  let html = '', mat = null;
  for (const r of rows) {
    if (r.material !== mat) {
      mat = r.material;
      const n = rows.filter((x) => x.material === mat).reduce((a, x) => a + x.qty, 0);
      html += `<tr class="group"><td colspan="7">${esc(mat)} — ${n} pcs</td></tr>`;
    }
    html += `<tr><td class="num">${r.qty}</td><td>${esc(r.part)}</td><td class="num">${fraction(r.length)}</td><td class="num">${fraction(r.width)}</td>
      <td class="num">${fraction(r.thickness)}</td><td>${esc(r.cabinets)}</td><td class="muted small">${f3(r.length)} × ${f3(r.width)} × ${f3(r.thickness)}</td></tr>`;
  }
  // headings aligned like their columns (numbers right), lines between columns
  return `<table class="cut-list"><thead><tr><th class="num">Qty</th><th>Part</th><th class="num">Length</th><th class="num">Width</th><th class="num">Thk</th><th>Cabinets</th><th>Decimal</th></tr></thead><tbody>${html}</tbody></table>`;
}

function renderCutList() {
  const rows = cutListRows(runParts().filter((p) => p.qty > 0));
  $('#cutListCard').hidden = !rows.length;
  if (!rows.length) return;
  const pcs = rows.reduce((a, r) => a + r.qty, 0);
  $('#cutListSummary').textContent = `${pcs} pcs · ${rows.length} line${rows.length === 1 ? '' : 's'}`;
  $('#cutListTable').innerHTML = cutListHtml(rows);
}

$('#partsTable').addEventListener('change', (e) => {
  // the material's tick: every part in it on or off
  if (e.target.hasAttribute('data-ginc')) {
    const g = groupParts(job.parts).find((x) => x.key === e.target.closest('tr.group').dataset.g);
    if (!g) return;
    commitPending();
    for (const p of g.parts) p.include = e.target.checked;
    renderParts();
    markStale();
    return;
  }
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const p = job.parts[+tr.dataset.i];
  const k = e.target.dataset.k;
  if (k === 'include') p.include = e.target.checked;
  // copies / deletes from the sheets become the counts first (the layout changes anyway)
  commitPending();
  if (k === 'qty') p.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  if (k === 'grain') p.grainOverride = e.target.value;
  renderParts();
  markStale();
});
$('#partsTable').addEventListener('click', (e) => {
  const gr = e.target.closest('tr.group[data-g]');
  if (gr && e.target.closest('td.gtick')) return;   // the material's tick, not a collapse
  if (gr) {
    const g = groupParts(job.parts).find((x) => x.key === gr.dataset.g);
    if (g) { groupState.set(g.key, !groupOpen(g)); renderParts(); }
    return;
  }
  if (!e.target.hasAttribute('data-split')) return;
  const i = +e.target.closest('tr[data-i]').dataset.i;
  job.parts.splice(i, 1, ...splitPart(job.parts[i]));
  renderParts();
});

// ---------- settings form ----------
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

const toolLabel = (t) => `${t.name} (${(+t.dia).toFixed(3)}")`;

function renderToolPickers() {
  const st = job.settings;
  const routers = library.filter((t) => t.type !== 'drill');
  const opt = (t, sel) => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(toolLabel(t))}</option>`;
  $('#profileToolSel').innerHTML = routers.map((t) => opt(t, st.profileToolId)).join('');
  $('#dadoToolSel').innerHTML = `<option value="same">Same as profile tool</option>` + routers.map((t) => opt(t, st.dadoToolId)).join('');
  $('#holeTools').innerHTML = library.map((t) => `<label><input type="checkbox" data-hole="${esc(t.id)}" ${st.holeToolIds.includes(t.id) ? 'checked' : ''}> ${esc(toolLabel(t))}</label>`).join('') ||
    '<span class="muted small">No tools in the library</span>';
}

function renderLibrary() {
  $('#libraryList').innerHTML = library.map((t, i) => `
    <div class="tool-card" data-t="${i}">
      <div class="tool-top">
        <input data-tk="name" value="${esc(t.name)}">
        <select data-tk="type"><option value="router" ${t.type !== 'drill' ? 'selected' : ''}>Router bit</option><option value="drill" ${t.type === 'drill' ? 'selected' : ''}>Drill</option></select>
      </div>
      <div class="grid3">
        ${TOOL_FIELDS.map(([k, label, step]) => `<label class="field">${label}<input type="number" step="${step}" data-tk="${k}" value="${t[k] ?? ''}"></label>`).join('')}
      </div>
      <input class="notes" data-tk="notes" placeholder="Notes" value="${esc(t.notes || '')}">
      <div class="tool-actions"><button class="link" data-act="dup">Duplicate</button><button class="link" data-act="del">Delete</button></div>
    </div>`).join('');
}

let saveTimer = null;
function saveLibrary() {
  $('#librarySaved').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/tools', { method: 'PUT', body: JSON.stringify(library) });
      $('#librarySaved').textContent = 'Saved';
    } catch (e) { $('#librarySaved').textContent = `Not saved: ${e.message}`; }
  }, 400);
  renderToolPickers();
  markStale();
}

$('#libraryList').addEventListener('change', (e) => {
  const card = e.target.closest('[data-t]');
  const k = e.target.dataset.tk;
  if (!card || !k) return;
  const t = library[+card.dataset.t];
  t[k] = e.target.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value;
  saveLibrary();
});
$('#libraryList').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  const card = e.target.closest('[data-t]');
  if (!act || !card) return;
  const i = +card.dataset.t;
  if (act === 'dup') library.splice(i + 1, 0, newTool({ ...library[i], name: `${library[i].name} copy` }, library));
  if (act === 'del') {
    const t = library[i];
    if (!confirm(`Delete "${t.name}" from the library?`)) return;
    library.splice(i, 1);
  }
  renderLibrary();
  saveLibrary();
});
$('#addTool').onclick = () => { library.push(newTool({ name: 'New tool' }, library)); renderLibrary(); saveLibrary(); };
$('#openLibrary').onclick = () => { renderLibrary(); $('#libraryCard').hidden = false; $('#libraryCard').scrollIntoView({ behavior: 'smooth' }); };
$('#closeLibrary').onclick = () => { $('#libraryCard').hidden = true; };

$('#holeTools').addEventListener('change', (e) => {
  const id = e.target.dataset.hole;
  if (!id) return;
  const ids = new Set(job.settings.holeToolIds);
  if (e.target.checked) ids.add(id); else ids.delete(id);
  job.settings.holeToolIds = library.map((t) => t.id).filter((x) => ids.has(x));
  rememberSettings();
  markStale();
});

function renderSettings() {
  renderToolPickers();
  for (const el of document.querySelectorAll('[data-path]')) {
    const v = getPath(job.settings, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  $('#sbpOpts').hidden = job.settings.post !== 'sbp';
  renderPostInfo();
  $('#screwF').hidden = !job.settings.screws?.on;
  $('#spacingF').hidden = !!job.settings.commonLine;
  $('#lblHostF').hidden = job.settings.labels?.mode !== 'network';
  $('#lblShareF').hidden = job.settings.labels?.mode !== 'share';
  $('#tabOpts').hidden = !usesTabs(job.settings);
  $('#skinF').hidden = !usesSkin(job.settings);
}

// Settings tab (top bar): the Machine card in a panel under it
{
  const tab = $('#settingsTab'), panel = $('#settingsPanel');
  const show = (on) => { panel.hidden = !on; tab.setAttribute('aria-expanded', on ? 'true' : 'false'); };
  tab.onclick = (e) => { e.stopPropagation(); show(panel.hidden); };
  $('#settingsClose').onclick = () => show(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) show(false); });
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== tab) show(false); });
  // the left column and the panel sit just under the top bar, whatever its height
  const topbarH = () => document.documentElement.style.setProperty('--topbar-h', `${document.querySelector('.topbar').offsetHeight}px`);
  topbarH();
  window.addEventListener('resize', topbarH);
}

const onSettingChange = (e) => {
  const el = e.target;
  if (!el.dataset.path) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') v = parseFloat(v);
  if (el.type === 'number' && Number.isNaN(v) && el.dataset.blank === 'null') v = null; // blank = use the default it names
  if (el.dataset.path === 'climb') v = v === 'true';
  setPath(job.settings, el.dataset.path, v);
  rememberSettings();
  renderSettings();
  markStale(); // the sheets wait for Update sheets (re-planning a big job on every change lags)
};
document.querySelector('.side').addEventListener('change', onSettingChange);
$('#settingsPanel').addEventListener('change', onSettingChange);

// label settings only change the labels
$('#labelsPanel').addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.path) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number' || el.dataset.path === 'labels.dpi') v = parseFloat(v);
  setPath(job.settings, el.dataset.path, v);
  rememberSettings();
  renderSettings();
  renderLabels();
});


function settingsProblems(s, tl) {
  const out = [...tl.notes];
  const dado = tl.dadoTool;
  if (!tl.tool) return ['No profile tool: add one to the tool library'];
  if (!s.commonLine && s.sheet.spacing < tl.tool.dia) out.push(`Part spacing (${s.sheet.spacing}) is less than the profile tool diameter (${tl.tool.dia}); neighbouring cuts will overlap.`);
  if (!s.commonLine && s.sheet.spacing < dado.dia + 0.05) out.push(`Part spacing (${s.sheet.spacing}) is less than the dado bit plus 0.05": open-ended dados can't run half the bit past the edge without reaching the next part.`);
  if (usesSkin(s) && !(s.onionSkin >= 0.01)) out.push('Onion skin under 0.01" usually tears through (0 = no skin pass; pick Tabs or Nothing instead).');
  if (holdDownOf(s) === 'both' && s.tabs.thickness <= s.onionSkin) out.push('Tab thickness is not more than the onion skin, so the tabs add no hold.');
  if (holdDownOf(s) === 'none') out.push('Nothing holds the parts on the last pass: small parts can move or be thrown. Use tabs unless the sheet is on vacuum.');
  for (const t of [tl.tool, dado, ...tl.drills]) {
    if (!(t.dia > 0 && t.feed > 0 && t.entryFeed > 0 && t.drillFeed > 0 && t.stepdown > 0 && t.entryDepth >= 0)) {
      out.push(`Tool "${t.name}" needs diameter, cut, entry and plunge ipm and stepdown above zero.`);
    }
  }
  // tool numbers: the built-in ShopBot post, and post files that write [T]
  if (s.post === 'sbp' || postPP(s)?.usesToolNumber) {
    const max = s.post === 'sbp' ? s.sbpMaxTool || SBP_MAX_TOOL : 999;
    const used = [tl.tool, dado, ...tl.drills].filter((t, i, a) => t && a.findIndex((u) => u.id === t.id) === i);
    for (const t of used) {
      if (!toolNumberOk(t, max)) out.push(s.post === 'sbp'
        ? `Tool "${t.name}" needs a tool # from 1 to ${max} (tool library). Without one, a change to it stops with PAUSE instead of C9 and the operator has to zero Z by hand.`
        : `Tool "${t.name}" needs a tool # (tool library): the post writes it as [T], and it would come out blank.`);
    }
    const seen = new Map();
    for (const t of used) {
      if (!toolNumberOk(t, max)) continue;
      if (seen.has(t.num)) out.push(`Tools "${seen.get(t.num)}" and "${t.name}" are both tool #${t.num}; C9 can't tell them apart.`);
      else seen.set(t.num, t.name);
    }
  }
  return out;
}

// ---------- nesting ----------
// Each material group's nest is searched in a background worker (all groups side
// by side) and the winning layout is kept in job.nests, keyed by what it depends
// on (parts, sizes, grain, sheet). Saved jobs bring their layouts back exactly.
// Settings that only change toolpaths reuse the kept layout; if the nest inputs
// changed, a quick nest is shown until Nest is clicked again.
let searching = null;

// remnants that can take this group's parts (same material name and thickness)
const remnantsFor = (g) => (job.settings.remnants?.use === false ? [] : remnants.filter((r) =>
  r.status === 'available' && r.material === g.material && Math.abs(r.thickness - g.thickness) < 0.004))
  .map((r) => ({ id: r.id, no: r.no, w: r.w, h: r.h, ...(r.rects?.length > 1 ? { rects: r.rects } : {}) }));
const stockSig = (list) => (list || []).map((r) => r.id).sort().join(',');

function nestGroups() {
  const s = job.settings;
  const rs = s.remnants || {};
  const base = { ...s.sheet, respectGrain: s.respectGrain, shapeStep: s.shapeStep ?? 15, shapeFlip: s.shapeFlip !== false, shapeSpacing: s.sheet.spacing, remnantTrim: rs.trim ?? 0.25, remnantMin: { side: rs.minSide ?? 8, area: rs.minArea ?? 288 } };
  // shared cut lines: parts sit exactly the profile bit apart, so facing edges are one cut
  if (s.commonLine) { base.spacing = resolveTools(s, library, job.toolSnapshot || []).tool.dia; base.commonLine = true; }
  // screw hold-downs: one near each corner of the parts' area and one at its centre
  if (s.screws?.on) base.screws = { R: screwR(s.screws) };
  return groupParts(applyGrain(runParts().filter((p) => p.include && p.qty > 0))).map((g) => {
    const key = nestKey(g.parts, base) + `|rt${base.remnantTrim}`;
    const kept = job.nests?.[key];
    // a job marked as cut keeps the stock it was nested on; otherwise use what's on the rack now
    const stock = job.cut && kept?.stock ? kept.stock : remnantsFor(g);
    return { g, key, nestOpts: { ...base, remnants: stock }, stock };
  });
}

// Custom shapes fitted by outline into a nest. The fitting runs in a worker
// (shape-worker.js) so the window never freezes; until it's back the sheets
// show without them (downloads held). Where each shape went is kept per layout,
// and the sheets are laid out again from that, which is quick.
const shapeMemo = new Map();      // layout key -> { spots } | { error }
const shapePending = new Set();   // layout keys being fitted now
let shapeJob = 0;
function shapesFor(nest, g, nestOpts) {
  const shapes = g.parts.filter((p) => p.include && p.qty > 0 && isShapePart(p, nestOpts));
  if (!shapes.length) return { nest, pending: 0 };
  const key = JSON.stringify([
    nest.sheets.map((s) => [s.w, s.h, s.placements.map((pl) => [pl.part.id ?? pl.part.name, +pl.x.toFixed(3), +pl.y.toFixed(3), pl.rotated ? 1 : 0]), (s.screws || []).map((q) => [+q.x.toFixed(2), +q.y.toFixed(2)])]),
    shapes.map((p) => [p.id, p.name, p.qty, p.grain, p.width, p.height, p.pockets.length, strHash(JSON.stringify(p.outline))]),
    nestOpts.shapeStep, nestOpts.shapeFlip, nestOpts.shapeSpacing, nestOpts.respectGrain, nestOpts.spacing, nestOpts.sheetW, nestOpts.sheetH, nestOpts.trim, nestOpts.endTrim, nestOpts.screws, nestOpts.commonLine]);
  const hit = shapeMemo.get(key);
  if (hit?.spots) return { nest: placeShapes(nest, g.parts, nestOpts, hit.spots), pending: 0 };
  if (hit?.error) return { nest: { ...nest, unplaced: [...(nest.unplaced || []), ...shapes.map((p) => ({ name: p.name, reason: `custom shape fitting failed (${hit.error})` }))] }, pending: 0 };
  if (!shapePending.has(key)) {
    shapePending.add(key);
    // what the worker needs: the sheets as they are, and the shapes
    const slimNest = { unplaced: [], sheets: nest.sheets.map((s) => ({ w: s.w, h: s.h, trim: s.trim, trimX: s.trimX, remnant: s.remnant ? { rects: s.remnant.rects } : null, screws: s.screws || [], offcuts: [], placements: s.placements.map((pl) => ({ x: pl.x, y: pl.y, rotated: pl.rotated, part: { width: pl.part.width, height: pl.part.height } })) })) };
    const slimShapes = shapes.map((p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, qty: p.qty, include: true, grain: p.grain, custom: true, shape: true, outline: p.outline, pockets: p.pockets.map(() => 0) }));
    // the part orders tried are shared out over the cores; the best wins (ties to the
    // lower order), so it's the same layout one worker trying them all would find
    const n = Math.max(1, Math.min(SHAPE_ORDERS, CORES));
    const shares = Array.from({ length: n }, (_, w) => Array.from({ length: SHAPE_ORDERS }, (_, k) => k).filter((k) => k % n === w));
    const id = ++shapeJob;
    const doneTries = shares.map(() => 0);
    const answers = [];
    const workers = shares.map((passes, w) => {
      const wk = new Worker(new URL('./lib/shape-worker.js', import.meta.url), { type: 'module' });
      wk.onmessage = (e) => {
        if (e.data?.id !== id) return;
        if (e.data.progress) {
          doneTries[w] = e.data.progress.pass - 1;
          const m = [...document.querySelectorAll('#messages .msg')].find((x) => /Fitting \d+ custom shape/.test(x.textContent));
          const tries = doneTries.reduce((a, v) => a + v, 0);
          if (m) m.textContent = m.textContent.replace(/ \((try|tries)[^)]*\)|$/, ` (tries done: ${tries} of ${SHAPE_ORDERS}, ${n} at once)`).replace(/\) \((try|tries)/, ') ($1');
          return;
        }
        wk.terminate();
        answers[w] = e.data;
        doneTries[w] = passes.length;
        if (answers.filter(Boolean).length < n) return;
        shapePending.delete(key);
        const err = answers.find((a) => a.error);
        const good = answers.filter((a) => a.spots);
        const better = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-6) return true; if (a[i] > b[i] + 1e-6) return false; } return false; };
        const win = good.reduce((b, a) => (!b || better(a.spots.cost, b.spots.cost) || (!better(b.spots.cost, a.spots.cost) && a.spots.pass < b.spots.pass) ? a : b), null);
        shapeMemo.set(key, win ? { spots: win.spots } : { error: err?.error || 'no answer' });
        if (shapeMemo.size > 40) shapeMemo.delete(shapeMemo.keys().next().value);
        if (results.length || nestActive) runNest();   // lay the sheets out again, now with the shapes (and any changes waiting)
      };
      wk.onerror = (e) => { wk.onmessage({ data: { id, error: e.message || 'shape worker failed' } }); };
      return { wk, passes };
    });
    for (const { wk, passes } of workers) wk.postMessage({ id, nest: slimNest, parts: slimShapes, opts: { ...nestOpts, passes } });
  }
  return { nest, pending: shapes.reduce((a, p) => a + p.qty, 0) };
}

// what a worker needs of a part
const slimPart = (p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, qty: p.qty, include: p.include, grain: p.grain, exits: partExits(p), shape: isShapePart(p, { shapeStep: job.settings.shapeStep ?? 15 }) });

// cores to search on (one is left for the page)
const CORES = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 2) - 1));

function searchGroup({ g, nestOpts }, seed, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./lib/nest-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.progress) { onProgress(e.data.progress); return; }
      w.terminate();
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'nest worker failed')); };
    w.postMessage({ parts: g.parts.map(slimPart), opts: { ...nestOpts, searchMs: Math.max(0, (job.settings.nestSeconds ?? 6) * 1000), seed } });
  });
}

// fewer full sheets, then the bigger offcut on the last sheet
const nestBetter = (a, b) => a.fullSheets !== b.fullSheets ? a.fullSheets < b.fullSheets
  : (a.sheets.at(-1)?.offcut ? a.sheets.at(-1).offcut.w * a.sheets.at(-1).offcut.h : 0) >
    (b.sheets.at(-1)?.offcut ? b.sheets.at(-1).offcut.w * b.sheets.at(-1).offcut.h : 0) + 1e-6;

async function searchNests(force = false) {
  if (searching) return;
  // parts copied or deleted on the sheets: their new counts are nested now
  if (!job.cut && commitPending()) { moveMsg = ''; renderParts(); }
  const groups = nestGroups();
  job.nests = job.nests || {};
  if (job.cut) { showMessages([{ text: 'This job is marked as cut, so its layout is fixed. Undo "cut" to nest it again.' }]); await runNest(); return; }
  // search what has never been searched, or whose remnants on the rack changed
  const todo = groups.filter((x) => force || !job.nests[x.key]?.searched || stockSig(job.nests[x.key].stock) !== stockSig(x.stock));
  if (!todo.length) { await runNest(); return; }
  const btns = [$('#nestBtn'), $('#searchAgain')];
  btns.forEach((b) => { b.disabled = true; });
  const t0 = Date.now();
  const best = {};
  const budget = Math.max(1, (job.settings.nestSeconds ?? 6) * 1000);
  busyPop.start(`Nesting ${todo.length} material${todo.length === 1 ? '' : 's'}…`, 'Trying layouts');
  const status = () => {
    const sheets = todo.map((x) => best[x.key]).filter((v) => v != null);
    const secs = Math.round((Date.now() - t0) / 1000);
    $('#nestBtn').textContent = `Nesting… ${secs}s` + (sheets.length ? ` · ${sheets.reduce((a, v) => a + v, 0)} full sheets` : '');
    // the search runs for its time budget; past that it's finishing up
    busyPop.set(Math.min(0.97, (Date.now() - t0) / budget), `${secs}s · trying layouts` + (sheets.length ? ` · best so far ${sheets.reduce((a, v) => a + v, 0)} full sheet${sheets.reduce((a, v) => a + v, 0) === 1 ? '' : 's'}` : ''));
  };
  const timer = setInterval(status, 250);
  // every core: each material gets its share of searches side by side (different
  // seeds), and the best of them is kept; one core is left for the page
  const perGroup = Math.max(1, Math.floor(CORES / todo.length));
  const base = force ? (Date.now() & 0xffff) + 1 : 12345;
  const searchAll = (x) => Promise.all(Array.from({ length: perGroup }, (_, i) =>
    searchGroup(x, base + i * 7919, (p) => { best[x.key] = Math.min(best[x.key] ?? Infinity, p.sheets); })))
    .then((rs) => rs.reduce((b, r) => (!b || (r.stats?.keep && b.stats?.keep && compareKeep(r.stats.keep, b.stats.keep) < 0) ? r : b), null));
  searching = Promise.all(todo.map((x) => searchAll(x)
    .then((r) => {
      const fresh = applySolution(x.g.parts, x.nestOpts, r.solution);
      const prev = job.nests[x.key];
      const old = prev && stockSig(prev.stock) === stockSig(x.stock) && applySolution(x.g.parts, x.nestOpts, prev.solution);
      if (fresh && (!old || nestBetter(fresh, old) || !prev.searched)) {
        job.nests[x.key] = { solution: r.solution, searched: true, tries: r.stats.tries, stock: x.stock };
      }
    })));
  try { await searching; } catch (e) { showMessages([{ error: true, text: `Nest search failed: ${e.message}` }]); }
  finally {
    clearInterval(timer);
    searching = null;
    $('#nestBtn').textContent = 'Nest';
    btns.forEach((b) => { b.disabled = false; });
  }
  await runNest();
}

// The busy popup: a title, a bar (a fraction, or null = still working, no
// estimate) and a note. Shown a moment after start so quick jobs don't flash it.
const busyPop = (() => {
  let t = null;
  let on = false;
  return {
    start(title, note) {
      $('#busyTitle').textContent = title;
      busyPop.set(null, note || '');
      if (on) return;
      on = true;
      clearTimeout(t);
      t = setTimeout(() => { if (on) $('#busy').hidden = false; }, 250);
    },
    set(frac, note) {
      const f = $('#busyFill');
      f.classList.toggle('indet', frac == null);
      f.style.width = frac == null ? '' : `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
      if (note != null) $('#busyNote').textContent = note;
    },
    stop() { on = false; clearTimeout(t); $('#busy').hidden = true; },
  };
})();

// Every sheet's toolpaths, worked out in workers (toolpath-worker.js) on all
// cores, reporting each sheet as it's done. A sheet a worker can't do is planned
// here instead. jobs: [{ sheet, cfg, checkScrews }] -> [{ tp, chk } | { error }]
async function planSheets(jobs, onDone) {
  const out = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const here = (k) => {
    try {
      const tp = sheetToolpaths(jobs[k].sheet, jobs[k].cfg);
      return { tp, chk: jobs[k].checkScrews ? screwCheck(jobs[k].sheet, tp.moves, jobs[k].cfg) : [] };
    } catch (err) { return { error: String(err?.message || err) }; }
  };
  const lane = async () => {
    let w = null;
    try { w = new Worker(new URL('./lib/toolpath-worker.js', import.meta.url), { type: 'module' }); } catch { w = null; }
    while (next < jobs.length) {
      const k = next++;
      let r = null;
      if (w) {
        r = await new Promise((resolve) => {
          w.onmessage = (e) => resolve(e.data);
          w.onerror = (e) => { e.preventDefault?.(); resolve({ error: e.message || 'worker failed', dead: true }); };
          try { w.postMessage({ id: k, sheet: jobs[k].sheet, cfg: jobs[k].cfg, checkScrews: jobs[k].checkScrews }); } catch (err) { resolve({ error: String(err?.message || err) }); }
        });
        if (r.dead) { w.terminate(); w = null; }
      }
      if (!r || r.error) {
        if (r?.error) console.warn('toolpath worker:', r.error);
        await new Promise((res) => setTimeout(res, 0));   // let the popup paint first
        r = here(k);
      }
      out[k] = r;
      done += 1;
      onDone?.(done, jobs.length);
    }
    w?.terminate();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs.length, CORES)) }, lane));
  return out;
}

// Toolpath: plan every sheet that has no toolpaths yet (after Nest, or a hand
// edit dropped them), in workers, with the popup. The nest's notes and every
// sheet's toolpath warnings are shown together afterwards.
let planning = false;
async function planAll() {
  if (planning || !results.length) return;
  const items = results.flatMap((r) => r.sheets).filter((x) => !x.tp || x.tpStale);
  if (!items.length) return;
  planning = true;
  busyPop.start('Planning toolpaths…', `0 of ${items.length} sheets`);
  const was = results;
  try {
    const planned = await planSheets(items.map((item) => ({ sheet: item.sheet, cfg: item.cfg, checkScrews: screwsShown(item.cfg, item.sheet) })),
      (n, of) => busyPop.set(n / of, `${n} of ${of} sheets`));
    if (results !== was) return;   // re-nested meanwhile
    const failed = [], bad = [];
    items.forEach((item, k) => {
      const r = planned[k];
      if (r.error) { failed.push(`${item.label || item.title}: ${r.error}`); return; }
      item.tp = r.tp;
      item.tpStale = false;
      item.screwChk = r.chk;
      item.text = null;
      item.screwText = null;
      item.sim = null;
      item.replanError = null;
      nameFiles(item);
      const n = r.chk.filter((c) => !c.ok).length;
      if (n) bad.push(`${item.label || item.title}: ${n} hold-down screw${n === 1 ? ' is' : 's are'} in a bad spot (red) — move ${n === 1 ? 'it' : 'them'} before cutting`);
    });
    const all = results.flatMap((r) => r.sheets);
    const warnings = [...(results.nestNotes || []), ...bad, ...new Set(all.filter((x) => x.tp).flatMap((x) => x.tp.warnings))];
    const unplaced = results.flatMap((r) => r.unplaced.map((u) => `${u.name}: ${u.reason}`));
    showMessages([
      { error: true, text: failed.length ? 'Toolpaths could not be planned for:' : '', items: failed },
      { error: true, text: unplaced.length ? 'Not placed:' : '', items: unplaced },
      { text: warnings.length ? 'Check before cutting:' : '', items: warnings },
    ]);
    renderResults();
  } finally {
    planning = false;
    busyPop.stop();
  }
}
// Hand edits wait for Toolpath. A moved, pasted or deleted part drops the
// sheet's toolpaths (they no longer fit the layout); a screw or tab edit keeps
// them on show, marked out of date (tabs need the bit's path to snap to).
// The sheet's tabs and the bit's paths they sit on: from its toolpaths, or,
// before Toolpath, worked out from the layout alone (the same tabs the toolpath
// will cut), so they show and can be placed straight after Nest.
function tabsView(item) {
  if (item.tp) return { tabs: item.tp.tabs || [], tabPaths: item.tp.tabPaths || [] };
  if (!item.cfg || !item.sheet) return null;
  if (!item.tabView || item.tabViewCfg !== item.cfg || item.tabViewSheet !== item.sheet) {
    try { item.tabView = sheetTabs(item.sheet, item.cfg); }
    catch (err) { console.warn('tab preview failed', err); item.tabView = { tabs: [], tabPaths: [] }; }
    item.tabViewCfg = item.cfg;
    item.tabViewSheet = item.sheet;
  }
  return item.tabView;
}

function dropToolpaths(item) {
  item.tabView = null;   // the layout changed: work the tabs out again
  item.replanId = (item.replanId || 0) + 1;   // any plan still on its way is stale
  item.replanning = false;
  item.tp = null;
  item.tpStale = false;
  item.screwChk = [];
  item.text = null;
  item.screwText = null;
  item.sim = null;
  item.replanError = null;
  renderResults();
}

function markEdited(item) {
  item.replanId = (item.replanId || 0) + 1;
  item.replanning = false;
  item.tpStale = !!item.tp;
  item.text = null;
  item.screwText = null;
  item.sim = null;
  item.replanError = null;
  // the screw check against the toolpaths there are (the layout hasn't changed)
  item.screwChk = item.tp && screwsShown(item.cfg, item.sheet) ? screwCheck(item.sheet, item.tp.moves, item.cfg) : [];
  renderResults();
}

let nestRun = 0;
let nestActive = 0;   // runs under way (the sheets aren't in results till one finishes)
async function runNest() {
  const run = ++nestRun;
  nestActive += 1;
  busyPop.start('Planning toolpaths…');
  try { await runNestNow(run); } finally { nestActive -= 1; if (run === nestRun) busyPop.stop(); }
}
async function runNestNow(run) {
  const s = job.settings;
  const tl = resolveTools(s, library, job.toolSnapshot || []);
  const problems = settingsProblems(s, tl);
  if (problems.some((p) => p.includes('above zero') || p.startsWith('No profile tool'))) { showMessages([{ error: true, text: 'Fix tools:', items: problems }]); return; }
  const res = [];   // becomes results once every sheet is planned (the old ones show till then)
  const toPlan = [];
  if (String(s.post).startsWith('pp:') && !postPP(s)) { showMessages([{ error: true, text: `The post file "${s.post.slice(3)}" isn't in the posts folder any more — pick another post (Machine card).` }]); return; }
  const ext = fileExtension({ ...s, pp: postPP(s) });
  const stamp = (job.name || 'job').replace(/[^\w-]+/g, '_').slice(0, 40);
  let quick = false;
  let pendingShapes = 0;
  const stockNotes = [];
  for (const { g, nestOpts, key, stock } of nestGroups()) {
    const kept = job.nests?.[key];
    let nest = null;
    if (kept) {
      nest = applySolution(g.parts, { ...nestOpts, remnants: kept.stock || [] }, kept.solution);
      // remnants it was nested on that have gone since (used by another job, deleted)
      const gone = job.cut ? [] : (kept.stock || []).filter((r) => !stock.some((x) => x.id === r.id));
      const usedGone = nest && gone.filter((r) => nest.sheets.some((sh) => sh.remnant?.id === r.id));
      if (usedGone?.length) { stockNotes.push(`${g.key}: remnant ${usedGone.map((r) => 'R' + r.no).join(', ')} is no longer on the rack — click Nest to re-nest`); }
      else if (nest && stockSig(kept.stock) !== stockSig(stock) && !job.cut) stockNotes.push(`${g.key}: the remnants on the rack changed — Nest will look at them`);
    }
    if (!nest) { nest = nestParts(g.parts, nestOpts); quick = true; }
    const sf = shapesFor(nest, g, nestOpts);
    nest = sf.nest;
    pendingShapes += sf.pending;
    const cfg = { ...s, ...tl, thickness: g.thickness, ...(postPP(s) ? { pp: postPP(s) } : {}) };
    const mat = g.material.replace(/[^\w-]+/g, '_');
    const mkey = manualKey(key, kept);
    const sheets = nest.sheets.map((sheet, i) => {
      applyMoves(sheet, job.manualMoves?.[mkey]?.[i], { gap: cfg.commonLine ? cfg.tool.dia : cfg.sheet.spacing, remnantMin: nestOpts.remnantMin, edits: job.layoutEdits?.[mkey]?.[i], partOf: (k) => g.parts.find((p) => partKey(p) === k) });
      applyManualScrews(sheet, job.manualScrews?.[mkey]?.[i]);
      sheet.tabsManual = job.manualTabs?.[mkey]?.[i] || undefined;
      const rno = sheet.remnant && (remnants.find((r) => r.id === sheet.remnant.id)?.no ?? nestOpts.remnants.find((r) => r.id === sheet.remnant.id)?.no ?? kept?.stock?.find((r) => r.id === sheet.remnant.id)?.no);
      sheet.remnant && (sheet.remnant.no = rno);
      const what = sheet.remnant ? `remnant R${rno ?? '?'}` : `sheet ${i + 1} of ${nest.sheets.length}`;
      const title = `${job.name || 'Job'} | ${g.key} | ${what}`;
      if (s.screws?.on && !sheet.screwsManual && sheet.screwsMissing) stockNotes.push(`${g.key} ${what}: room for only ${sheet.screws.length} of 5 hold-down screws — hold the rest of the sheet another way`);
      if (s.screws?.on && !sheet.screwsManual && sheet.screwsInKeeper) stockNotes.push(`${g.key} ${what}: ${sheet.screwsInKeeper} hold-down screw${sheet.screwsInKeeper === 1 ? '' : 's'} had to go in the offcut being kept (no scrap in that part of the sheet) — it will have the hole${sheet.screwsInKeeper === 1 ? '' : 's'}`);
      // sheet numbers padded (S01 … S10 sort right everywhere); see nameFiles for the screw-file pair
      const nw = Math.max(2, String(nest.sheets.length).length);
      const item = { sheet, tp: null, cfg, title, mkey, idx: i, screwChk: [], base: `${stamp}_${mat}_${g.thickness.toFixed(3)}_${sheet.remnant ? 'R' + (rno ?? 'x') : 'S' + String(i + 1).padStart(nw, '0')}`, ext, text: null, group: g };
      toPlan.push({ item, label: `${g.key} ${what}` });
      return item;
    });
    res.push({ group: g, sheets, unplaced: nest.unplaced, lowerBound: nest.stats?.lowerBound });
  }
  // the layout only: toolpaths wait for the Toolpath button (planAll)
  if (run !== nestRun) return;   // a newer run started meanwhile: it shows its own
  for (const { item, label } of toPlan) { item.label = label; nameFiles(item); }
  results = res;
  stale = false;
  results.quick = quick;
  results.pendingShapes = pendingShapes;
  const all = results.flatMap((r) => r.sheets);
  activeSheet = Math.min(activeSheet, Math.max(0, all.length - 1));
  const warnings = [...problems, ...stockNotes];
  results.nestNotes = warnings;
  const unplaced = results.flatMap((r) => r.unplaced.map((u) => `${u.name}: ${u.reason}`));
  showMessages([
    { error: true, text: unplaced.length ? 'Not placed:' : '', items: unplaced },
    { text: warnings.length ? 'Check before cutting:' : '', items: warnings },
    { text: all.length ? 'Laid out. Arrange the sheets if you need to, then click Toolpath to plan them.' : '', items: [] },
    { text: pendingShapes ? `Fitting ${pendingShapes} custom shape${pendingShapes === 1 ? '' : 's'} in among the parts… the sheets update when it's done (downloads wait till then).` : '', items: [] },
  ]);
  renderResults();
}

// ---------- hand-placed hold-down screws ----------
// Kept per sheet in job.manualScrews[nest key | layout][sheet index], so a new
// layout (search again, different parts or settings) starts from automatic again.
function strHash(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
const manualKey = (key, kept) => `${key}|${kept ? strHash(JSON.stringify(kept.solution)) : 'quick'}`;
const screwsShown = (cfg, sheet) => !!(cfg.screws?.on || sheet.screwsManual);

function applyManualScrews(sheet, list) {
  if (!sheet.autoScrews) sheet.autoScrews = { screws: sheet.screws || [], missing: sheet.screwsMissing || 0, inKeeper: sheet.screwsInKeeper || 0 };
  if (list) {
    sheet.screws = list.map((q) => ({ x: q.x, y: q.y }));
    sheet.screwsManual = true;
  } else {
    sheet.screws = sheet.autoScrews.screws;
    sheet.screwsMissing = sheet.autoScrews.missing;
    sheet.screwsInKeeper = sheet.autoScrews.inKeeper;
    sheet.screwsManual = false;
  }
}

// new screw list for one sheet (null = back to automatic): its toolpaths wait for Toolpath
function setSheetScrews(item, list) {
  job.manualScrews = job.manualScrews || {};
  const m = (job.manualScrews[item.mkey] = job.manualScrews[item.mkey] || {});
  if (list) m[item.idx] = list.map((q) => ({ x: +q.x.toFixed(3), y: +q.y.toFixed(3) }));
  else delete m[item.idx];
  if (!Object.keys(m).length) delete job.manualScrews[item.mkey];
  applyManualScrews(item.sheet, list);
  markEdited(item);
}

// A sheet's files: with separate screw holes, the screw file first (run it,
// drive the screws, then the sheet's own file); otherwise just the sheet's.
// File names: a sheet with its screw holes in their own file gets a pair that
// lists in run order in any file list: …_S01a_screws.nc, then …_S01b.nc.
// Otherwise just …_S01.nc. Redone whenever the sheet's toolpath is.
function nameFiles(item) {
  const pair = item.tp?.screwMoves?.length > 0;
  item.file = `${item.base}${pair ? 'b' : ''}.${item.ext}`;
  item.screwFile = pair ? `${item.base}a_screws.${item.ext}` : null;
}
const screwFileName = (item) => item.screwFile;
function screwTextFor(item) {
  if (!item.screwText) {
    const r = postWithWarnings(item.tp.screwMoves, item.cfg, { title: `${item.title} | screw holes`, material: item.group.material, fileName: screwFileName(item), sheetW: item.sheet.w, sheetH: item.sheet.h });
    item.screwText = r.text;
  }
  return item.screwText;
}
function filesFor(item) {
  const f = [];
  if (item.tp.screwMoves?.length) f.push({ name: screwFileName(item), text: screwTextFor(item) });
  f.push({ name: item.file, text: textFor(item) });
  return f;
}

function textFor(item) {
  if (!item.text) {
    const r = postWithWarnings(item.tp.moves, item.cfg, { title: item.title, material: item.group.material, fileName: item.file, sheetW: item.sheet.w, sheetH: item.sheet.h });
    item.text = r.text;
    if (r.warnings.length) showMessages([{ text: `Post "${item.cfg.pp?.name}":`, items: r.warnings }]);
  }
  return item.text;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function renderResults() {
  const all = results.flatMap((r) => r.sheets);
  $('#resultsCard').hidden = !all.length;
  if (!all.length) return;
  const mins = all.reduce((a, x) => a + (x.tp ? x.tp.stats.estMinutes : 0), 0);
  const todo = all.filter((x) => !x.tp || x.tpStale).length;
  const lb = results.reduce((a, r) => a + (r.lowerBound || 0), 0);
  const full = all.filter((x) => !x.sheet.remnant).length, rem = all.length - full;
  const keepN = all.reduce((a, x) => a + (x.sheet.offcuts?.length || 0), 0);
  $('#resultsSummary').textContent = `${full} sheet${full === 1 ? '' : 's'}` +
    (rem ? ` + ${rem} remnant${rem === 1 ? '' : 's'}` : '') +
    (lb && lb < full ? ` (area minimum ${lb})` : '') + (todo === all.length ? ' · no toolpaths yet: click Toolpath' : ` · ~${Math.round(mins)} min cutting` + (todo ? ` (${todo} sheet${todo === 1 ? ' needs' : 's need'} Toolpath)` : '')) +
    (keepN ? ` · ${keepN} offcut${keepN === 1 ? '' : 's'} to keep` : '') +
    (results.quick ? ' · quick nest: click Nest to search for a better one' : '');
  renderCutState();
  // custom shapes still being fitted, or changes waiting: nothing to download or mark cut yet
  showStale();
  $('#sheetTabs').innerHTML = all.map((x, i) => {
    const n = results.find((r) => r.sheets.includes(x));
    const fulls = n.sheets.filter((y) => !y.sheet.remnant);
    const tag = x.sheet.remnant ? `R${x.sheet.remnant.no ?? '?'} ${f3(x.sheet.w)}×${f3(x.sheet.h)}` : `${fulls.indexOf(x) + 1}/${fulls.length}`;
    return `<button data-s="${i}" class="${i === activeSheet ? 'active' : ''}">${esc(n.group.material)} ${f3(n.group.thickness)}" · ${tag}</button>`;
  }).join('');
  renderSheet(all[activeSheet]);
}

$('#sheetTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-s]');
  if (!b) return;
  activeSheet = +b.dataset.s;
  renderResults();
});

// Carve the sheet's toolpath and check it against the model (cached per sheet)
function simulateSheet(item) {
  if (item.sim) return item.sim;
  const res = 0.04;
  const sim = carve(item.sheet, item.tp.moves, { res, dia: item.cfg.tool.dia });
  const dado = item.cfg.dadoSameTool || !item.cfg.dadoTool ? item.cfg.tool : item.cfg.dadoTool;
  const firstBit = item.tp.moves.find((m) => m.toolchange)?.tool;
  const scr = screwsShown(item.cfg, item.sheet) ? { screws: item.sheet.screws || [], screwR: screwR(item.cfg.screws), screwHoleR: (firstBit?.dia || 0) / 2 } : {};
  const result = check(item.sheet, sim, { dia: dado.dia, profileDia: item.cfg.tool.dia, thickness: item.cfg.thickness, holdDown: holdDownOf(item.cfg), ...scr });
  const im = shade(sim, { thickness: item.cfg.thickness, cells: result.cells });
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  c.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
  item.sim = { url: c.toDataURL(), result, res, W: sim.W, H: sim.H };
  return item.sim;
}

// ---------- G-code folder (desktop app) ----------
// Files go straight into a folder chosen once on this PC (the ShopBot PC's
// share, a USB stick...). In a browser they download as before.
const outFolder = () => deskPrefs().outputFolder || '';
async function chooseOutFolder() {
  const f = await desk.chooseFolder(outFolder());
  if (f) setDeskPrefs({ outputFolder: f });
  showOutFolder();
  return f;
}
function showOutFolder() {
  const el = $('#outFolder');
  $('#saveFilesBtn').textContent = desk ? 'Save all to folder' : 'Download all';
  $('#saveFilesBtn').title = desk ? "Write every sheet's file straight into the G-code folder" : "Download every sheet's file";
  el.hidden = !desk;
  if (!desk) return;
  const f = outFolder();
  el.innerHTML = f ? `G-code folder: <span title="${esc(f)}">${esc(f.length > 60 ? '…' + f.slice(-59) : f)}</span> · <a href="#" id="outChange">change</a> · <a href="#" id="outOpen">open</a>`
    : 'G-code folder: <a href="#" id="outChange">choose one</a> (Save all to folder asks the first time)';
  $('#outChange').onclick = (e) => { e.preventDefault(); chooseOutFolder(); };
  if (f) $('#outOpen').onclick = (e) => { e.preventDefault(); desk.openFolder(f); };
}
async function saveToFolder(items) {
  const folder = outFolder() || await chooseOutFolder();
  if (!folder) return;
  const r = await desk.writeFiles(folder, items.flatMap(filesFor));
  if (!r.ok) { showMessages([{ error: true, text: `Couldn't save to ${folder}: ${r.error}` }]); return; }
  const rep = r.replaced.length ? ` (${r.replaced.length} replaced an older file of the same name)` : '';
  showMessages([{ text: `Saved ${r.written.length === 1 ? r.written[0] : r.written.length + ' files'} to ${folder}${rep}.` }]);
}
showOutFolder();
async function downloadAll() {
  for (const f of results.flatMap((r) => r.sheets).flatMap(filesFor)) {
    download(f.name, f.text);
    await new Promise((r) => setTimeout(r, 350));
  }
}
async function downloadSheet(item) {
  for (const f of filesFor(item)) { download(f.name, f.text); await new Promise((r) => setTimeout(r, 350)); }
}
const allSheets = () => results.flatMap((r) => r.sheets);
const thisSheet = () => allSheets()[activeSheet];
// Save files: everything in one go; the arrow for this sheet only, downloading, the folder
$('#saveFilesBtn').onclick = () => (desk ? saveToFolder(allSheets()) : downloadAll());
$('#saveFilesMore').onclick = (e) => {
  const item = thisSheet();
  const one = item ? item.file + (item.tp?.screwMoves?.length ? ' + screws' : '') : '';
  showMenuAt(e.currentTarget, desk ? [
    [`Save this sheet to folder (${one})`, () => saveToFolder([item]), { disabled: !item }],
    null,
    ['Download all', () => downloadAll()],
    [`Download this sheet (${one})`, () => downloadSheet(item), { disabled: !item }],
    null,
    ['Choose G-code folder…', () => chooseOutFolder()],
    ['Open G-code folder', () => desk.openFolder(outFolder()), { disabled: !outFolder() }],
  ] : [
    [`Download this sheet (${one})`, () => downloadSheet(item), { disabled: !item }],
  ]);
};

// Grain on the sheet: length grain runs along the part's long side (part X).
function grainMark(pl) {
  const g = pl.part.grainEffective ?? pl.part.grain;
  if (pl.xf) {
    // a custom shape at an angle: show the turn (and the grain if it has one)
    const turn = ((pl.angle % 360) + 360) % 360;
    if (pl.mirror) return ` · turned over${turn ? `, ${+turn.toFixed(1)}°` : ''}${g === 'none' || g === 'any' ? '' : ' (grain ' + ((g === 'width') === (turn % 180 === 0) ? '↕' : '↔') + ')'}`;
    return turn ? ` · turned ${+turn.toFixed(1)}°${g === 'none' || g === 'any' ? '' : ' (grain ' + ((g === 'width') === (turn % 180 === 0) ? '↕' : '↔') + ')'}` : (g === 'none' ? '' : ' · grain ' + (g === 'width' ? '↕' : '↔'));
  }
  if (g === 'none') return '';
  const alongPartX = g !== 'width';
  const alongSheetX = alongPartX !== !!pl.rotated;
  return g === 'any' ? ` · any ${alongSheetX ? '↔' : '↕'}` : ` · grain ${alongSheetX ? '↔' : '↕'}`;
}

const pts = (poly) => poly.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');

function renderSheet(item) {
  const sh = item.sheet;
  const s = { sheetW: sh.w ?? item.cfg.sheet.sheetW, sheetH: sh.h ?? item.cfg.sheet.sheetH, trim: sh.trim ?? item.cfg.sheet.trim };
  const tx = sh.trimX ?? s.trim;
  const st = item.tp?.stats;
  const pad = 1.5;
  const H = s.sheetH;
  const fy = (y) => H - y; // machine Y up
  let svg = `<svg class="sheet-svg${screwEdit ? ' screw-edit' : ''}${moveEdit ? ' move-edit' : ''}${tabEdit ? ' tab-edit' : ''}" viewBox="${-pad} ${-pad} ${s.sheetW + 2 * pad} ${H + 2 * pad}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect class="sheet" x="0" y="0" width="${s.sheetW}" height="${H}"/>`;
  svg += `<rect class="trim" x="${tx}" y="${s.trim}" width="${s.sheetW - 2 * tx}" height="${H - 2 * s.trim}"/>`;
  // an L / T remnant: the missing part of its bounding box
  if (sh.remnant?.rects?.length > 1) {
    let miss = [{ x: 0, y: 0, w: s.sheetW, h: H }];
    for (const q of sh.remnant.rects) miss = miss.flatMap((m) => rectMinus(m, q));
    for (const m of miss) svg += `<rect class="notstock" x="${m.x}" y="${fy(m.y + m.h)}" width="${m.w}" height="${m.h}"><title>not part of this remnant</title></rect>`;
  }
  const flip = (poly) => poly.map(([x, y]) => [x, fy(y)]);
  const partNo = numberPlacements(item.sheet);
  // Check cut carves the whole sheet: drawn first without it, then it follows
  const canSim = item.tp && !item.tpStale && !item.replanning;
  if (showSim && !item.sim && canSim) setTimeout(() => { if (showSim && !item.sim && item.tp && !item.tpStale && allSheets()[activeSheet] === item) { simulateSheet(item); renderResults(); } }, 30);
  const sim = showSim && canSim ? item.sim : null;
  if (sim) svg += `<image href="${sim.url}" x="0" y="${H - sim.H}" width="${sim.W}" height="${sim.H}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`;
  item.sheet.placements.forEach((pl, idx) => {
    const g = placedGeometry(pl);
    svg += `<g class="pl${pl.moved ? ' moved' : ''}" data-i="${idx}">`;
    svg += `<polygon class="part${sim ? ' simmed' : ''}" points="${pts(flip(g.outline))}"><title>${esc(pl.label || pl.part.name)} ${f3(pl.part.width)} × ${f3(pl.part.height)}${pl.moved ? ' · moved by hand' : ''}${moveEdit ? ' · drag to move, right-click to put back' : ''}</title></polygon>`;
    if (!sim) for (const h of g.holes) svg += `<polygon class="hole" points="${pts(flip(h))}"/>`;
    if (!sim) for (const q of g.pockets) {
      const d = q.loops.map((l) => 'M' + flip(l).map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L') + 'Z').join('');
      svg += `<path class="pocket" fill-rule="evenodd" d="${d}"><title>dado ${f3(q.depth)} deep</title></path>`;
    }
    const [lx, ly] = labelPoint(pl, g);
    const cx = lx, cy = fy(ly);
    const small = Math.min(g.box.x1 - g.box.x0, g.box.y1 - g.box.y0) < 6 || !!pl.xf;
    svg += `<text class="label" x="${cx}" y="${cy}" text-anchor="middle" ${small ? 'font-size="0.8"' : ''}>${esc(pl.label || pl.part.name)}</text>`;
    svg += `<text class="label sub" x="${cx}" y="${cy + 1.3}" text-anchor="middle">${f3(pl.part.width)} × ${f3(pl.part.height)}${grainMark(pl)}</text>`;
    svg += `<text class="partno" x="${g.box.x0 + 0.5}" y="${fy(g.box.y1) + 1.6}">#${partNo.get(pl)}</text>`;
    svg += '</g>';
  });
  // custom shapes: a handle to turn each one, drawn over everything so another
  // part can't cover it; just above the part, or below it at the top of the sheet
  if (moveEdit) item.sheet.placements.forEach((pl, idx) => {
    if (!pl.xf) return;
    const b = pl.box;
    const hx = (b.x0 + b.x1) / 2;
    const above = b.y1 + 2.2 <= H;
    const y0 = above ? b.y1 : b.y0, y1 = above ? b.y1 + 2.2 : b.y0 - 2.2;
    svg += `<g class="rot-handle" data-i="${idx}"><line x1="${hx}" y1="${fy(y0)}" x2="${hx}" y2="${fy(y1)}"/><circle cx="${hx}" cy="${fy(y1)}" r="0.75"><title>Drag to turn ${esc(pl.label || pl.part.name)}${pl.turned ? ` (turned by hand to ${Math.round(pl.xf.a)}°)` : ''}</title></circle></g>`;
  });
  if (showPaths && item.tp && !item.replanning) {
    let cut = '', rapid = '', tab = '', prev = null;
    for (const m of item.tp.moves) {
      if (m.x == null) continue;
      if (prev && (Math.abs(prev.x - m.x) > 1e-6 || Math.abs(prev.y - m.y) > 1e-6)) {
        const seg = `M${prev.x.toFixed(3)} ${fy(prev.y).toFixed(3)}L${m.x.toFixed(3)} ${fy(m.y).toFixed(3)}`;
        if (m.g === 0) rapid += seg; else if (m.op === 'tab') tab += seg; else cut += seg;
      }
      prev = m;
    }
    svg += `<path class="rapid" d="${rapid}"/><path class="cut" d="${cut}"/><path class="tabseg" d="${tab}"/>`;
    const seen = new Set();
    for (const m of item.tp.moves) {
      if (m.op !== 'drill' || !m.plunge) continue;
      const k = `${m.x.toFixed(3)},${m.y.toFixed(3)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      svg += `<circle class="drillpt" cx="${m.x.toFixed(3)}" cy="${fy(m.y).toFixed(3)}" r="0.22"/>`;
    }
  }
  // tabs: where the bit lifts to leave a bridge (hand-placed ones can be dragged in Place tabs)
  // (before Toolpath they're worked out from the layout, and always shown)
  const tv = tabsView(item);
  if (tv?.tabs?.length && (showPaths || tabEdit || !item.tp) && !item.replanning) {
    const tl = item.cfg.tabs?.length || 0.5, tw = Math.max(0.3, item.cfg.tool.dia * 1.6);
    tv.tabs.forEach((t, k) => {
      svg += `<g class="tabmark" data-k="${k}" transform="translate(${t.x.toFixed(3)} ${fy(t.y).toFixed(3)}) rotate(${(-t.a * 180 / Math.PI).toFixed(2)})"><rect x="${-tl / 2}" y="${-tw / 2}" width="${tl}" height="${tw}"><title>Tab${sh.tabsManual ? ' (placed by hand)' : ''}${tabEdit ? ' · drag to move, right-click to remove' : ''}</title></rect>${tabEdit ? '<circle class="tabhit" r="1"/>' : ''}</g>`;
    });
  }
  // screw hold-downs: the hole, and the ring no cut comes inside (red = bad spot)
  if (screwsShown(item.cfg, sh) || screwEdit) (sh.screws || []).forEach((q, k) => {
    const c = item.screwChk?.[k];
    const tip = c && !c.ok ? `Bad spot: ${c.why}` : `Hold-down screw${sh.screwsManual ? ' (placed by hand)' : ''}${c?.inKeeper ? ', in the offcut being kept' : ''} — drilled first, then the machine stops`;
    svg += `<g class="screw${c && !c.ok ? ' bad' : ''}" data-k="${k}" transform="translate(${q.x.toFixed(3)} ${fy(q.y).toFixed(3)})"><circle class="screwzone" r="${screwR(item.cfg.screws).toFixed(3)}"><title>${tip}${screwEdit ? ' · drag to move, right-click to remove' : ''}</title></circle><circle class="screwpt" r="0.1"/>${screwEdit ? '<circle class="screwhit" r="1.2"/>' : ''}</g>`;
  });
  // offcuts worth keeping (on the zero corner where possible); numbered once the job is marked cut
  (sh.offcuts || []).forEach((oc, k) => {
    const no = job.cut?.added?.find((a) => a.sheetFile === item.file && a.k === k)?.no;
    const rs = oc.rects?.length > 1 ? oc.rects : [oc];
    // an L / T keeper: both rectangles, one piece (no line between them)
    if (rs.length > 1) svg += `<polygon class="offcut${no ? ' kept' : ''}" points="${pts(flip(rectsOutline(rs)))}"/>`;
    else svg += `<rect class="offcut${no ? ' kept' : ''}" x="${oc.x}" y="${fy(oc.y + oc.h)}" width="${oc.w}" height="${oc.h}"/>`;
    const lb = rs.reduce((a, q) => (q.w * q.h > a.w * a.h ? q : a));
    svg += `<text class="label" x="${lb.x + lb.w / 2}" y="${fy(lb.y + lb.h / 2)}" text-anchor="middle">${no ? `R${no} ` : ''}keep ${fraction(oc.w)} × ${fraction(oc.h)}${rs.length > 1 ? ' L' : ''}</text>`;
    if (oc.x < 1e-6 && oc.y < 1e-6) svg += `<text class="label sub" x="${lb.x + lb.w / 2}" y="${fy(lb.y + lb.h / 2) + 1.4}" text-anchor="middle">zero corner stays with it${rs.length > 1 ? ' · one piece, L-shaped' : ''}</text>`;
  });
  // problem spots, ringed so they show at any zoom
  if (sim) for (const c of sim.result.cells.slice(0, 300)) svg += `<circle class="simbad ${c.kind}" cx="${((c.i + 0.5) * sim.res).toFixed(3)}" cy="${fy((c.j + 0.5) * sim.res).toFixed(3)}" r="0.3"><title>${c.kind === 'uncut' ? 'left uncut' : c.kind === 'deep' ? 'cut deeper than the model' : c.kind === 'screw' ? 'cut too close to a screw' : 'outline not cut through'}</title></circle>`;
  svg += `<circle class="origin" cx="0" cy="${H}" r="0.5"/>`;
  svg += '</svg>';
  const simNote = item.replanError ? `<p class="small sim-bad">This sheet's toolpaths couldn't be re-planned after the last edit, so the ones shown are from before it. Undo the edit (or Put all back / Back to automatic) and send this to Claude:<br><code style="white-space:pre-wrap">${esc(item.replanError.slice(0, 600))}</code></p>`
    : item.replanning ? '<p class="small muted">Re-planning this sheet\'s toolpaths…</p>'
    : !sim ? (showSim ? '<p class="small muted">Check cut: carving the sheet…</p>' : '') : sim.result.ok
    ? '<p class="small sim-ok">Check cut: every floor cut to depth, nothing deeper than the model' + (['tabs', 'none'].includes(holdDownOf(item.cfg)) ? ', every outline cut through except at tabs' : '') + '.</p>'
    : `<p class="small sim-bad">Check cut: ${[sim.result.uncut && `${sim.result.uncut} spots left uncut (yellow)`, sim.result.deep && `${sim.result.deep} spots cut deeper than the model (red)`, sim.result.notThrough && `${sim.result.notThrough} spots of outline not cut through (pink)`, sim.result.screw && `${sim.result.screw} spots cut inside a screw's clearance (blue)`].filter(Boolean).join(' · ')}. Check before cutting.</p>`;

  $('#sheetView').innerHTML = `
    <div class="sheet-head">
      <strong>${esc(item.title)}</strong>
      <span class="muted">${item.sheet.placements.length} parts · ${(item.sheet.yield * 100).toFixed(0)}% yield${st ? ` · ${st.cutLength.toFixed(0)}" of cut · ${st.rapidLength.toFixed(0)}" of rapids · ~${st.estMinutes.toFixed(0)} min` : ''}</span>${!item.tp ? ' <span class="tp-need">no toolpaths yet: click Toolpath</span>' : item.tpStale ? ' <span class="tp-need">toolpaths out of date: click Toolpath</span>' : ''}
      <span class="spacer"></span>
      <button id="runSimBtn" ${results.pendingShapes || !item.tp || item.tpStale ? 'disabled' : ''} title="Play this sheet's file in 3D the way the machine will run it">3D simulation</button>
    </div>
    <div class="sheet-tools">
      <span class="seg" role="group" aria-label="Mode">
        <button data-mode="view" class="${!moveEdit && !tabEdit && !screwEdit ? 'active' : ''}" title="Look at the sheet">View</button>
        <button data-mode="move" class="${moveEdit ? 'active' : ''}" ${job.cut || results.pendingShapes ? 'disabled' : ''} title="${job.cut ? 'The job is marked as cut: its layout is fixed' : 'Drag parts by hand on this sheet. A part dropped too close to another part, a screw or the edge goes to the nearest spot where it fits. Right-click to copy, paste or delete.'}">Move parts</button>
        <button data-mode="tabs" class="${tabEdit ? 'active' : ''}" title="Place tabs by hand on this sheet: click near a part's edge to add one, drag to move, right-click to remove">Tabs</button>
        <button data-mode="screws" class="${screwEdit ? 'active' : ''}" title="Place hold-down screws by hand on this sheet: click to add, drag to move, right-click to remove">Screws</button>
      </span>
      <span class="spacer"></span>
      <span class="small muted">Show</span>
      <label class="check inline small"><input type="checkbox" id="showPaths" ${showPaths ? 'checked' : ''}> Toolpaths</label>
      <label class="check inline small" title="Carve the toolpath into the sheet and check it against the model: every floor cut to depth, nothing deeper than the model, outlines cut through (with tabs). Yellow = left uncut, red = too deep, pink = not cut through."><input type="checkbox" id="showSim" ${showSim ? 'checked' : ''}> Check cut</label>
      <span class="legend"><span><i style="background:var(--path)"></i>cut</span><span><i style="background:var(--rapid)"></i>rapid</span><span><i style="background:var(--pocket)"></i>dado</span><span><i style="background:var(--drill)"></i>drill</span>${usesTabs(item.cfg) ? '<span><i style="background:var(--tab)"></i>tab</span>' : ''}</span>
    </div>
    ${moveEdit ? `<p class="small screw-help">Moving parts: drag a part where you want it. A custom shape has a round handle above it: drag the handle to turn the part (in the custom-shape steps, or a half turn when its grain is set; hold Shift for single degrees). If it would come too close to another part's cut, a hold-down screw or the edge of the stock, it goes to the nearest spot where it fits (dashed outline while dragging). Right-click a part to copy, delete or put it back; right-click a spot to paste. ${sh.partsMoved || 0} moved${sh.partsAdded ? `, ${sh.partsAdded} pasted` : ''}${sh.partsRemoved ? `, ${sh.partsRemoved} deleted` : ''} on this sheet. <button id="moveReset" ${sh.partsMoved ? '' : 'disabled'}>Put all back</button>${moveMsg ? `<br><span class="${moveMsg.startsWith('!') ? 'move-err' : 'move-note'}">${esc(moveMsg.replace(/^!/, ''))}</span>` : ''}${job.pendingQty && Object.keys(job.pendingQty).length ? '<br><strong>Parts added or deleted: Nest &amp; toolpath nests again with the new counts.</strong> Until then deleted parts leave their spot empty and pasted ones stay where you put them.' : ''}</p>` : ''}
    ${tabEdit ? `<p class="small screw-help">Placing tabs: click near a part's edge to add a tab there (it goes on the bit's path, along that edge, clear of the corners; on a line two parts share it holds both), drag one to move it, right-click to remove it. ${tabsView(item)?.tabs?.length || 0} on this sheet${sh.tabsManual ? ' (placed by hand: parts without one get none)' : ''}. <button id="tabAuto" ${sh.tabsManual ? '' : 'disabled'}>Back to automatic</button> <button id="tabClear" ${tabsView(item)?.tabs?.length ? '' : 'disabled'}>Remove all</button>${tabMsg ? `<br><span class="${tabMsg.startsWith('!') ? 'move-err' : 'move-note'}">${esc(tabMsg.replace(/^!/, ''))}</span>` : ''}</p>` : ''}
    ${screwEdit ? `<p class="small screw-help">Placing screws: click an empty spot to add one, drag to move, right-click to remove. A screw dropped too close to a cut goes to the nearest spot clear of it. Red = a cut or part is too close. ${sh.screws?.length || 0} on this sheet${sh.screwsManual ? ' (placed by hand)' : ''}. <button id="screwAuto" ${sh.screwsManual ? '' : 'disabled'}>Back to automatic</button> <button id="screwClear" ${sh.screws?.length ? '' : 'disabled'}>Remove all</button>${screwMsg ? `<br><span class="${screwMsg.startsWith('!') ? 'move-err' : 'move-note'}">${esc(screwMsg.replace(/^!/, ''))}</span>` : ''}</p>` : ''}
    ${svg}
    ${simNote}
    ${sh.remnant ? `<p class="small"><strong>Remnant R${sh.remnant.no ?? '?'}</strong> (${fraction(sh.w)} × ${fraction(sh.h)}): put its zero corner (the one that was the sheet's zero corner) at the origin, grain along X.</p>` : ''}
    <p class="muted small">Origin (red dot) is front-left of the ${sh.remnant ? 'remnant' : 'sheet'}, X along the ${s.sheetW}" side. Z0 = ${item.cfg.zZero === 'table' ? 'spoilboard' : 'material top'}. Air-cut new posts before running material.</p>`;
  // one mode at a time: View, Move parts, Tabs or Screws
  for (const b of $('#sheetView').querySelectorAll('[data-mode]')) b.onclick = () => {
    const m = b.dataset.mode;
    moveEdit = m === 'move'; tabEdit = m === 'tabs'; screwEdit = m === 'screws';
    tabMsg = '';
    renderResults();
  };
  $('#showPaths').onchange = (e) => { showPaths = e.target.checked; renderResults(); };
  $('#showSim').onchange = (e) => { showSim = e.target.checked; renderResults(); };
  $('#runSimBtn').onclick = async () => {
    const btn = $('#runSimBtn');
    btn.disabled = true;
    try {
      const { openRunSim } = await import('./lib/runsim.js');
      const sbp = /\.sbp$/i.test(item.file);
      const tools = item.tp.moves.filter((m) => m.toolchange).map((m) => ({ name: m.tool?.name || String(m.note || '').replace(/^Tool:\s*/, ''), dia: m.tool?.dia }));
      openRunSim({ text: textFor(item), kind: sbp ? 'sbp' : 'gcode', cfg: item.cfg, sheet: item.sheet, title: `${item.title} · ${item.file}`, tools });
    } catch (e) {
      showMessages([{ error: true, text: `Couldn't simulate: ${e.message}` }]);
    } finally { btn.disabled = false; }
  };
  if (tabEdit) {
    if ($('#tabAuto')) $('#tabAuto').onclick = () => { tabMsg = ''; setSheetTabs(item, null); };
    if ($('#tabClear')) $('#tabClear').onclick = () => { tabMsg = ''; setSheetTabs(item, []); };
    wireTabEdit(item, $('#sheetView svg'), fy);
  }
  if (moveEdit && !job.cut && !results.pendingShapes) {
    $('#moveReset').onclick = () => setSheetMoves(item, null);
    wireMoveEdit(item, $('#sheetView svg'), fy);
  }
  if (screwEdit) {
    $('#screwAuto').onclick = () => setSheetScrews(item, null);
    $('#screwClear').onclick = () => setSheetScrews(item, []);
    wireScrewEdit(item, $('#sheetView svg'), fy);
  }
  renderLabels();
}

// ---------- hand-placed tabs ----------
// Kept like screws: job.manualTabs[nest key | layout][sheet index] = [{ x, y }]
// (tab centres on the bit's path). A new layout starts from automatic again.
function setSheetTabs(item, list) {
  job.manualTabs = job.manualTabs || {};
  const m = (job.manualTabs[item.mkey] = job.manualTabs[item.mkey] || {});
  if (list) m[item.idx] = list.map((q) => ({ x: +q.x.toFixed(4), y: +q.y.toFixed(4) }));
  else delete m[item.idx];
  if (!Object.keys(m).length) delete job.manualTabs[item.mkey];
  item.sheet.tabsManual = list ? m[item.idx] : undefined;
  // shown at once on the bit's path (Back to automatic: the automatic ones come with Toolpath)
  item.tabView = null;   // before Toolpath: worked out again from the layout and the new list
  if (item.tp) {
    const opt = item.cfg.tabs || {};
    item.tp = { ...item.tp, tabs: (list || []).map((q) => {
      const s = tabOnPaths(item.tp.tabPaths || [], [q.x, q.y], item.cfg.tool, opt);
      const sp = s?.on?.[0]?.span;
      return { x: s?.c ? s.c[0] : q.x, y: s?.c ? s.c[1] : q.y, a: sp ? Math.atan2(sp[1][1] - sp[0][1], sp[1][0] - sp[0][0]) : 0 };
    }) };
  }
  markEdited(item);
}
// Runs a pointermove handler at most once per animation frame, with the latest
// event; flush() runs a waiting one at once (before the release is handled).
function perFrame(fn) {
  let ev = null;
  let raf = 0;
  const run = () => { raf = 0; const x = ev; ev = null; if (x) fn(x); };
  const h = (e) => { ev = e; if (!raf) raf = requestAnimationFrame(run); };
  h.flush = () => { if (raf) { cancelAnimationFrame(raf); run(); } };
  return h;
}
function wireTabEdit(item, svgEl, fy) {
  const at = (e) => {
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    return { x: p.x, y: fy(p.y) };
  };
  if (!tabsView(item)) return;
  const opt = item.cfg.tabs || {};
  const okOpt = opt.length > 0 && opt.thickness > 0;
  // on the bit's path: from the toolpath, or worked out from the layout before Toolpath
  const snap = (p) => tabOnPaths(tabsView(item)?.tabPaths || [], [p.x, p.y], item.cfg.tool, opt);
  const list = () => (tabsView(item)?.tabs || []).map((t) => ({ x: t.x, y: t.y }));
  let drag = null;
  svgEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (item.replanning) return;   // tabs follow the toolpaths being redone
    const g = e.target.closest('g.tabmark');
    if (!g) return;
    const l = list();
    l.splice(+g.dataset.k, 1);
    tabMsg = '';
    setSheetTabs(item, l);
  });
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (item.replanning) return;   // tabs follow the toolpaths being redone
    if (!okOpt) { tabMsg = '!Set a tab length and thickness on the Cutting card first.'; renderResults(); return; }
    const g = e.target.closest('g.tabmark');
    if (g) { drag = { k: +g.dataset.k, g, l: list(), moved: false }; svgEl.setPointerCapture(e.pointerId); return; }
    const h = snap(at(e));
    if (!h) { tabMsg = '!Click within an inch of a part\'s edge to put a tab there.'; renderResults(); return; }
    if (h.short) { tabMsg = '!That edge is too short for a tab.'; renderResults(); return; }
    tabMsg = h.on.length > 1 ? 'On a shared line: the tab holds both parts.' : '';
    setSheetTabs(item, [...list(), { x: h.c[0], y: h.c[1] }]);
  });
  // one update per frame however fast the mouse reports (flushed on release)
  const onMove = perFrame((e) => {
    if (!drag) return;
    const h = snap(at(e));
    if (!h || h.short) return;
    drag.l[drag.k] = { x: h.c[0], y: h.c[1] };
    drag.moved = true;
    const tr = drag.g.getAttribute('transform').replace(/translate\([^)]*\)/, `translate(${h.c[0].toFixed(3)} ${fy(h.c[1]).toFixed(3)})`);
    // the angle of the edge it's on now
    const a = Math.atan2(h.on[0].span[1][1] - h.on[0].span[0][1], h.on[0].span[1][0] - h.on[0].span[0][0]);
    drag.g.setAttribute('transform', tr.replace(/rotate\([^)]*\)/, `rotate(${(-a * 180 / Math.PI).toFixed(2)})`));
  });
  svgEl.addEventListener('pointermove', onMove);
  const end = () => {
    onMove.flush();
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) { tabMsg = ''; setSheetTabs(item, d.l); }
  };
  svgEl.addEventListener('pointerup', end);
  svgEl.addEventListener('pointercancel', end);
}

// ---------- moving parts by hand ----------
// Kept like hand-placed screws: job.manualMoves[nest key | layout][sheet index]
// = { "part id#copy": { x, y } }. A new layout starts from the nest's again.
const partGap = (cfg, a, b) => (cfg.commonLine && !a.xf && !(b && b.xf) ? cfg.tool.dia : cfg.sheet.spacing);
function setSheetMoves(item, moves) {
  job.manualMoves = job.manualMoves || {};
  const m = (job.manualMoves[item.mkey] = job.manualMoves[item.mkey] || {});
  if (moves && Object.keys(moves).length) m[item.idx] = moves;
  else delete m[item.idx];
  if (!Object.keys(m).length) delete job.manualMoves[item.mkey];
  refreshSheet(item);
}

// the sheet again from its nest layout, hand moves and added / removed parts
function refreshSheet(item) {
  const rmin = { side: job.settings.remnants?.minSide ?? 8, area: job.settings.remnants?.minArea ?? 288 };
  applyMoves(item.sheet, job.manualMoves?.[item.mkey]?.[item.idx], { gap: item.cfg.commonLine ? item.cfg.tool.dia : item.cfg.sheet.spacing, remnantMin: rmin,
    edits: job.layoutEdits?.[item.mkey]?.[item.idx], partOf: (k) => item.group.parts.find((p) => partKey(p) === k) });
  dropToolpaths(item);
}

// ---------- copy, paste and delete parts on a sheet ----------
// A part deleted from a sheet leaves its spot empty, and a pasted one sits where
// it was put, until Nest nests again with the new counts. Until then
// the change is kept per sheet (job.layoutEdits, like hand moves) and the parts
// list shows the new count (job.pendingQty: per part id { delta, add, remove }).
let partClip = null;   // { pl, group } copied in Move parts
let moveMsg = '';      // the last copy / paste / delete note, shown under the sheet
let screwMsg = '';     // where a screw went, when it snapped
let tabMsg = '';       // the last tab note
const pendingOf = (p) => job.pendingQty?.[partKey(p)]?.delta || 0;
const effQty = (p) => Math.max(0, (p.qty || 0) + pendingOf(p));
function sheetEdits(item) {
  job.layoutEdits = job.layoutEdits || {};
  const m = (job.layoutEdits[item.mkey] = job.layoutEdits[item.mkey] || {});
  return (m[item.idx] = m[item.idx] || { removed: [], added: [] });
}
function pend(partId, delta, add, remove) {
  job.pendingQty = job.pendingQty || {};
  const q = (job.pendingQty[partId] = job.pendingQty[partId] || { delta: 0, add: [], remove: [] });
  q.delta += delta;
  if (add) q.add.push(add);
  if (remove) {
    const k = q.add.findIndex((a) => a.label === remove.label);
    if (k >= 0) q.add.splice(k, 1); else q.remove.push(remove);
  }
  if (!q.delta && !q.add.length && !q.remove.length) delete job.pendingQty[partId];
}
function deletePlaced(item, pl) {
  const ed = sheetEdits(item);
  if (pl.added) ed.added = ed.added.filter((a) => !(a.partId === partKey(pl.part) && a.copy === pl.copy));
  else ed.removed.push(moveKey(pl));
  pend(partKey(pl.part), -1, null, { label: pl.label || pl.part.name, cabinet: pl.cabinet ?? pl.part.cabinet });
  moveMsg = `Deleted ${pl.label || pl.part.name} (its spot stays empty until Nest nests again).`;
  renderParts();
  refreshSheet(item);
}
function pastePlaced(item, spot) {
  const src = partClip.pl;
  const name = src.label || src.part.name;
  if (partClip.group !== item.group.key) {
    moveMsg = `!${name} is ${partClip.group}: paste it on a sheet of that material.`;
    renderResults();
    return;
  }
  const ed = sheetEdits(item);
  const taken = new Set(item.sheet.placements.filter((q) => partKey(q.part) === partKey(src.part)).map((q) => q.copy).concat(ed.added.filter((a) => a.partId === partKey(src.part)).map((a) => a.copy)));
  let copy = 1001;
  while (taken.has(copy)) copy++;
  const base = name.replace(/ copy( \d+)?$/, '');
  const all = new Set(job.parts.flatMap((p) => p.sourceNames || [p.name]).concat(Object.values(job.pendingQty || {}).flatMap((q) => q.add.map((a) => a.label))));
  let label = `${base} copy`;
  for (let n = 2; all.has(label); n++) label = `${base} copy ${n}`;
  const cand = copyAt(src, spot.x, spot.y, { copy, label });
  const sh = item.sheet;
  const tmp = { ...sh, placements: [...sh.placements, cand] };
  const screws = screwsShown(item.cfg, sh) ? sh.screws || [] : [];
  const f = moveRoom(tmp, tmp.placements.length - 1, { gap: (q) => partGap(item.cfg, cand, q), screws, screwClear: screwR(item.cfg.screws || {}) + item.cfg.tool.dia }).fit(0, 0);
  if (!f.ok) {
    moveMsg = `!No room for another ${base} on this sheet. Delete or move parts to make room, or add it in the parts list and nest again.`;
    renderResults();
    return;
  }
  const at2 = { ...cand, x: cand.x + f.dx, y: cand.y + f.dy, ...(cand.xf ? { xf: { ...cand.xf, tx: cand.xf.tx + f.dx, ty: cand.xf.ty + f.dy }, box: { x0: cand.box.x0 + f.dx, y0: cand.box.y0 + f.dy, x1: cand.box.x1 + f.dx, y1: cand.box.y1 + f.dy } } : {}) };
  ed.added.push({ partId: partKey(src.part), copy, label, cabinet: src.cabinet ?? src.part.cabinet, x: +at2.x.toFixed(4), y: +at2.y.toFixed(4), rotated: !!at2.rotated,
    ...(at2.xf ? { xf: at2.xf, box: at2.box, angle: at2.angle, mirror: at2.mirror } : {}) });
  pend(partKey(src.part), +1, { label, cabinet: src.cabinet ?? src.part.cabinet });
  moveMsg = `Pasted ${label}${f.snapped ? ' (moved to the nearest spot where it fits)' : ''}.`;
  renderParts();
  refreshSheet(item);
}
// before nesting again: the new counts become the parts' quantities (and their names)
function commitPending() {
  const pq = job.pendingQty || {};
  for (const [k, q] of Object.entries(pq)) {
    const p = job.parts.find((x) => partKey(x) === k);
    if (!p) continue;
    const named = p.sourceNames && p.sourceNames.length === p.qty;
    if (named) {
      for (const r of q.remove) {
        const k = p.sourceNames.lastIndexOf(r.label);
        if (k >= 0) { p.sourceNames.splice(k, 1); p.sourceCabinets?.splice(k, 1); }
      }
      for (const a of q.add) { p.sourceNames.push(a.label); if (p.sourceCabinets) p.sourceCabinets.push(a.cabinet); }
    }
    p.qty = Math.max(0, p.qty + q.delta);
  }
  const had = Object.keys(pq).length;
  delete job.pendingQty;
  delete job.layoutEdits;
  if (had) delete job.manualMoves;
  return had;
}
// items: [text, fn, { disabled, title }?] or null for a line between groups
function showMenu(x, y, items) {
  document.querySelector('#ctxMenu')?.remove();
  const m = document.createElement('div');
  m.id = 'ctxMenu';
  m.className = 'ctx-menu';
  const done = () => { m.remove(); removeEventListener('pointerdown', close, true); removeEventListener('keydown', close, true); };
  for (const it of items) {
    if (!it) { if (m.lastChild && m.lastChild.tagName !== 'HR') m.appendChild(document.createElement('hr')); continue; }
    const [text, fn, o = {}] = it;
    const b = document.createElement('button');
    b.textContent = text;
    b.disabled = !!o.disabled;
    if (o.title) b.title = o.title;
    b.onclick = () => { done(); fn(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  const close = (ev) => {
    if (m.contains(ev.target) && ev.key !== 'Escape') return;
    done();
    // a press on the menu's own button closes it; the click that follows mustn't reopen it
    if (m.dataset.for && ev.target?.closest?.(`#${m.dataset.for}`)) lastMenuClose = { id: m.dataset.for, at: Date.now() };
  };
  setTimeout(() => { addEventListener('pointerdown', close, true); addEventListener('keydown', close, true); });
}
// a menu dropping from a button (clicking the button again closes it)
let lastMenuClose = { id: null, at: 0 };
function showMenuAt(btn, items) {
  if (lastMenuClose.id === btn.id && Date.now() - lastMenuClose.at < 1000) { lastMenuClose = { id: null, at: 0 }; return; }   // that press closed it
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
  const m = document.querySelector('#ctxMenu');
  m.dataset.for = btn.id;
  const w = m.getBoundingClientRect().width;
  m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
}

// Drag a part: it follows the mouse, red where it can't go, with a dashed
// outline where it will land (the nearest spot that fits); dropping it there
// redoes the sheet's toolpath.
function wireMoveEdit(item, svgEl, fy) {
  const sh = item.sheet;
  const at = (e) => {
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    return { x: p.x, y: fy(p.y) };
  };
  const current = () => {
    const m = {};
    for (const pl of sh.placements) if (pl.moved) m[moveKey(pl)] = { x: +pl.x.toFixed(4), y: +pl.y.toFixed(4), ...(pl.turned ? { a: +pl.xf.a.toFixed(3) } : {}) };
    return m;
  };
  // the angle a custom shape can be turned to, nearest the one wanted: grain along
  // or across the part allows a half turn only (the grain still runs the same
  // way); free grain turns in the custom-shape step (Shift: any whole degree)
  const snapTurn = (pl, want, free) => {
    const norm = (a) => ((a % 360) + 360) % 360;
    const grain = job.settings.respectGrain !== false ? pl.part.grain : 'none';
    const pick = (list) => list.reduce((b, a) => (Math.abs(((norm(want - a) + 180) % 360) - 180) < Math.abs(((norm(want - b) + 180) % 360) - 180) ? a : b));
    if (grain === 'length') return pick([0, 180]);
    if (grain === 'width') return pick([90, 270]);
    const step = free ? 1 : (job.settings.shapeStep || 15);
    return norm(Math.round(want / step) * step);
  };
  // drop a turn: the turned part where it is, or the nearest spot it fits
  const endTurn = (d) => {
    if (Math.abs(((d.deg - d.a0 + 540) % 360) - 180) < 1e-6) { renderResults(); return; }
    const t = turnTo(d.pl, d.deg);
    const trial = { ...sh, placements: sh.placements.map((q, k) => (k === d.i ? t : q)) };
    const room = moveRoom(trial, d.i, { gap: (q) => partGap(item.cfg, t, q), screws: d.screws, screwClear: screwR(item.cfg.screws || {}) + item.cfg.tool.dia });
    const f = room.fit(0, 0);
    if (!f.ok) { moveMsg = `!No room to turn ${d.pl.label || d.pl.part.name} to ${Math.round(d.deg)}° near there.`; renderResults(); return; }
    moveMsg = f.snapped ? `Turned to ${Math.round(d.deg)}° and moved to the nearest spot where it fits.` : `Turned to ${Math.round(d.deg)}°.`;
    const m = current();
    m[moveKey(d.pl)] = { x: +(t.x + f.dx).toFixed(4), y: +(t.y + f.dy).toFixed(4), a: +d.deg.toFixed(3) };
    setSheetMoves(item, m);
  };
  let drag = null;
  svgEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const g = e.target.closest('g.pl');
    const pl = g ? sh.placements[+g.dataset.i] : null;
    const spot = at(e);
    const items = [];
    if (pl) {
      items.push([`Copy ${pl.label || pl.part.name}`, () => { partClip = { pl, group: item.group.key }; moveMsg = `Copied ${pl.label || pl.part.name}: right-click where you want it and Paste.`; renderResults(); }]);
      items.push([`Delete ${pl.label || pl.part.name}`, () => deletePlaced(item, pl)]);
      if (pl.moved) items.push(['Put back where the nest had it', () => { const m = current(); delete m[moveKey(pl)]; setSheetMoves(item, m); }]);
    }
    if (partClip) items.push([`Paste ${partClip.pl.label || partClip.pl.part.name}`, () => pastePlaced(item, spot)]);
    if (items.length) showMenu(e.clientX, e.clientY, items);
  });
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hd = e.target.closest('g.rot-handle');
    const g = hd ? svgEl.querySelector(`g.pl[data-i="${hd.dataset.i}"]`) : e.target.closest('g.pl');
    if (!g) return;
    e.preventDefault();
    const i = +g.dataset.i;
    const pl = sh.placements[i];
    const screws = screwsShown(item.cfg, sh) ? sh.screws || [] : [];
    if (hd && pl.xf) {
      // turning a custom shape: about the middle of its box, in the steps its grain allows
      const c = { x: (pl.box.x0 + pl.box.x1) / 2, y: (pl.box.y0 + pl.box.y1) / 2 };
      const p0 = at(e);
      g.parentNode.appendChild(g);
      drag = { turn: true, i, pl, g, hd, c, a0: pl.xf.a, ang0: (Math.atan2(p0.y - c.y, p0.x - c.x) * 180) / Math.PI, deg: pl.xf.a, screws };
      svgEl.setPointerCapture(e.pointerId);
      return;
    }
    const room = moveRoom(sh, i, { gap: (q) => partGap(item.cfg, pl, q), screws, screwClear: screwR(item.cfg.screws || {}) + item.cfg.tool.dia });
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    ghost.setAttribute('class', 'ghost');
    ghost.setAttribute('points', g.querySelector('polygon.part').getAttribute('points'));
    ghost.style.display = 'none';
    svgEl.appendChild(ghost);
    g.parentNode.appendChild(g);   // on top while it moves
    drag = { i, pl, g, room, start: at(e), fit: null, ghost };
    svgEl.setPointerCapture(e.pointerId);
  });
  // one update per frame however fast the mouse reports (flushed on release)
  const onMove = perFrame((e) => {
    if (!drag) return;
    const p = at(e);
    if (drag.turn) {
      const ang = (Math.atan2(p.y - drag.c.y, p.x - drag.c.x) * 180) / Math.PI;
      drag.deg = snapTurn(drag.pl, drag.a0 + ang - drag.ang0, e.shiftKey);
      drag.g.setAttribute('transform', `rotate(${-(drag.deg - drag.a0)} ${drag.c.x} ${fy(drag.c.y)})`);
      drag.hd.setAttribute('transform', `rotate(${-(drag.deg - drag.a0)} ${drag.c.x} ${fy(drag.c.y)})`);
      return;
    }
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    drag.g.setAttribute('transform', `translate(${dx} ${-dy})`);
    const f = drag.room.fit(dx, dy);
    drag.fit = f;
    drag.g.classList.toggle('bad', !f.ok || f.snapped);
    drag.ghost.style.display = f.ok && f.snapped ? '' : 'none';
    if (f.ok && f.snapped) drag.ghost.setAttribute('transform', `translate(${f.dx} ${-f.dy})`);
  });
  svgEl.addEventListener('pointermove', onMove);
  const end = () => {
    onMove.flush();
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.turn) { endTurn(d); return; }
    d.ghost.remove();
    const f = d.fit;
    if (!f || !f.ok || Math.hypot(f.dx, f.dy) < 0.005) { renderResults(); return; }
    const m = current();
    m[moveKey(d.pl)] = { x: +(d.pl.x + f.dx).toFixed(4), y: +(d.pl.y + f.dy).toFixed(4) };
    setSheetMoves(item, m);
  };
  svgEl.addEventListener('pointerup', end);
  svgEl.addEventListener('pointercancel', end);
}

// Click to add a screw, drag to move one, right-click to remove one. While
// dragging the ring turns red against the current toolpath; dropping redoes
// the sheet's toolpath and checks again.
function wireScrewEdit(item, svgEl, fy) {
  const sh = item.sheet;
  const at = (e) => {
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    return { x: Math.round(p.x * 100) / 100, y: Math.round(fy(p.y) * 100) / 100 };
  };
  const list = () => (sh.screws || []).map((q) => ({ x: q.x, y: q.y }));
  // screws snap to the nearest spot clear of every cut and on the stock
  let roomC = null;
  const room = () => {
    if (!roomC) {
      const toolR = item.cfg.tool.dia / 2;
      const lines = item.cfg.remnants?.cutFree ? (sh.offcuts || []).flatMap((oc) => offcutCutLines(oc, sh.w, sh.h, toolR).map((l) => (l.closed ? [...l.pts, l.pts[0]] : l.pts))) : [];
      roomC = screwRoom(sh, { clear: screwR(item.cfg.screws || {}), head: (item.cfg.screws?.head || 0.375) / 2, toolR, lines });
    }
    return roomC;
  };
  const snapNote = (f) => { if (!f.ok) { screwMsg = '!No room for a screw anywhere near there.'; } else screwMsg = f.snapped ? 'Moved to the nearest spot clear of the cuts.' : ''; };
  let drag = null;
  svgEl.addEventListener('contextmenu', (e) => {
    const g = e.target.closest('g.screw');
    e.preventDefault();
    if (!g) return;
    const l = list();
    l.splice(+g.dataset.k, 1);
    setSheetScrews(item, l);
  });
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = e.target.closest('g.screw');
    const l = list();
    let k;
    if (g) k = +g.dataset.k;
    else {
      const p = at(e), f = room().fit(p.x, p.y);
      snapNote(f);
      if (f.ok) { l.push({ x: f.x, y: f.y }); setSheetScrews(item, l); } else renderResults();
      return;
    }
    drag = { k, l, g, moved: false };
    svgEl.setPointerCapture(e.pointerId);
  });
  // one update per frame however fast the mouse reports (flushed on release)
  const onMove = perFrame((e) => {
    if (!drag) return;
    const m = at(e), f = room().fit(m.x, m.y);
    const p = f.ok ? { x: f.x, y: f.y } : m;
    drag.l[drag.k] = p;
    drag.f = f;
    drag.moved = true;
    drag.g.setAttribute('transform', `translate(${p.x} ${fy(p.y)})`);
    const c = item.tp ? screwCheck({ ...sh, screws: [p] }, item.tp.moves, item.cfg)[0] : { ok: true };
    drag.g.classList.toggle('bad', !c.ok);
  });
  svgEl.addEventListener('pointermove', onMove);
  const end = () => {
    onMove.flush();
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    snapNote(d.f || { ok: true });
    if (d.f && !d.f.ok) { renderResults(); return; }   // nowhere near: it stays where it was
    setSheetScrews(item, d.l);
  };
  svgEl.addEventListener('pointerup', end);
  svgEl.addEventListener('pointercancel', end);
}

// ---------- labels ----------
const labelOpts = () => ({ w: 2, h: 1, dpi: 203, ...job.settings.labels });
const today = () => new Date().toLocaleDateString();

function labelsFor(item) {
  const r = results.find((x) => x.sheets.includes(item));
  const fulls = r.sheets.filter((y) => !y.sheet.remnant);
  const sheetLabel = item.sheet.remnant ? `Remnant R${item.sheet.remnant.no ?? '?'}` : `Sheet ${fulls.indexOf(item) + 1} of ${fulls.length}`;
  const remnantNos = (item.sheet.offcuts || []).map((_, k) => job.cut?.added?.find((a) => a.sheetFile === item.file && a.k === k)?.no ?? null);
  return sheetLabels(item, { job: job.name || 'Job', sheetLabel: `${sheetLabel}`, date: today(), remnantNos }, labelOpts());
}

function renderLabels() {
  const panel = $('#labelsPanel');
  if (panel.hidden) return;
  const all = results.flatMap((r) => r.sheets);
  const item = all[activeSheet];
  if (!item) { $('#labelStrip').innerHTML = ''; return; }
  const lbs = labelsFor(item);
  $('#labelStrip').innerHTML = lbs.map((lb) => labelSVG(lb, labelOpts())).join('');
  const total = all.reduce((a, x) => a + labelsFor(x).length, 0);
  const o = labelOpts();
  $('#lblNote').textContent = `${lbs.length} labels on this sheet · ${total} for all ${all.length} sheets · ${o.w}" × ${o.h}" at ${o.dpi} dpi`;
  $('#lblSheet').textContent = o.mode === 'download' ? 'Download this sheet' : 'Print this sheet';
  $('#lblAll').textContent = o.mode === 'download' ? 'Download all sheets' : 'Print all sheets';
}

async function sendLabels(labels, file) {
  const o = labelOpts();
  const zpl = toZPL(labels, o);
  if (o.mode === 'download') { download(file, zpl); return; }
  await api('/api/print', { method: 'POST', body: JSON.stringify({ zpl, mode: o.mode, host: o.host, share: o.share }) });
  showMessages([{ text: `Sent ${labels.length} label${labels.length === 1 ? '' : 's'} to the printer.` }]);
}

// ---------- printed sheet layouts ----------
function layoutPage(item) {
  const r = results.find((x) => x.sheets.includes(item));
  const fulls = r.sheets.filter((y) => !y.sheet.remnant);
  const sh = item.sheet;
  const heading = sh.remnant ? `Remnant R${sh.remnant.no ?? '?'}` : `Sheet ${fulls.indexOf(item) + 1} of ${fulls.length}`;
  const sub = `${r.group.material} @ ${f3(r.group.thickness)}"  ·  ${sh.placements.length} parts  ·  ${(sh.yield * 100).toFixed(0)}% yield  ·  ${item.file}`;
  const note = sh.remnant ? `Put the remnant's zero corner at the origin, grain along X (${fraction(sh.w)} × ${fraction(sh.h)}).` : '';
  const remnantNos = (sh.offcuts || []).map((_, k) => job.cut?.added?.find((a) => a.sheetFile === item.file && a.k === k)?.no ?? null);
  return { item, heading, sub, note, remnantNos };
}

// ---------- print preview ----------
// Every printout (sheet layouts, construction sheets, cut list) opens here first:
// the pages as they'll come out of the printer, then Print… for the printer
// dialog. The document's own pages are <section class="page">; the preview only
// adds screen styles, so what prints is unchanged.
const PAPER = { landscape: [11, 8.5], portrait: [8.5, 11] };
let ppOrient = 'landscape';
function previewStyle(orient, margin) {
  const [w, h] = PAPER[orient];
  return `@media screen {
    html { background: #5f6368; }
    body { margin: 0 !important; padding: 20px 0 !important; }
    .page { width: ${w}in; min-height: ${h}in; margin: 0 auto 20px !important; padding: ${margin}in; background: #fff;
      box-shadow: 0 2px 12px rgba(0,0,0,.45); box-sizing: border-box; }
  }`;
}
function fitPreview() {
  const frame = $('#ppFrame');
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  const [w, h] = PAPER[ppOrient];
  const v = $('#ppZoom').value;
  const z = v === 'fit' ? (frame.clientWidth - 40) / (w * 96)
    : v === 'page' ? Math.min((frame.clientWidth - 40) / (w * 96), (frame.clientHeight - 40) / (h * 96))
    : +v;
  doc.body.style.zoom = String(Math.max(0.2, Math.min(z, 2)));
}
// Desktop app: the preview is a real PDF made by the app (true page breaks),
// with Save PDF, a paper size and a printer remembered per kind of printout.
// In a browser it's the pages drawn on screen and the browser's print dialog.
let pp = null;   // { html, title, orient, margin, kind, id, url }

async function renderPdf() {
  const cur = pp;
  if (!cur) return;
  $('#ppPages').textContent = 'making PDF…';
  if (cur.id) { desk.closePdf(cur.id); cur.id = null; }
  cur.doc?.destroy();
  cur.doc = null;
  try {
    const r = await desk.makePdf(cur.html, { paper: $('#ppPaper').value, orient: cur.orient, margin: cur.margin });
    if (pp !== cur) { desk.closePdf(r.id); return; }   // closed or replaced meanwhile
    cur.id = r.id;
    cur.pdf = r.pdf;
    await drawPdf(cur);
    $('#ppPages').textContent = `${r.pages} page${r.pages === 1 ? '' : 's'} · ${$('#ppPaper').value} ${cur.orient}`;
  } catch (e) {
    $('#ppPages').textContent = `couldn't make the PDF: ${e?.message || e}`;
  }
}

// pdf.js (public/lib/vendor/pdfjs) draws the PDF's pages: what's shown is the
// file that prints / saves, page breaks and all
let pdfjsLib = null;
async function pdfLib() {
  if (!pdfjsLib) {
    pdfjsLib = await import('./lib/vendor/pdfjs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjsLib;
}
async function drawPdf(cur) {
  const lib = await pdfLib();
  if (!cur.doc) cur.doc = await lib.getDocument({ data: cur.pdf.slice() }).promise;
  if (pp !== cur) return;
  const box = $('#ppDoc');
  const first = (await cur.doc.getPage(1)).getViewport({ scale: 1 });   // points
  const v = $('#ppZoom').value;
  const fitW = (box.clientWidth - 60) / first.width;
  const fitP = Math.min(fitW, (box.clientHeight - 40) / first.height);
  const scale = Math.max(0.2, v === 'fit' ? fitW : v === 'page' ? fitP : (+v * 96) / 72);
  const dpr = window.devicePixelRatio || 1;
  const canvases = [];
  for (let i = 1; i <= cur.doc.numPages; i++) {
    const page = await cur.doc.getPage(i);
    const vp = page.getViewport({ scale: scale * dpr });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    c.style.width = `${Math.round(vp.width / dpr)}px`;
    c.style.height = `${Math.round(vp.height / dpr)}px`;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (pp !== cur) return;
    canvases.push(c);
  }
  const top = box.scrollTop;
  box.replaceChildren(...canvases);
  box.scrollTop = top;
}

async function fillPrinters(kind) {
  const sel = $('#ppPrinter');
  const want = deskPrefs().printers?.[kind] || '';
  let list = [];
  try { list = await desk.printers(); } catch { /* none listed */ }
  sel.innerHTML = `<option value="">Ask each time (Windows print dialog)</option>` +
    list.map((p) => `<option value="${esc(p.name)}">${esc(p.label)}${p.isDefault ? ' (default)' : ''}</option>`).join('');
  sel.value = list.some((p) => p.name === want) ? want : '';
}

function printPreview(html, { title = 'Print preview', orient = 'landscape', margin = 0.4, kind = 'layouts' } = {}) {
  if (pp?.id) desk?.closePdf(pp.id);
  pp?.doc?.destroy();
  pp = { html, title, orient, margin, kind };
  ppOrient = orient;
  const frame = $('#ppFrame');
  $('#ppTitle').textContent = title;
  $('#ppPages').textContent = '';
  for (const el of document.querySelectorAll('#printPreview .pp-desk')) el.hidden = !desk;
  frame.hidden = !!desk;
  $('#ppDoc').hidden = !desk;
  $('#ppDoc').replaceChildren();
  $('#printPreview').hidden = false;
  if (desk) {
    $('#ppPaper').value = deskPrefs().paper?.[kind] || 'Letter';
    $('#ppPrint').textContent = 'Print';
    fillPrinters(kind);
    frame.onload = null;
    renderPdf();
    return;
  }
  frame.removeAttribute('src');
  frame.onload = () => {
    const doc = frame.contentDocument;
    const st = doc.createElement('style');
    st.textContent = previewStyle(orient, margin);
    doc.head.appendChild(st);
    const n = doc.querySelectorAll('.page').length;
    $('#ppPages').textContent = n ? `${n} page${n === 1 ? '' : 's'} · ${orient}` : '';
    fitPreview();
  };
  frame.srcdoc = html;
}
const closePreview = () => {
  if (pp?.id) desk?.closePdf(pp.id);
  pp?.doc?.destroy();
  pp = null;
  $('#ppDoc').replaceChildren();
  $('#printPreview').hidden = true;
  $('#ppFrame').removeAttribute('src');
  $('#ppFrame').srcdoc = '';
};
$('#ppClose').onclick = closePreview;
$('#ppPrint').onclick = async () => {
  if (!desk) { const w = $('#ppFrame').contentWindow; w.focus(); w.print(); return; }
  if (!pp?.id) return;
  const btn = $('#ppPrint');
  btn.disabled = true;
  const printer = $('#ppPrinter').value;
  const r = await desk.printPdf(pp.id, { deviceName: printer, copies: +$('#ppCopies').value || 1 });
  btn.disabled = false;
  if (r.ok) $('#ppPages').textContent = printer ? `sent to ${$('#ppPrinter').selectedOptions[0].textContent}` : $('#ppPages').textContent;
  else if (r.error && !/cancel/i.test(r.error)) showMessages([{ error: true, text: `Printing failed: ${r.error}` }]);
};
$('#ppSave').onclick = async () => {
  if (!pp?.pdf) return;
  const name = `${(job.name || 'Job').replace(/[^\w -]+/g, '_').slice(0, 60)} - ${pp.title.replace(/\s*\(.*\)$/, '')}.pdf`;
  const r = await desk.savePdf(pp.pdf, name);
  if (r.saved) $('#ppPages').textContent = `saved ${r.path}`;
};
$('#ppPaper').onchange = () => {
  if (!pp) return;
  setDeskPrefs({ paper: { ...deskPrefs().paper, [pp.kind]: $('#ppPaper').value } });
  renderPdf();
};
$('#ppPrinter').onchange = () => { if (pp) setDeskPrefs({ printers: { ...deskPrefs().printers, [pp.kind]: $('#ppPrinter').value } }); };
const rezoom = () => { if ($('#printPreview').hidden) return; if (desk) { if (pp?.doc) drawPdf(pp); } else fitPreview(); };
$('#ppZoom').onchange = rezoom;
let rezoomTimer = 0;
window.addEventListener('resize', () => { clearTimeout(rezoomTimer); rezoomTimer = setTimeout(rezoom, 150); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#printPreview').hidden) closePreview(); });

function printLayouts(items) {
  const html = layoutsHTML(items.map(layoutPage), job.name || 'Job');
  printPreview(html, { title: items.length === 1 ? 'Sheet layout' : `Sheet layouts (${job.name || 'Job'})` });
}
// Print: everything that goes on paper, in one menu
$('#printMenuBtn').onclick = (e) => {
  const item = thisSheet();
  const cut = cutListRows(runParts().filter((p) => p.qty > 0)).length > 0;
  showMenuAt(e.currentTarget, [
    ['Sheet layouts (all sheets)', () => printLayouts(allSheets())],
    ["This sheet's layout", () => printLayouts([item]), { disabled: !item }],
    ['Construction sheets', () => printConstruction()],
    ['Labels…', () => { $('#labelsPanel').hidden = false; renderLabels(); $('#labelsPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }],
    null,
    ['Cut list', () => $('#cutListPrint').click(), { disabled: !cut, title: cut ? '' : 'No parts on the cut list (parts not cut on the CNC)' }],
    ['Cut list as CSV', () => $('#cutListCsv').click(), { disabled: !cut }],
  ]);
};

// ---------- construction sheets (one page per cabinet, for assembly) ----------
function printConstruction() {
  if (!job.places?.length) {
    showMessages([{ error: true, text: job.parts?.length
      ? 'Construction sheets need where each part sits in the model. Click Get parts again to read the Part Studio with this version.'
      : 'Get parts first.' }]);
    return;
  }
  // which sheet and number each nested part is on, as on the printed layouts
  const where = new Map();
  for (const r of results) {
    const fulls = r.sheets.filter((y) => !y.sheet.remnant);
    for (const item of r.sheets) {
      const name = item.sheet.remnant ? `R${item.sheet.remnant.no ?? '?'}` : `Sheet ${fulls.indexOf(item) + 1}`;
      for (const pl of item.sheet.placements) {
        const key = pl.label || pl.part.name;
        if (!where.has(key)) where.set(key, name);
      }
    }
  }
  const off = new Set(job.offCabinets || []);
  const cabinets = new Set(job.places.map((p) => p.cabinet).filter((c) => c && !off.has(c)));
  const html = constructionHTML(job.places, { job: job.name || 'Job', where, cabinets });
  if (!html) { showMessages([{ error: true, text: 'No cabinet parts to draw (only parts tagged with a cabinet are drawn).' }]); return; }
  printPreview(html, { title: `Construction sheets (${job.name || 'Job'})`, kind: 'construction' });
}

$('#lblSheet').onclick = (e) => busy(e.target, async () => {
  const item = results.flatMap((r) => r.sheets)[activeSheet];
  await sendLabels(labelsFor(item), item.file.replace(/\.[^.]+$/, '') + '_labels.zpl');
});
$('#lblAll').onclick = (e) => busy(e.target, async () => {
  const all = results.flatMap((r) => r.sheets);
  const stamp = (job.name || 'job').replace(/[^\w-]+/g, '_').slice(0, 40);
  await sendLabels(all.flatMap((x) => labelsFor(x)), `${stamp}_labels.zpl`);
});

// ---------- remnants ----------
async function loadRemnants() {
  try { remnants = await api('/api/remnants'); } catch { remnants = []; }
  renderRemnants();
}

function renderRemnants() {
  const avail = remnants.filter((r) => r.status === 'available');
  const groups = new Map();
  for (const r of avail.sort((a, b) => a.material.localeCompare(b.material) || b.w * b.h - a.w * a.h)) {
    const k = `${r.material} @ ${f3(r.thickness)}"`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const used = remnants.length - avail.length;
  $('#remnantList').innerHTML = (avail.length ? '' : '<p class="muted small">No remnants on the rack yet. Offcuts are added when you mark a job as cut.</p>') +
    [...groups].map(([k, list]) => `<div class="rg">${esc(k)}</div>` + list.map((r) =>
      `<div class="rm"><b>R${r.no}</b><span title="${r.rects?.length > 1 ? 'L-shaped: ' + r.rects.map((q) => `${fraction(q.w)} × ${fraction(q.h)}`).join(' + ') : ''}">${fraction(r.w)} × ${fraction(r.h)}${r.rects?.length > 1 ? ' L' : ''}</span><span class="muted" title="${esc(r.note || r.fromJobName || '')}">${esc(r.note || (r.fromJobName ? 'from ' + r.fromJobName : ''))}</span><button class="link mini" data-lbl="${esc(r.id)}" title="Label for this remnant">label</button><button class="link mini" data-del="${esc(r.id)}" title="Remove from the rack">✕</button></div>`).join('')).join('') +
    (used ? `<p class="muted small">${used} used up</p>` : '');
  const mats = new Set([...remnants.map((r) => r.material), ...job.parts.map((p) => p.material)]);
  $('#remMats').innerHTML = [...mats].map((m) => `<option value="${esc(m)}">`).join('');
}

$('#remnantList').addEventListener('click', async (e) => {
  const lid = e.target.closest('[data-lbl]')?.dataset.lbl;
  if (lid) {
    const r = remnants.find((x) => x.id === lid);
    try { await sendLabels([remnantLabel(r, today())], `R${r.no}_label.zpl`); } catch (err) { showMessages([{ error: true, text: err.message }]); }
    return;
  }
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  const r = remnants.find((x) => x.id === id);
  if (!confirm(`Remove R${r?.no} from the rack?`)) return;
  try { await api(`/api/remnants/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadRemnants(); }
  catch (err) { showMessages([{ error: true, text: err.message }]); }
});

$('#remMat').addEventListener('change', () => {
  const p = job.parts.find((x) => x.material === $('#remMat').value) || remnants.find((x) => x.material === $('#remMat').value);
  if (p && !$('#remT').value) $('#remT').value = p.thickness;
});

$('#remAdd').onclick = (e) => busy(e.target, async () => {
  const body = { material: $('#remMat').value.trim(), thickness: parseFloat($('#remT').value), w: parseFloat($('#remW').value), h: parseFloat($('#remH').value), note: $('#remNote').value };
  await api('/api/remnants', { method: 'POST', body: JSON.stringify(body) });
  for (const id of ['#remW', '#remH', '#remNote']) $(id).value = '';
  await loadRemnants();
});

function renderCutState() {
  const b = $('#markCut');
  if (job.cut) {
    const nos = (job.cut.added || []).map((a) => 'R' + a.no);
    b.textContent = 'Undo "cut"';
    b.title = `Marked as cut ${new Date(job.cut.at).toLocaleString()}` + (nos.length ? `; new remnants ${nos.join(', ')}` : '');
  } else {
    b.textContent = 'Mark as cut…';
    b.title = 'Uses up the remnants this job was nested on and keeps its offcuts as new remnants';
  }
}

$('#markCut').onclick = async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
  if (job.cut) {
    if (!confirm('Undo "cut"? The remnants it used go back on the rack and the offcuts it added are removed (unless another job has used them).')) return;
    const r = await api('/api/remnants/uncut', { method: 'POST', body: JSON.stringify({ used: job.cut.used, added: job.cut.added.map((a) => a.id) }) });
    if (r.kept?.length) showMessages([{ text: `${r.kept.length} of its offcuts were already used by another job and were left in place.` }]);
    job.cut = null;
  } else {
    const usedN = results.flatMap((r) => r.sheets).filter((x) => x.sheet.remnant).length;
    const keepN = results.flatMap((r) => r.sheets).reduce((a, x) => a + (x.sheet.offcuts?.length || 0), 0);
    if (!confirm(`Mark this job as cut?\n\n${usedN ? `The ${usedN} remnant${usedN === 1 ? '' : 's'} it was nested on come${usedN === 1 ? 's' : ''} off the rack. ` : ''}${keepN ? `Its ${keepN} offcut${keepN === 1 ? '' : 's'} to keep go${keepN === 1 ? 'es' : ''} on the rack as new remnants. ` : ''}The layout is then fixed. You can undo this.${results.quick ? '\n\nThis is a quick nest, not a searched one.' : ''}`)) return;
    const all = results.flatMap((r) => r.sheets);
    const used = [...new Set(all.filter((x) => x.sheet.remnant).map((x) => x.sheet.remnant.id))];
    const add = [], where = [];
    for (const x of all) (x.sheet.offcuts || []).forEach((oc, k) => {
      add.push({ material: x.group.material, thickness: x.group.thickness, w: oc.w, h: oc.h,
        ...(oc.rects?.length > 1 ? { rects: oc.rects.map((q) => ({ x: q.x - oc.x, y: q.y - oc.y, w: q.w, h: q.h })) } : {}) });
      where.push({ sheetFile: x.file, k });
    });
    const r = await api('/api/remnants/cut', { method: 'POST', body: JSON.stringify({ jobId: job.id, jobName: job.name, used, add }) });
    if (r.conflicts?.length) showMessages([{ error: true, text: `${r.conflicts.length} remnant(s) this job was nested on were already used or removed — check the rack.` }]);
    job.cut = { at: new Date().toISOString(), used: used.filter((id) => !r.conflicts.includes(id)), added: r.added.map((a, i) => ({ id: a.id, no: a.no, ...where[i] })) };
  }
  await loadRemnants();
  if (job.id) { await api('/api/jobs', { method: 'POST', body: JSON.stringify(job) }); }
  else showMessages([{ text: 'Save the job so this "cut" stays with it.' }]);
  renderResults();
  } catch (err) { showMessages([{ error: true, text: err.message }]); }
  finally { btn.disabled = false; renderCutState(); }
};

// ---------- actions ----------
async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Working…';
  try { await fn(); } catch (e) { showMessages([{ error: true, text: e.message }]); }
  finally { btn.disabled = false; btn.textContent = label; }
}

$('#fetchParts').onclick = (e) => busy(e.target, async () => {
  const url = $('#osUrl').value.trim();
  if (!url) throw new Error('Paste a Part Studio URL first');
  setParts(await api('/api/extract', { method: 'POST', body: JSON.stringify({ url }) }));
  refreshStatus();
});
const jobStamp = () => (job.name || 'job').replace(/[^\w-]+/g, '_').slice(0, 40);
$('#cutListCsv').onclick = () => download(`${jobStamp()}_cutlist.csv`, cutListCSV(cutListRows(runParts().filter((p) => p.qty > 0))));
$('#cutListPrint').onclick = () => {
  printPreview(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(job.name || 'Cut list')}</title><style>
    @page{size:portrait;margin:0.5in}
    body{font:13px system-ui,sans-serif;margin:0;color:#111}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 14px;color:#555}
    table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:5px 8px;text-align:left}
    th{font-size:11px;text-transform:uppercase;color:#555}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
    table.cut-list th+th,table.cut-list td+td{border-left:1px solid #ccc}table.cut-list{border:1px solid #ccc}
    tr.group td{background:#eee;font-weight:600}.muted{color:#777}.small{font-size:11px}</style></head><body>
    <section class="page"><h1>Cut list — ${esc(job.name || '')}</h1><p>${new Date().toLocaleDateString()} · parts not cut on the CNC</p>
    ${cutListHtml(cutListRows(runParts().filter((p) => p.qty > 0)))}</section></body></html>`, { title: 'Cut list', orient: 'portrait', margin: 0.5, kind: 'cutlist' });
};
$('#saveRaw').onclick = () => {
  const name = (job.name || 'onshape').replace(/[^\w-]+/g, '_').slice(0, 40);
  download(`${name}_raw.json`, JSON.stringify(lastRaw, null, 1));
};
const loadSample = (btn) => busy(btn || $('#fetchParts'), async () => setParts(await api('/api/sample')));
$('#partsTable').addEventListener('click', (e) => { const b = e.target.closest('[data-sample]'); if (b) loadSample(b); });
// what the desktop app's Help menu asks for (electron/main.js)
window.cabinetCam = {
  loadSample: () => loadSample(),
  saveRaw: () => (lastRaw ? $('#saveRaw').click() : showMessages([{ text: 'No Onshape data yet: Get parts first.' }])),
};
$('#nestBtn').onclick = async () => { activeSheet = 0; await searchNests(false); $('#resultsCard').scrollIntoView({ behavior: 'smooth' }); };
$('#searchAgain').onclick = () => searchNests(true);
$('#updateSheets').onclick = () => searchNests(false);
$('#toolpathBtn').onclick = () => planAll();
$('#jobName').addEventListener('input', (e) => { job.name = e.target.value; });

$('#saveJob').onclick = (e) => busy(e.target, async () => {
  job.toolSnapshot = resolveTools(job.settings, library, job.toolSnapshot || []).snapshot;
  const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(job) });
  job.id = r.id;
  await refreshJobs();
  $('#openJob').value = job.id;
});

$('#openJob').onchange = async (e) => {
  if (!e.target.value) return;
  try {
    const j = await api(`/api/jobs/${encodeURIComponent(e.target.value)}`);
    job = { ...j, settings: mergeSettings(j.settings) };
    delete job.grainRules;   // per-type grain rules are gone: a part's own choice, then the model
    $('#jobName').value = job.name || '';
    $('#osUrl').value = job.source?.url || '';
    results = [];
    $('#resultsCard').hidden = true;
    showMessages([]);
    renderSettings();
    renderParts();
  } catch (err) { showMessages([{ error: true, text: err.message }]); }
};

// ---------- post files (.pp) ----------
// Vectric-format posts in this computer's posts folder; the job's post is
// 'pp:<file name>' when it's one of them.
let postFiles = [];             // [{ file, name, ext, error? }]
const parsedPosts = new Map();  // file -> parsed post
const postPP = (s) => (String(s.post).startsWith('pp:') ? parsedPosts.get(s.post.slice(3)) || null : null);

async function loadPosts() {
  try {
    const r = await api('/api/posts');
    postFiles = r.posts;
    $('#postInfo').dataset.folder = r.folder;
    parsedPosts.clear();
    await Promise.all(postFiles.filter((p) => !p.error).map(async (p) => {
      const t = await (await fetch('/api/posts/' + encodeURIComponent(p.file))).text();
      try { parsedPosts.set(p.file, parsePP(t)); } catch (e) { p.error = e.message; }
    }));
  } catch { postFiles = []; }
  $('#postFilesGroup').innerHTML = postFiles.map((p) => `<option value="pp:${esc(p.file)}"${p.error ? ' disabled' : ''}>${esc(p.name)}${p.error ? ' (unreadable)' : ''}</option>`).join('');
  renderSettings();
}

function renderPostInfo() {
  const s = job.settings;
  const isFile = String(s.post).startsWith('pp:');
  $('#postRemove').hidden = !isFile;
  const folder = $('#postInfo').dataset.folder || '';
  if (isFile) {
    const pp = postPP(s);
    $('#postInfo').textContent = pp ? `${s.post.slice(3)} · .${pp.ext} · ${pp.units === 'MM' ? 'millimetres' : 'inches'}${pp.warnings.length ? ' · ' + pp.warnings.join('; ') : ''}` : `${s.post.slice(3)} is missing from the posts folder`;
  } else $('#postInfo').textContent = folder ? `Post files folder: ${folder}` : '';
}

$('#postImport').onclick = () => $('#postFile').click();
$('#postFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  // most posts are plain ASCII; older ones may be Windows-1252
  let text = await f.text();
  if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(await f.arrayBuffer());
  try {
    const r = await api('/api/posts', { method: 'POST', body: JSON.stringify({ name: f.name, text }) });
    await loadPosts();
    job.settings.post = 'pp:' + r.file;
    rememberSettings();
    renderSettings();
    showMessages([{ text: `Post "${r.name}" added (${r.file}) and selected.`, items: r.warnings }]);
    markStale();
  } catch (err) { showMessages([{ error: true, text: err.message }]); }
};
$('#postRemove').onclick = async () => {
  const file = String(job.settings.post).slice(3);
  if (!confirm(`Remove the post file "${file}" from this computer's posts folder?`)) return;
  await api('/api/posts/' + encodeURIComponent(file), { method: 'DELETE' });
  job.settings.post = 'fluidnc';
  rememberSettings();
  await loadPosts();
  markStale();
};

async function loadLibrary() {
  try { library = await api('/api/tools'); } catch { /* offline: defaults */ }
  renderSettings();
}

renderSettings();
renderParts();
loadLibrary();
loadPosts();
loadRemnants();
refreshStatus();
refreshJobs();
