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
      <label class="small" title="Draw the path over the material instead of down in the cuts"><input type="checkbox" id="rsOnTop"> Path on top</label>
      <label class="small" title="Band the cut walls by the plies of the sheet (off: plain walls)"><input type="checkbox" id="rsPlies"> Plies</label>
      <label class="small" title="How fine the material is: finer shows sharper cuts but needs a stronger graphics card">Detail <select id="rsQual"><option value="ultra">Ultra</option><option value="fine">Fine</option><option value="normal">Normal</option><option value="fast">Fast</option></select></label>
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
  // mouse like Onshape: hold the scroll wheel to drag the view, right (or left)
  // button to turn it, the wheel to zoom in where the pointer is
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  // no Windows auto-scroll on a wheel press; dragging the view stops following the bit
  renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button === 1 && follow) { follow = false; for (const b of root.querySelectorAll('[data-view]')) b.classList.remove('active'); } });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(W * 0.3, -H, 80);
  scene.add(sun);

  // ---------- the material ----------
  // A 3-axis router with flat-end bits can't undercut, so the material is a
  // height at every point of the sheet: a grid of heights (res inches apart)
  // carved as the bit moves, drawn as a real 3D surface: the grid's vertices are
  // raised to their heights on the graphics card from a height texture, so cut
  // walls, floors and through cuts show in 3D, with the plies of the sheet
  // banded on the walls. Quality sets the grid (finer = sharper, heavier).
  const QUALITY = { ultra: 0.02, fine: 0.035, normal: 0.05, fast: 0.09 };
  const quality = (() => { try { return localStorage.getItem('cabinetcam.simQuality') || 'normal'; } catch { return 'normal'; } })();
  const res = Math.max(QUALITY[quality] || 0.05, Math.sqrt((W * H) / 12e6));   // never more than ~12M points
  const gw = Math.ceil(W / res), gh = Math.ceil(H / res);
  const floorZ = zTop - thick;                       // the spoilboard
  const height = new Float32Array(gw * gh).fill(zTop);
  const tex = new THREE.DataTexture(height, gw, gh, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  // The surface is drawn in tiles of 256 x 256 points that all share one small
  // grid (so even Ultra needs little memory); each tile is moved into place and
  // the graphics card raises every point to its height.
  const TILE = 256;
  const tpos = new Float32Array(TILE * TILE * 2);
  for (let j = 0, k = 0; j < TILE; j++) for (let i = 0; i < TILE; i++, k += 2) { tpos[k] = (i + 0.5) * res; tpos[k + 1] = (j + 0.5) * res; }
  const tidx = new Uint16Array((TILE - 1) * (TILE - 1) * 6);
  for (let j = 0, k = 0; j < TILE - 1; j++) for (let i = 0; i < TILE - 1; i++) {
    const v = j * TILE + i;
    tidx[k++] = v; tidx[k++] = v + 1; tidx[k++] = v + TILE;
    tidx[k++] = v + 1; tidx[k++] = v + TILE + 1; tidx[k++] = v + TILE;
  }
  const surfG = new THREE.BufferGeometry();
  surfG.setAttribute('position', new THREE.BufferAttribute(tpos, 2));
  surfG.setIndex(new THREE.BufferAttribute(tidx, 1));
  const tileSpan = (TILE - 1) * res;
  surfG.boundingSphere = new THREE.Sphere(new THREE.Vector3(tileSpan / 2, tileSpan / 2, zTop - thick / 2), Math.hypot(tileSpan, tileSpan) / 2 + thick + 1);
  const plies = Math.max(3, Math.round(thick / 0.055));   // Baltic birch: about 0.055" a ply
  const surfMat = new THREE.ShaderMaterial({
    uniforms: {
      hmap: { value: tex }, res: { value: res }, gsize: { value: new THREE.Vector2(gw, gh) },
      zTop: { value: zTop }, floorZ: { value: floorZ }, plyT: { value: thick / plies }, plyOn: { value: 0 },
      sun: { value: new THREE.Vector3(0.35, -0.55, 0.76).normalize() },
    },
    // The grid's triangles only carry the shape; every pixel is coloured and lit
    // from a smooth reading of the heights at that exact spot (between grid
    // points), so the edge of a cut follows the real curve at pixel level.
    vertexShader: `
      uniform sampler2D hmap; uniform float res; uniform vec2 gsize; uniform float floorZ;
      varying vec2 vXY;
      float h(ivec2 c) { c = clamp(c, ivec2(0), ivec2(gsize) - 1); return max(texelFetch(hmap, c, 0).r, floorZ); }
      void main() {
        vec4 wp = modelMatrix * vec4(position.xy, 0.0, 1.0);
        // points past the sheet's edge fold back onto it (their triangles vanish)
        ivec2 c = min(ivec2(floor(wp.xy / res)), ivec2(gsize) - 1);
        vec2 xy = (vec2(c) + 0.5) * res;
        vXY = xy;
        gl_Position = projectionMatrix * viewMatrix * vec4(xy, h(c), 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D hmap; uniform float res; uniform vec2 gsize;
      uniform float zTop; uniform float floorZ; uniform float plyT; uniform float plyOn; uniform vec3 sun;
      varying vec2 vXY;
      float h(ivec2 c) { c = clamp(c, ivec2(0), ivec2(gsize) - 1); return max(texelFetch(hmap, c, 0).r, floorZ); }
      // the height between grid points (bilinear)
      float hb(vec2 p) {
        vec2 q = p / res - 0.5;
        vec2 c = floor(q), f = q - c;
        ivec2 i = ivec2(c);
        return mix(mix(h(i), h(i + ivec2(1, 0)), f.x), mix(h(i + ivec2(0, 1)), h(i + ivec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec3 face = vec3(0.91, 0.83, 0.66);       // birch face veneer
        vec3 core = vec3(0.86, 0.76, 0.58);
        vec3 spoil = vec3(0.33, 0.35, 0.38);
        vec2 p = vXY;
        float z = hb(p);
        float e = 0.5 * res;
        float dx = (hb(p + vec2(e, 0.0)) - hb(p - vec2(e, 0.0))) / (2.0 * e);
        float dy = (hb(p + vec2(0.0, e)) - hb(p - vec2(0.0, e))) / (2.0 * e);
        vec3 n = normalize(vec3(-dx, -dy, 1.0));
        float slope = 1.0 - n.z;
        float depth = zTop - z;
        // the plies, banded by height on walls (soft-edged), the floor of a cut a shade darker
        float ph = fract(depth / plyT);
        float band = smoothstep(0.35, 0.5, ph) - smoothstep(0.85, 1.0, ph);
        vec3 ply = mix(core, core * 0.88, band * plyOn);
        vec3 col = mix(core * 0.9, ply, smoothstep(0.08, 0.35, slope));
        // untouched top and cut-through blended over about a pixel (no stair-steps)
        float aa = fwidth(depth) + 1e-4;
        col = mix(face, col, smoothstep(0.0015, 0.0015 + aa, depth));
        col = mix(col, spoil, 1.0 - smoothstep(floorZ + 1e-4, floorZ + 1e-4 + aa, z));
        float l = 0.45 + 0.55 * max(dot(n, sun), 0.0) + 0.12 * max(dot(n, normalize(vec3(-0.5, 0.6, 0.6))), 0.0);
        gl_FragColor = vec4(col * l, 1.0);
      }`,
  });
  const surface = new THREE.Group();
  for (let tj = 0; tj * (TILE - 1) < gh; tj++) for (let ti = 0; ti * (TILE - 1) < gw; ti++) {
    const m = new THREE.Mesh(surfG, surfMat);
    m.position.set(ti * (TILE - 1) * res, tj * (TILE - 1) * res, 0);
    surface.add(m);
  }

  scene.add(surface);
  // the sheet's edges and bottom (its top is the surface above)
  const side = new THREE.MeshLambertMaterial({ color: 0xc9b48a });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(W, H, thick), [side, side, side, side, hidden, side]);
  slab.position.set(W / 2, H / 2, zTop - thick / 2);
  scene.add(slab);
  const table = new THREE.Mesh(new THREE.PlaneGeometry(W + 12, H + 12), new THREE.MeshLambertMaterial({ color: 0x555b63 }));
  table.position.set(W / 2, H / 2, floorZ - 0.01);
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

  // the toolpath: rapids red, plunges orange, cuts coloured by depth (light blue
  // near the top, deep blue at the bottom, violet below the sheet). What's been
  // run is bright, what's to come faint, and the next few moves yellow. "Path on
  // top" draws it over the material instead of buried in the cuts.
  const cRapid = new THREE.Color(0xff4d3d), cPlunge = new THREE.Color(0xffa020);
  const cShallow = new THREE.Color(0x7fd3ff), cDeep = new THREE.Color(0x1f4fd0), cThrough = new THREE.Color(0xb04dff);
  const colorOf = (m) => {
    if (m.rapid) return cRapid;
    const xy = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
    if (xy < 1e-6 && m.b[2] < m.a[2]) return cPlunge;
    const z = Math.min(m.a[2], m.b[2]);
    if (z < floorZ - 1e-4) return cThrough;
    return cShallow.clone().lerp(cDeep, Math.max(0, Math.min(1, (zTop - z) / thick)));
  };
  // cuts and rapids drawn apart: cuts bright once run (faint before), rapids
  // always faint so they don't bury the cuts; the next moves yellow
  const cutP = [], cutC = [], rapP = [], allP = [];
  const cutsBefore = new Int32Array(T.moves.length + 1), rapsBefore = new Int32Array(T.moves.length + 1);
  T.moves.forEach((m, i) => {
    const seg = [m.a[0], m.a[1], m.a[2] + 0.004, m.b[0], m.b[1], m.b[2] + 0.004];
    allP.push(...seg);
    if (m.rapid) rapP.push(...seg);
    else { cutP.push(...seg); const c = colorOf(m); cutC.push(c.r, c.g, c.b, c.r, c.g, c.b); }
    cutsBefore[i + 1] = cutsBefore[i] + (m.rapid ? 0 : 1);
    rapsBefore[i + 1] = rapsBefore[i] + (m.rapid ? 1 : 0);
  });
  const geo = (p, c) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    if (c) g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    return g;
  };
  const pathG = geo(cutP, cutC), doneG = geo(cutP, cutC), rapG = geo(rapP), aheadG = geo(allP);
  const futureMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.2 });
  const doneMat = new THREE.LineBasicMaterial({ vertexColors: true });
  const rapMat = new THREE.LineBasicMaterial({ color: cRapid, transparent: true, opacity: 0.28 });
  const aheadMat = new THREE.LineBasicMaterial({ color: 0xffe14d });
  const future = new THREE.LineSegments(pathG, futureMat);
  const done = new THREE.LineSegments(doneG, doneMat);
  const rapids = new THREE.LineSegments(rapG, rapMat);
  const AHEAD = 40;   // moves shown ahead of the bit
  const ahead = new THREE.LineSegments(aheadG, aheadMat);
  future.renderOrder = done.renderOrder = rapids.renderOrder = ahead.renderOrder = 2;
  scene.add(future, done, rapids, ahead);
  const pathOnTop = (on) => { for (const mt of [futureMat, doneMat, rapMat, aheadMat]) { mt.depthTest = !on; mt.needsUpdate = true; } };

  // the tool: the bit and the spindle above it
  const toolGroup = new THREE.Group();
  const bitMat = new THREE.MeshLambertMaterial({ color: 0xe8ecf0, emissive: 0x222222 });
  const shankMat = new THREE.MeshLambertMaterial({ color: 0x8d949c });
  let bit = null;
  const setBit = (dia) => {
    if (bit) { toolGroup.remove(bit); bit.traverse((o) => o.geometry?.dispose()); }
    bit = new THREE.Group();
    // the cutting length bright, the shank above it darker
    const flutes = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, 0.9, 28), bitMat);
    flutes.rotation.x = Math.PI / 2;
    flutes.position.z = 0.45;
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(dia / 2, 0.125), Math.max(dia / 2, 0.125), 0.35, 28), shankMat);
    shank.rotation.x = Math.PI / 2;
    shank.position.z = 0.9 + 0.175;
    bit.add(flutes, shank);
    toolGroup.add(bit);
  };
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.9, 24), new THREE.MeshLambertMaterial({ color: 0x8a9099 }));
  nut.rotation.x = Math.PI / 2;
  nut.position.z = 1.25 + 0.45;
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 6, 32), new THREE.MeshLambertMaterial({ color: 0x3d6fb6, transparent: true, opacity: 0.12, depthWrite: false }));
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
    else { const p = toolGroup.position; c.set(p.x, p.y, zTop); camera.position.set(p.x + 4, p.y - 9, zTop + 7); }
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
  let texDirty = false, dirtyLo = Infinity, dirtyHi = -1, fullUpload = true;
  // Edge cells are cut part way by how much of the cell the bit covers, so a
  // curved wall sits where the bit really left it instead of stepping from cell
  // to cell: radiuses and holes come out smooth, not jagged.
  const stampAt = (x, y, z, r) => {
    if (z >= zTop - 1e-4) return;
    const reach = r + res;
    const i0 = Math.max(0, Math.floor((x - reach) / res)), i1 = Math.min(gw - 1, Math.floor((x + reach) / res));
    const j0 = Math.max(0, Math.floor((y - reach) / res)), j1 = Math.min(gh - 1, Math.floor((y + reach) / res));
    const reach2 = reach * reach, depth = zTop - z;
    for (let j = j0; j <= j1; j++) {
      const cy = (j + 0.5) * res - y;
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * res - x;
        const d2 = cx * cx + cy * cy;
        if (d2 > reach2) continue;
        const cov = 0.5 + (r - Math.sqrt(d2)) / res;   // 1 = cell fully cut, 0 = untouched
        if (cov <= 0) continue;
        const zz = cov >= 1 ? z : z + (1 - cov) * depth;
        const k = j * gw + i;
        if (zz < height[k]) { height[k] = zz; texDirty = true; if (j < dirtyLo) dirtyLo = j; if (j > dirtyHi) dirtyHi = j; }
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
    stamped = { idx: 0, frac: 0 };
    fullUpload = true;
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

  // only the rows of the height grid that changed go to the graphics card (Ultra's grid is large)
  const gl = renderer.getContext();
  const uploadHeights = () => {
    const glTex = renderer.properties.get(tex).__webglTexture;
    if (fullUpload || !glTex) { tex.needsUpdate = true; fullUpload = false; }
    else if (dirtyHi >= dirtyLo) {
      renderer.state.bindTexture(gl.TEXTURE_2D, glTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, dirtyLo, gw, dirtyHi - dirtyLo + 1, gl.RED, gl.FLOAT, height.subarray(dirtyLo * gw, (dirtyHi + 1) * gw));
    }
    texDirty = false;
    dirtyLo = Infinity;
    dirtyHi = -1;
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
    doneG.setDrawRange(0, cutsBefore[st.idx + (st.done ? 1 : 0)] * 2);
    { const a0 = st.idx + (st.done ? 1 : 0); aheadG.setDrawRange(a0 * 2, Math.min(AHEAD, T.moves.length - a0) * 2); }
    if ($('#rsMat').checked) cutTo(st);
    $('#rsScrub').value = String(Math.round((t / T.total) * 1000));
    $('#rsTime').textContent = `${clock(t)} / ${clock(T.total)} · ${((t / T.total) * 100).toFixed(1)}%`;
    if (follow) { const d = camera.position.clone().sub(controls.target); controls.target.set(st.p[0], st.p[1], zTop); camera.position.copy(controls.target).add(d); }
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
    if (texDirty && now - lastTex > 60) { uploadHeights(); lastTex = now; }
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
  $('#rsMat').onchange = () => { if ($('#rsMat').checked) update(); else { resetMaterial(); } tex.needsUpdate = true; };
  $('#rsPath').onchange = () => { future.visible = done.visible = rapids.visible = ahead.visible = $('#rsPath').checked; };
  $('#rsOnTop').onchange = () => pathOnTop($('#rsOnTop').checked);
  // ply bands on the walls: off by default (plain walls read cleaner on radiuses), remembered
  const setPlies = (on) => { surfMat.uniforms.plyOn.value = on ? 1 : 0; try { localStorage.setItem('cabinetcam.simPlies', on ? '1' : '0'); } catch { /* not kept */ } };
  $('#rsPlies').checked = (() => { try { return localStorage.getItem('cabinetcam.simPlies') === '1'; } catch { return false; } })();
  setPlies($('#rsPlies').checked);
  $('#rsPlies').onchange = () => setPlies($('#rsPlies').checked);
  $('#rsQual').value = quality;
  $('#rsQual').onchange = () => {
    try { localStorage.setItem('cabinetcam.simQuality', $('#rsQual').value); } catch { /* not kept */ }
    // a new grid: start the simulator again where it is
    const at = t;
    close();
    const again = openRunSim(opts);
    again.seek(at);
  };
  const key = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') { e.preventDefault(); $('#rsPlay').click(); }
  };
  const close = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    removeEventListener('keydown', key);
    controls.dispose();
    surfG.dispose(); surfMat.dispose(); tex.dispose(); pathG.dispose(); doneG.dispose(); rapG.dispose(); aheadG.dispose();
    renderer.dispose();
    root.remove();
  };
  $('#rsClose').onclick = close;
  addEventListener('keydown', key);
  update();
  raf = requestAnimationFrame(frame);
  return { close, timeline: T, program: prog, seek: (x) => seek(x), state: () => T.at(t), material: { height, gw, gh, res } };
}
