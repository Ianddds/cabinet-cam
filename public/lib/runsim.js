// Run simulator: plays a sheet's posted file in 3D the way the machine would run
// it (timed with the machine profile), with the tool, the path cut so far, the
// material taken away, a DRO, the G-code line it's on, and playback controls.
// three.js is bundled in public/lib/vendor/three (works offline).
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { parseProgram, timeline } from './gcodesim.js';
import { placedGeometry } from './nest.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * opts: { text (the posted file), kind ('gcode' | 'sbp'), cfg (job settings +
 * tools), sheet, title, tools ([{ name, dia }] in the order the file loads them) }
 */
export function openRunSim(opts) {
  const { cfg, sheet } = opts;
  const prog = parseProgram(opts.text, opts.kind);
  const T = timeline(prog, cfg);
  if (!T.moves.length) throw new Error('No moves in the file to simulate.');
  const W = sheet.w || cfg.sheet?.sheetW || 96, H = sheet.h || cfg.sheet?.sheetH || 48;
  const thick = cfg.thickness || 0.75;
  const zTop = cfg.zZero === 'table' ? thick : 0;
  const tools = opts.tools?.length ? opts.tools : [{ name: cfg.tool?.name || 'Bit', dia: cfg.tool?.dia || 0.25 }];
  const toolOf = (k) => tools[Math.min(k, tools.length - 1)] || tools[0];

  // ---------- the page ----------
  const root = document.createElement('div');
  root.className = 'runsim';
  root.innerHTML = `
    <div class="rs-bar">
      <strong>Run simulation</strong><span class="muted small">${esc(opts.title || '')}</span>
      <span class="spacer"></span>
      <span class="small rs-views">View <button data-view="top">Top</button><button data-view="iso">3D</button><button data-view="follow">Follow tool</button></span>
      <label class="small"><input type="checkbox" id="rsMat" checked> Material</label>
      <label class="small"><input type="checkbox" id="rsPath" checked> Path</label>
      <button id="rsClose">Close</button>
    </div>
    <div class="rs-main">
      <div class="rs-canvas"></div>
      <div class="rs-side">
        <div class="rs-dro">
          <div><span>X</span><b id="rsX">0.000</b></div>
          <div><span>Y</span><b id="rsY">0.000</b></div>
          <div><span>Z</span><b id="rsZ">0.000</b></div>
        </div>
        <div class="rs-info small">
          <div>Feed <b id="rsF">0</b> ipm · Spindle <b id="rsS">off</b></div>
          <div>Bit <b id="rsT"></b></div>
          <div id="rsState" class="rs-state">Ready</div>
        </div>
        <div class="rs-msg" id="rsMsg" hidden><span id="rsMsgText"></span><button id="rsGo" class="primary">Continue</button></div>
        <div class="small muted" id="rsLineNo"></div>
        <pre class="rs-code" id="rsCode"></pre>
      </div>
    </div>
    <div class="rs-ctl">
      <button id="rsStart" title="Back to the start">⏮</button>
      <button id="rsPlay" class="primary" title="Play / pause (space)">▶</button>
      <button id="rsNext" title="Jump to the next stop (bit change, screws)">⏭</button>
      <label class="small">Speed <select id="rsSpeed"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10" selected>10×</option><option value="25">25×</option><option value="50">50×</option><option value="100">100×</option></select></label>
      <input type="range" id="rsScrub" min="0" max="1000" value="0">
      <span class="small" id="rsTime"></span>
      <label class="small" title="Stop where the machine would wait for you (bit changes, screws)"><input type="checkbox" id="rsStops" checked> Stop at stops</label>
    </div>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);

  // ---------- 3D scene (Z up, inches) ----------
  const host = $('.rs-canvas');
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2b2f36);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(W * 0.3, -H, 80);
  scene.add(sun);

  // the material: heights on a grid, drawn as a texture on the sheet's top
  const res = Math.max(0.04, Math.max(W, H) / 1600);
  const gw = Math.ceil(W / res), gh = Math.ceil(H / res);
  const height = new Float32Array(gw * gh).fill(zTop);
  const pix = new Uint8Array(gw * gh * 4);
  const tex = new THREE.DataTexture(pix, gw, gh, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  const wood = [232, 211, 168], spoil = [70, 74, 80];
  const paint = (i) => {
    const d = Math.max(0, Math.min(1, (zTop - height[i]) / thick));
    const k = i * 4;
    if (d >= 0.999) { pix[k] = spoil[0]; pix[k + 1] = spoil[1]; pix[k + 2] = spoil[2]; }
    else {
      const s = d > 0 ? 0.78 - 0.45 * d : 1;
      pix[k] = wood[0] * s; pix[k + 1] = wood[1] * s; pix[k + 2] = wood[2] * s;
    }
    pix[k + 3] = 255;
  };
  for (let i = 0; i < gw * gh; i++) paint(i);
  tex.needsUpdate = true;
  const side = new THREE.MeshLambertMaterial({ color: 0xc9b48a });
  const top = new THREE.MeshLambertMaterial({ map: tex });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(W, H, thick), [side, side, side, side, top, side]);
  slab.position.set(W / 2, H / 2, zTop - thick / 2);
  scene.add(slab);
  const table = new THREE.Mesh(new THREE.PlaneGeometry(W + 12, H + 12), new THREE.MeshLambertMaterial({ color: 0x555b63 }));
  table.position.set(W / 2, H / 2, zTop - thick - 0.01);
  scene.add(table);

  // part outlines on top of the sheet
  const outl = [];
  for (const pl of sheet.placements || []) {
    const o = placedGeometry(pl).outline;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length];
      outl.push(a[0], a[1], zTop + 0.01, b[0], b[1], zTop + 0.01);
    }
  }
  const outG = new THREE.BufferGeometry();
  outG.setAttribute('position', new THREE.Float32BufferAttribute(outl, 3));
  scene.add(new THREE.LineSegments(outG, new THREE.LineBasicMaterial({ color: 0x6b5a3a, transparent: true, opacity: 0.55 })));

  // the toolpath: all of it faint, what's been run bright
  const pp = [], pc = [];
  const cRapid = new THREE.Color(0xe0453a), cCut = new THREE.Color(0x2f7fe0);
  for (const m of T.moves) {
    pp.push(m.a[0], m.a[1], m.a[2], m.b[0], m.b[1], m.b[2]);
    const c = m.rapid ? cRapid : cCut;
    pc.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const pathG = new THREE.BufferGeometry();
  pathG.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
  pathG.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
  const future = new THREE.LineSegments(pathG, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.18 }));
  const doneG = pathG.clone();
  const done = new THREE.LineSegments(doneG, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(future, done);

  // the tool: the bit and the spindle above it
  const toolGroup = new THREE.Group();
  const bitMat = new THREE.MeshLambertMaterial({ color: 0xd8dde3 });
  let bit = null;
  const setBit = (dia) => {
    if (bit) { toolGroup.remove(bit); bit.geometry.dispose(); }
    bit = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, 1.25, 24), bitMat);
    bit.rotation.x = Math.PI / 2;
    bit.position.z = 0.625;
    toolGroup.add(bit);
  };
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.9, 24), new THREE.MeshLambertMaterial({ color: 0x8a9099 }));
  nut.rotation.x = Math.PI / 2;
  nut.position.z = 1.25 + 0.45;
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 6, 32), new THREE.MeshLambertMaterial({ color: 0x3d6fb6, transparent: true, opacity: 0.35 }));
  motor.rotation.x = Math.PI / 2;
  motor.position.z = 1.25 + 0.9 + 3;
  toolGroup.add(nut, motor);
  scene.add(toolGroup);
  let bitIdx = -1;

  // ---------- views ----------
  let follow = false;
  const view = (v) => {
    follow = v === 'follow';
    const c = new THREE.Vector3(W / 2, H / 2, zTop);
    const span = Math.max(W, H);
    if (v === 'top') { camera.position.set(W / 2, H / 2 - 0.001, span * 1.05); }
    else if (v === 'iso') { camera.position.set(W * 0.45, -H * 1.25, span * 0.75); }
    else { const p = toolGroup.position; camera.position.set(p.x, p.y - 14, p.z + 12); c.copy(p); }
    controls.target.copy(c);
    controls.update();
    for (const b of root.querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === v);
  };
  for (const b of root.querySelectorAll('[data-view]')) b.onclick = () => view(b.dataset.view);

  const resize = () => {
    const r = host.getBoundingClientRect();
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  view('iso');

  // ---------- cutting the material ----------
  let stamped = { idx: 0, frac: 0 };   // material taken away up to here
  let texDirty = false;
  const stampAt = (x, y, z, r) => {
    if (z >= zTop - 1e-4) return;
    const i0 = Math.max(0, Math.floor((x - r) / res)), i1 = Math.min(gw - 1, Math.floor((x + r) / res));
    const j0 = Math.max(0, Math.floor((y - r) / res)), j1 = Math.min(gh - 1, Math.floor((y + r) / res));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const cy = (j + 0.5) * res - y;
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * res - x;
        if (cx * cx + cy * cy > r2) continue;
        const k = j * gw + i;
        if (z < height[k]) { height[k] = z; paint(k); texDirty = true; }
      }
    }
  };
  const stampMove = (m, f0, f1) => {
    if (m.rapid && Math.min(m.a[2], m.b[2]) >= zTop) return;
    const r = (toolOf(m.tool).dia || 0.25) / 2;
    const L = m.lim.L * (f1 - f0);
    const n = Math.max(1, Math.ceil(L / (res * 0.5)));
    for (let s = 0; s <= n; s++) {
      const k = f0 + ((f1 - f0) * s) / n;
      stampAt(m.a[0] + (m.b[0] - m.a[0]) * k, m.a[1] + (m.b[1] - m.a[1]) * k, m.a[2] + (m.b[2] - m.a[2]) * k, r);
    }
  };
  const resetMaterial = () => {
    height.fill(zTop);
    for (let i = 0; i < gw * gh; i++) paint(i);
    stamped = { idx: 0, frac: 0 };
    texDirty = true;
  };
  const cutTo = (st) => {
    if (st.idx < stamped.idx || (st.idx === stamped.idx && st.frac < stamped.frac)) resetMaterial();
    while (stamped.idx < st.idx) {
      stampMove(T.moves[stamped.idx], stamped.frac, 1);
      stamped = { idx: stamped.idx + 1, frac: 0 };
    }
    const f1 = st.done ? 1 : st.frac;
    if (f1 > stamped.frac) { stampMove(T.moves[st.idx], stamped.frac, f1); stamped.frac = f1; }
  };

  // ---------- G-code lines ----------
  let shownLine = -1;
  const showLines = (line) => {
    if (line === shownLine) return;
    shownLine = line;
    const a = Math.max(0, line - 8), b = Math.min(prog.lines.length, a + 24);
    let h = '';
    for (let i = a; i < b; i++) h += `<div class="${i === line ? 'cur' : ''}"><i>${i + 1}</i>${esc(prog.lines[i]) || '&nbsp;'}</div>`;
    $('#rsCode').innerHTML = h;
    $('#rsLineNo').textContent = `Line ${line + 1} of ${prog.lines.length}`;
  };

  // ---------- playback ----------
  let t = 0, playing = false, last = performance.now(), waitStop = null, raf = 0, lastTex = 0;
  const stopsToHalt = () => ($('#rsStops').checked ? T.stops.filter((s) => s.kind === 'tool' || s.kind === 'stop') : []);
  const setPlaying = (on) => { playing = on; $('#rsPlay').textContent = on ? '⏸' : '▶'; last = performance.now(); };
  const showStop = (s) => {
    waitStop = s;
    $('#rsMsg').hidden = !s;
    if (s) $('#rsMsgText').textContent = `${s.kind === 'tool' ? 'Bit change' : 'Machine stopped'} (line ${s.line + 1}): ${s.text}`;
  };
  const update = () => {
    const st = T.at(t);
    if (!st) return;
    toolGroup.position.set(st.p[0], st.p[1], st.p[2]);
    if (st.tool !== bitIdx) { bitIdx = st.tool; setBit(toolOf(bitIdx).dia || 0.25); $('#rsT').textContent = `${toolOf(bitIdx).name || 'Bit'} (${(toolOf(bitIdx).dia || 0).toFixed(3)}")`; }
    $('#rsX').textContent = st.p[0].toFixed(3);
    $('#rsY').textContent = st.p[1].toFixed(3);
    $('#rsZ').textContent = st.p[2].toFixed(3);
    $('#rsF').textContent = Math.round(st.ipm);
    const m = T.moves[st.idx];
    const inStop = T.stops.find((s) => t >= s.t - 1e-9 && t < s.t + s.sec) || (waitStop && Math.abs(t - waitStop.t) < 1e-9 ? waitStop : null);
    $('#rsS').textContent = st.spindle && !(inStop && inStop.kind !== 'dwell') ? 'on' : 'off';
    $('#rsState').textContent = inStop ? (inStop.kind === 'dwell' ? 'Spindle spin-up / dwell' : inStop.kind === 'tool' ? 'Bit change' : 'Stopped') : st.done && st.idx === T.moves.length - 1 ? 'Finished' : m.rapid ? 'Rapid' : Math.abs(m.b[2] - m.a[2]) > 1e-6 && Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) < 1e-6 ? 'Plunge' : 'Cutting';
    showLines(inStop ? inStop.line : st.line);
    doneG.setDrawRange(0, (st.idx + (st.done ? 1 : 0)) * 2);
    if ($('#rsMat').checked) cutTo(st);
    $('#rsScrub').value = String(Math.round((t / T.total) * 1000));
    $('#rsTime').textContent = `${clock(t)} / ${clock(T.total)} · ${((t / T.total) * 100).toFixed(1)}%`;
    if (follow) { const d = camera.position.clone().sub(controls.target); controls.target.copy(toolGroup.position); camera.position.copy(toolGroup.position).add(d); }
  };
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && !waitStop) {
      const next = t + dt * +$('#rsSpeed').value;
      // stop where the machine would wait for the operator
      const s = stopsToHalt().find((x) => x.t >= t - 1e-9 && x.t < next && !x.passed);
      if (s) { t = s.t; s.passed = true; showStop(s); setPlaying(false); }
      else t = Math.min(T.total, next);
      if (t >= T.total) setPlaying(false);
      update();
    }
    if (texDirty && now - lastTex > 90) { tex.needsUpdate = true; texDirty = false; lastTex = now; }
    controls.update();
    renderer.render(scene, camera);
  };
  const seek = (tt) => {
    t = Math.max(0, Math.min(T.total, tt));
    for (const s of T.stops) s.passed = s.t < t - 1e-9;
    showStop(null);
    update();
  };
  $('#rsPlay').onclick = () => { if (waitStop) { const s = waitStop; showStop(null); t = s.t + s.sec; } if (t >= T.total) seek(0); setPlaying(!playing || !!waitStop); };
  $('#rsGo').onclick = () => { const s = waitStop; showStop(null); t = s.t + s.sec; update(); setPlaying(true); };
  $('#rsStart').onclick = () => { setPlaying(false); seek(0); };
  $('#rsNext').onclick = () => {
    const s = T.stops.find((x) => (x.kind === 'tool' || x.kind === 'stop') && x.t > t + 1e-6);
    seek(s ? s.t : T.total);
    if (s) { s.passed = true; showStop(s); }
    setPlaying(false);
  };
  $('#rsScrub').oninput = (e) => { setPlaying(false); seek((+e.target.value / 1000) * T.total); };
  $('#rsMat').onchange = () => { if ($('#rsMat').checked) update(); else { resetMaterial(); } };
  $('#rsPath').onchange = () => { future.visible = done.visible = $('#rsPath').checked; };
  const key = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') { e.preventDefault(); $('#rsPlay').click(); }
  };
  const close = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    removeEventListener('keydown', key);
    controls.dispose();
    renderer.dispose();
    root.remove();
  };
  $('#rsClose').onclick = close;
  addEventListener('keydown', key);
  update();
  raf = requestAnimationFrame(frame);
  return { close, timeline: T, program: prog, seek: (x) => seek(x), state: () => T.at(t) };
}
