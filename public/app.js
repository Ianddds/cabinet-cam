import { DEFAULT_SETTINGS, groupParts, mergeSettings, holdDownOf, usesSkin, usesTabs } from './lib/settings.js';
import { carve, check, shade } from './lib/sim.js';
import { nestParts, applySolution, nestKey, placedGeometry, partExits, rectMinus } from './lib/nest.js';
import { placeShapes, isShapePart, labelPoint } from './lib/shapes.js';
import { sheetToolpaths, screwR, rectsOutline, screwCheck } from './lib/toolpath.js';
import { post, postWithWarnings, fileExtension, SBP_MAX_TOOL, toolNumberOk } from './lib/post.js';
import { parsePP } from './lib/vpp.js';
import { DEFAULT_LIBRARY, TOOL_FIELDS, newTool, resolveTools } from './lib/tools.js';
import { cutListRows, cutListCSV, fraction, roleName } from './lib/cutlist.js';
import { layoutsHTML } from './lib/printsheets.js';
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
let activeSheet = 0;
let screwEdit = false;  // sheet view: click to add a hold-down screw, drag to move, right-click to remove
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

let lastRaw = null;
function setParts(data) {
  lastRaw = data.raw || null;
  $('#saveRaw').hidden = !lastRaw;
  delete data.raw;
  const sameSource = job.source?.url && data.source?.url === job.source.url;
  job.parts = sameSource ? carryOverrides(job.parts, data.parts) : data.parts;
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
  if (results.length) runNest();
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
    wrap.innerHTML = '<p class="muted empty">Paste a Part Studio URL or load the sample.</p>';
    $('#nestBtn').disabled = true;
    $('#partsSummary').textContent = '';
    renderCabFilter();
    return;
  }
  renderCabFilter();
  const groups = groupParts(job.parts);
  let rows = '';
  for (const g of groups) {
    const count = g.parts.filter((p) => p.include).reduce((a, p) => a + (forRun(p).qty || 0), 0);
    rows += `<tr class="group"><td colspan="10">${esc(g.key)} — ${count} pcs</td></tr>`;
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
        <td><input class="qty" type="number" min="0" step="1" data-k="qty" value="${p.qty}">${runQty !== p.qty ? ` <span class="muted small" title="Copies in the cabinets ticked above">→ ${runQty}</span>` : ''}</td>
        <td class="num">${f3(p.width)}</td><td class="num">${f3(p.height)}</td><td class="num">${f3(p.thickness)}</td>
        <td>${grainCell(p)}</td>
        <td class="num">${p.pockets.length || ''}${p.holes.length ? ` / ${p.holes.length} cut` : ''}</td>
        <td>${warn}</td>
      </tr>`;
    }
  }
  wrap.innerHTML = `<table><thead><tr><th></th><th>Part</th><th>Cab</th><th>Qty</th><th>Length</th><th>Width</th><th>Thk</th><th>Grain</th><th>Dados</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  const total = runParts().filter((p) => p.include).reduce((a, p) => a + (p.qty || 0), 0);
  $('#partsSummary').textContent = `${job.parts.length} unique · ${total} pcs · ${groups.length} material group${groups.length === 1 ? '' : 's'}`;
  $('#nestBtn').disabled = total === 0;
  renderCutList();
}

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
  return `<table><thead><tr><th>Qty</th><th>Part</th><th>Length</th><th>Width</th><th>Thk</th><th>Cabinets</th><th>Decimal</th></tr></thead><tbody>${html}</tbody></table>`;
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
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const p = job.parts[+tr.dataset.i];
  const k = e.target.dataset.k;
  if (k === 'include') p.include = e.target.checked;
  if (k === 'qty') p.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  if (k === 'grain') p.grainOverride = e.target.value;
  renderParts();
  if (results.length) runNest();
});
$('#partsTable').addEventListener('click', (e) => {
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
  if (results.length) runNest();
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
  if (results.length) runNest();
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

document.querySelector('.side').addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.path) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') v = parseFloat(v);
  if (el.type === 'number' && Number.isNaN(v) && el.dataset.blank === 'null') v = null; // blank = use the default it names
  if (el.dataset.path === 'climb') v = v === 'true';
  setPath(job.settings, el.dataset.path, v);
  rememberSettings();
  renderSettings();
  if (results.length) runNest(); // keep previews in step with settings
});

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

$('#resetSettings').onclick = () => { job.settings = structuredClone(DEFAULT_SETTINGS); rememberSettings(); renderSettings(); };

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
// changed, a quick nest is shown until Nest & toolpath is clicked again.
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

// Custom shapes fitted by outline into a nest (kept per nest, as the fitting
// takes a moment and the page redraws often)
const shapeMemo = new Map();
function shapesFor(nest, g, nestOpts) {
  const shapes = g.parts.filter((p) => p.include && p.qty > 0 && isShapePart(p, nestOpts));
  if (!shapes.length) return nest;
  const key = JSON.stringify([nest.sheets.map((s) => [s.w, s.h, s.placements.map((pl) => [pl.part.id ?? pl.part.name, +pl.x.toFixed(3), +pl.y.toFixed(3), pl.rotated ? 1 : 0]), (s.screws || []).map((q) => [+q.x.toFixed(2), +q.y.toFixed(2)])]), shapes.map((p) => [p.id, p.name, p.qty, p.grain, p.width, p.height]), nestOpts.shapeStep, nestOpts.shapeFlip, nestOpts.respectGrain, nestOpts.spacing, nestOpts.sheetW, nestOpts.sheetH, nestOpts.trim, nestOpts.endTrim, nestOpts.screws]);
  // same layout as last time: reuse where the shapes went, with today's part objects
  const hit = shapeMemo.get(key);
  if (hit) return placeShapes(nest, g.parts, nestOpts, hit.spots);
  const out = placeShapes(nest, g.parts, nestOpts);
  shapeMemo.set(key, { spots: out.spots });
  if (shapeMemo.size > 40) shapeMemo.delete(shapeMemo.keys().next().value);
  return out;
}

// what a worker needs of a part
const slimPart = (p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, qty: p.qty, include: p.include, grain: p.grain, exits: partExits(p), shape: isShapePart(p, { shapeStep: job.settings.shapeStep ?? 15 }) });

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
  const groups = nestGroups();
  job.nests = job.nests || {};
  if (job.cut) { showMessages([{ text: 'This job is marked as cut, so its layout is fixed. Undo "cut" to nest it again.' }]); runNest(); return; }
  // search what has never been searched, or whose remnants on the rack changed
  const todo = groups.filter((x) => force || !job.nests[x.key]?.searched || stockSig(job.nests[x.key].stock) !== stockSig(x.stock));
  if (!todo.length) { runNest(); return; }
  const btns = [$('#nestBtn'), $('#searchAgain')];
  btns.forEach((b) => { b.disabled = true; });
  const t0 = Date.now();
  const best = {};
  const status = () => {
    const sheets = todo.map((x) => best[x.key]).filter((v) => v != null);
    $('#nestBtn').textContent = `Nesting… ${Math.round((Date.now() - t0) / 1000)}s` + (sheets.length ? ` · ${sheets.reduce((a, v) => a + v, 0)} full sheets` : '');
  };
  const timer = setInterval(status, 500);
  searching = Promise.all(todo.map((x) => searchGroup(x, force ? (Date.now() & 0xffff) + 1 : 12345, (p) => { best[x.key] = p.sheets; })
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
    $('#nestBtn').textContent = 'Nest & toolpath';
    btns.forEach((b) => { b.disabled = false; });
  }
  runNest();
}

function runNest() {
  const s = job.settings;
  const tl = resolveTools(s, library, job.toolSnapshot || []);
  const problems = settingsProblems(s, tl);
  if (problems.some((p) => p.includes('above zero') || p.startsWith('No profile tool'))) { showMessages([{ error: true, text: 'Fix tools:', items: problems }]); return; }
  results = [];
  if (String(s.post).startsWith('pp:') && !postPP(s)) { showMessages([{ error: true, text: `The post file "${s.post.slice(3)}" isn't in the posts folder any more — pick another post (Machine card).` }]); return; }
  const ext = fileExtension({ ...s, pp: postPP(s) });
  const stamp = (job.name || 'job').replace(/[^\w-]+/g, '_').slice(0, 40);
  let quick = false;
  const stockNotes = [];
  for (const { g, nestOpts, key, stock } of nestGroups()) {
    const kept = job.nests?.[key];
    let nest = null;
    if (kept) {
      nest = applySolution(g.parts, { ...nestOpts, remnants: kept.stock || [] }, kept.solution);
      // remnants it was nested on that have gone since (used by another job, deleted)
      const gone = job.cut ? [] : (kept.stock || []).filter((r) => !stock.some((x) => x.id === r.id));
      const usedGone = nest && gone.filter((r) => nest.sheets.some((sh) => sh.remnant?.id === r.id));
      if (usedGone?.length) { stockNotes.push(`${g.key}: remnant ${usedGone.map((r) => 'R' + r.no).join(', ')} is no longer on the rack — click Nest & toolpath to re-nest`); }
      else if (nest && stockSig(kept.stock) !== stockSig(stock) && !job.cut) stockNotes.push(`${g.key}: the remnants on the rack changed — Nest & toolpath will look at them`);
    }
    if (!nest) { nest = nestParts(g.parts, nestOpts); quick = true; }
    nest = shapesFor(nest, g, nestOpts);
    const cfg = { ...s, ...tl, thickness: g.thickness, ...(postPP(s) ? { pp: postPP(s) } : {}) };
    const mat = g.material.replace(/[^\w-]+/g, '_');
    const mkey = manualKey(key, kept);
    const sheets = nest.sheets.map((sheet, i) => {
      applyManualScrews(sheet, job.manualScrews?.[mkey]?.[i]);
      const tp = sheetToolpaths(sheet, cfg);
      const rno = sheet.remnant && (remnants.find((r) => r.id === sheet.remnant.id)?.no ?? nestOpts.remnants.find((r) => r.id === sheet.remnant.id)?.no ?? kept?.stock?.find((r) => r.id === sheet.remnant.id)?.no);
      sheet.remnant && (sheet.remnant.no = rno);
      const what = sheet.remnant ? `remnant R${rno ?? '?'}` : `sheet ${i + 1} of ${nest.sheets.length}`;
      const title = `${job.name || 'Job'} | ${g.key} | ${what}`;
      const chk = screwsShown(cfg, sheet) ? screwCheck(sheet, tp.moves, cfg) : [];
      const bad = chk.filter((c) => !c.ok).length;
      if (bad) stockNotes.push(`${g.key} ${what}: ${bad} hold-down screw${bad === 1 ? ' is' : 's are'} in a bad spot (red) — move ${bad === 1 ? 'it' : 'them'} before cutting`);
      if (s.screws?.on && !sheet.screwsManual && sheet.screwsMissing) stockNotes.push(`${g.key} ${what}: room for only ${sheet.screws.length} of 5 hold-down screws — hold the rest of the sheet another way`);
      if (s.screws?.on && !sheet.screwsManual && sheet.screwsInKeeper) stockNotes.push(`${g.key} ${what}: ${sheet.screwsInKeeper} hold-down screw${sheet.screwsInKeeper === 1 ? '' : 's'} had to go in the offcut being kept (no scrap in that part of the sheet) — it will have the hole${sheet.screwsInKeeper === 1 ? '' : 's'}`);
      return { sheet, tp, cfg, title, mkey, idx: i, screwChk: chk, file: `${stamp}_${mat}_${g.thickness.toFixed(3)}_${sheet.remnant ? 'R' + (rno ?? 'x') : 'S' + (i + 1)}.${ext}`, text: null, group: g };
    });
    results.push({ group: g, sheets, unplaced: nest.unplaced, lowerBound: nest.stats?.lowerBound });
  }
  results.quick = quick;
  const all = results.flatMap((r) => r.sheets);
  activeSheet = Math.min(activeSheet, Math.max(0, all.length - 1));
  const warnings = [...problems, ...stockNotes, ...new Set(all.flatMap((x) => x.tp.warnings))];
  const unplaced = results.flatMap((r) => r.unplaced.map((u) => `${u.name}: ${u.reason}`));
  showMessages([
    { error: true, text: unplaced.length ? 'Not placed:' : '', items: unplaced },
    { text: warnings.length ? 'Check before cutting:' : '', items: warnings },
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

// new screw list for one sheet (null = back to automatic): redo its toolpath
function setSheetScrews(item, list) {
  job.manualScrews = job.manualScrews || {};
  const m = (job.manualScrews[item.mkey] = job.manualScrews[item.mkey] || {});
  if (list) m[item.idx] = list.map((q) => ({ x: +q.x.toFixed(3), y: +q.y.toFixed(3) }));
  else delete m[item.idx];
  if (!Object.keys(m).length) delete job.manualScrews[item.mkey];
  applyManualScrews(item.sheet, list);
  item.tp = sheetToolpaths(item.sheet, item.cfg);
  item.screwChk = screwsShown(item.cfg, item.sheet) ? screwCheck(item.sheet, item.tp.moves, item.cfg) : [];
  item.text = null;
  item.sim = null;
  renderResults();
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
  const mins = all.reduce((a, x) => a + x.tp.stats.estMinutes, 0);
  const lb = results.reduce((a, r) => a + (r.lowerBound || 0), 0);
  const full = all.filter((x) => !x.sheet.remnant).length, rem = all.length - full;
  const keepN = all.reduce((a, x) => a + (x.sheet.offcuts?.length || 0), 0);
  $('#resultsSummary').textContent = `${full} sheet${full === 1 ? '' : 's'}` +
    (rem ? ` + ${rem} remnant${rem === 1 ? '' : 's'}` : '') +
    (lb && lb < full ? ` (area minimum ${lb})` : '') + ` · ~${Math.round(mins)} min cutting` +
    (keepN ? ` · ${keepN} offcut${keepN === 1 ? '' : 's'} to keep` : '') +
    (results.quick ? ' · quick nest: click Nest & toolpath to search for a better one' : '');
  renderCutState();
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
$('#showPaths').addEventListener('change', () => renderResults());
$('#showSim').addEventListener('change', () => renderResults());

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
$('#downloadAll').onclick = async () => {
  for (const x of results.flatMap((r) => r.sheets)) {
    download(x.file, textFor(x));
    await new Promise((r) => setTimeout(r, 350));
  }
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
  const st = item.tp.stats;
  const pad = 1.5;
  const H = s.sheetH;
  const fy = (y) => H - y; // machine Y up
  let svg = `<svg class="sheet-svg${screwEdit ? ' screw-edit' : ''}" viewBox="${-pad} ${-pad} ${s.sheetW + 2 * pad} ${H + 2 * pad}" xmlns="http://www.w3.org/2000/svg">`;
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
  const sim = $('#showSim').checked ? simulateSheet(item) : null;
  if (sim) svg += `<image href="${sim.url}" x="0" y="${H - sim.H}" width="${sim.W}" height="${sim.H}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`;
  for (const pl of item.sheet.placements) {
    const g = placedGeometry(pl);
    svg += `<polygon class="part${sim ? ' simmed' : ''}" points="${pts(flip(g.outline))}"><title>${esc(pl.label || pl.part.name)} ${f3(pl.part.width)} × ${f3(pl.part.height)}</title></polygon>`;
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
  }
  if ($('#showPaths').checked) {
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
  const simNote = !sim ? '' : sim.result.ok
    ? '<p class="small sim-ok">Simulated: every floor cut to depth, nothing deeper than the model' + (['tabs', 'none'].includes(holdDownOf(item.cfg)) ? ', every outline cut through except at tabs' : '') + '.</p>'
    : `<p class="small sim-bad">Simulated: ${[sim.result.uncut && `${sim.result.uncut} spots left uncut (yellow)`, sim.result.deep && `${sim.result.deep} spots cut deeper than the model (red)`, sim.result.notThrough && `${sim.result.notThrough} spots of outline not cut through (pink)`, sim.result.screw && `${sim.result.screw} spots cut inside a screw's clearance (blue)`].filter(Boolean).join(' · ')}. Check before cutting.</p>`;

  $('#sheetView').innerHTML = `
    <div class="sheet-head">
      <strong>${esc(item.title)}</strong>
      <span class="muted">${item.sheet.placements.length} parts · ${(item.sheet.yield * 100).toFixed(0)}% yield · ${st.cutLength.toFixed(0)}" of cut · ${st.rapidLength.toFixed(0)}" of rapids · ~${st.estMinutes.toFixed(0)} min</span>
      <span class="spacer"></span>
      <span class="legend"><span><i style="background:var(--path)"></i>cut</span><span><i style="background:var(--rapid)"></i>rapid</span><span><i style="background:var(--pocket)"></i>dado</span><span><i style="background:var(--drill)"></i>drill</span>${usesTabs(item.cfg) ? '<span><i style="background:var(--tab)"></i>tab</span>' : ''}</span>
      <button id="screwEditBtn" class="${screwEdit ? 'active' : ''}" title="Place hold-down screws by hand on this sheet: click to add, drag to move, right-click to remove">${screwEdit ? 'Done placing screws' : 'Place screws'}</button>
      <button id="printSheet">Print layout</button>
      <button id="dlSheet" class="primary">Download ${esc(item.file)}</button>
    </div>${svg}
    ${simNote}
    ${screwEdit ? `<p class="small screw-help">Placing screws: click an empty spot to add one, drag to move, right-click to remove. Red = a cut or part is too close. ${sh.screws?.length || 0} on this sheet${sh.screwsManual ? ' (placed by hand)' : ''}. <button id="screwAuto" ${sh.screwsManual ? '' : 'disabled'}>Back to automatic</button> <button id="screwClear" ${sh.screws?.length ? '' : 'disabled'}>Remove all</button></p>` : ''}
    ${sh.remnant ? `<p class="small"><strong>Remnant R${sh.remnant.no ?? '?'}</strong> (${fraction(sh.w)} × ${fraction(sh.h)}): put its zero corner (the one that was the sheet's zero corner) at the origin, grain along X.</p>` : ''}
    <p class="muted small">Origin (red dot) is front-left of the ${sh.remnant ? 'remnant' : 'sheet'}, X along the ${s.sheetW}" side. Z0 = ${item.cfg.zZero === 'table' ? 'spoilboard' : 'material top'}. Air-cut new posts before running material.</p>`;
  $('#dlSheet').onclick = () => download(item.file, textFor(item));
  $('#printSheet').onclick = () => printLayouts([item]);
  $('#screwEditBtn').onclick = () => { screwEdit = !screwEdit; renderResults(); };
  if (screwEdit) {
    $('#screwAuto').onclick = () => setSheetScrews(item, null);
    $('#screwClear').onclick = () => setSheetScrews(item, []);
    wireScrewEdit(item, $('#sheetView svg'), fy);
  }
  renderLabels();
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
    else { l.push(at(e)); setSheetScrews(item, l); return; }
    drag = { k, l, g, moved: false };
    svgEl.setPointerCapture(e.pointerId);
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = at(e);
    drag.l[drag.k] = p;
    drag.moved = true;
    drag.g.setAttribute('transform', `translate(${p.x} ${fy(p.y)})`);
    const c = screwCheck({ ...sh, screws: [p] }, item.tp.moves, item.cfg)[0];
    drag.g.classList.toggle('bad', !c.ok);
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) setSheetScrews(item, d.l);
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

function printLayouts(items) {
  const html = layoutsHTML(items.map(layoutPage), job.name || 'Job');
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  };
}
$('#printLayouts').onclick = () => printLayouts(results.flatMap((r) => r.sheets));

$('#labelsBtn').onclick = () => { $('#labelsPanel').hidden = !$('#labelsPanel').hidden; renderLabels(); };
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
    b.textContent = 'Mark job as cut';
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
    if (results.quick && !confirm('This is a quick nest, not a searched one. Mark it as cut anyway?')) return;
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
  const w = window.open('', '_blank');
  if (!w) { showMessages([{ error: true, text: 'Allow pop-ups for this page to print the cut list.' }]); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(job.name || 'Cut list')}</title><style>
    body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 14px;color:#555}
    table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:5px 8px;text-align:left}
    th{font-size:11px;text-transform:uppercase;color:#555}td.num{text-align:right;font-variant-numeric:tabular-nums}
    tr.group td{background:#eee;font-weight:600}.muted{color:#777}.small{font-size:11px}</style></head><body>
    <h1>Cut list — ${esc(job.name || '')}</h1><p>${new Date().toLocaleDateString()} · parts not cut on the CNC</p>
    ${cutListHtml(cutListRows(runParts().filter((p) => p.qty > 0)))}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
};
$('#saveRaw').onclick = () => {
  const name = (job.name || 'onshape').replace(/[^\w-]+/g, '_').slice(0, 40);
  download(`${name}_raw.json`, JSON.stringify(lastRaw, null, 1));
};
$('#loadSample').onclick = (e) => busy(e.target, async () => setParts(await api('/api/sample')));
$('#nestBtn').onclick = async () => { activeSheet = 0; await searchNests(false); $('#resultsCard').scrollIntoView({ behavior: 'smooth' }); };
$('#searchAgain').onclick = () => searchNests(true);
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
    if (results.length) runNest();
  } catch (err) { showMessages([{ error: true, text: err.message }]); }
};
$('#postRemove').onclick = async () => {
  const file = String(job.settings.post).slice(3);
  if (!confirm(`Remove the post file "${file}" from this computer's posts folder?`)) return;
  await api('/api/posts/' + encodeURIComponent(file), { method: 'DELETE' });
  job.settings.post = 'fluidnc';
  rememberSettings();
  await loadPosts();
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
