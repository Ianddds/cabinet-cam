// Cabinet CAM — local server. Onshape access, part extraction and job storage.
// Nesting, toolpaths and posting run in the browser (public/lib), so the
// server stays light enough for a small VM later.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR, dataPath } from './lib/paths.js';
import * as onshape from './lib/onshape.js';
import { normalizeAll } from './lib/parts.js';
import { DEFAULT_LIBRARY } from './public/lib/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS = dataPath('jobs');
fs.mkdirSync(JOBS, { recursive: true });

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ---------- status / auth ----------
app.get('/api/status', (req, res) => {
  res.json({ authMode: onshape.authMode(), connected: onshape.isConnected(), callsThisYear: onshape.callsThisYear() });
});

// Onshape API keys entered in the app (kept with this PC's data, never sent back)
app.get('/api/keys', (req, res) => res.json(onshape.keyInfo()));
app.post('/api/keys', wrap(async (req, res) => {
  onshape.saveKeys(req.body?.accessKey, req.body?.secretKey);
  res.json(onshape.keyInfo());
}));
app.delete('/api/keys', wrap(async (req, res) => { onshape.clearKeys(); res.json(onshape.keyInfo()); }));

// app version / where this PC's data lives (About, desktop app)
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
app.get('/api/about', (req, res) => res.json({ version: VERSION, dataDir: DATA_DIR, desktop: !!process.versions.electron }));

const oauthStates = new Set();
app.get('/auth/onshape', (req, res) => {
  if (onshape.authMode() !== 'oauth') return res.status(400).send('OAuth is not configured (see .env.example)');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.add(state);
  res.redirect(onshape.oauthLoginUrl(state));
});

app.get('/auth/onshape/callback', wrap(async (req, res) => {
  if (!oauthStates.delete(req.query.state)) return res.status(400).send('Bad OAuth state; try signing in again');
  await onshape.oauthExchange(req.query.code);
  res.redirect('/');
}));

// ---------- extraction ----------
app.get('/api/script', (req, res) => res.type('text/plain').send(onshape.EXTRACT_SCRIPT));

app.post('/api/extract', wrap(async (req, res) => {
  const ref = onshape.parseOnshapeUrl(req.body.url);
  // One API call per fetch: only the FeatureScript evaluation (names come from the parts themselves).
  const t0 = Date.now();
  let extraction;
  try {
    extraction = await onshape.evaluateExtraction(ref);
  } catch (e) {
    if (/\b(400|404)\b/.test(e.message)) {
      throw new Error(`Onshape couldn't evaluate that tab. Make sure the URL points at a Part Studio tab (assemblies aren't supported yet). Details: ${e.message}`);
    }
    throw e;
  }
  const { parts: raw, notices, console: fsConsole } = extraction;
  const info = {};
  const { parts, errors, untagged } = normalizeAll(raw);
  res.json({ source: { url: req.body.url, ...ref, ...info }, parts, errors, untagged, notices, console: fsConsole, rawCount: raw.length, ms: Date.now() - t0, raw, callsThisYear: onshape.callsThisYear() });
}));

// Offline sample so the app can be tried without Onshape.
app.get('/api/sample', wrap(async (req, res) => {
  const { sampleKitchen } = await import('./test/synthetic.js');
  const { parts, errors } = normalizeAll(sampleKitchen());
  res.json({ source: { documentName: 'Sample kitchen (offline)', elementName: 'Synthetic parts' }, parts, errors, notices: [] });
}));

// ---------- tool library ----------
const TOOLS = dataPath('tools.json');
const readTools = () => {
  try { return JSON.parse(fs.readFileSync(TOOLS, 'utf8')); } catch { return structuredClone(DEFAULT_LIBRARY); }
};
app.get('/api/tools', (req, res) => res.json(readTools()));
app.put('/api/tools', wrap(async (req, res) => {
  const list = req.body;
  if (!Array.isArray(list) || list.some((t) => !t || typeof t.id !== 'string' || !(t.dia > 0))) {
    return res.status(400).json({ error: 'Each tool needs an id and a diameter above zero' });
  }
  fs.writeFileSync(TOOLS, JSON.stringify(list, null, 2));
  res.json({ ok: true, count: list.length });
}));

// ---------- remnants ----------
// Offcuts kept for later jobs, shared by everyone using the app.
// { nextNo, items: [{ id, no, material, thickness, w (along grain), h, status:
//   'available' | 'used', note, source: 'job' | 'manual', fromJob, fromJobName,
//   createdAt, usedBy, usedByName, usedAt }] }
const REMNANTS = dataPath('remnants.json');
const readRemnants = () => {
  try { return JSON.parse(fs.readFileSync(REMNANTS, 'utf8')); } catch { return { nextNo: 1, items: [] }; }
};
const writeRemnants = (db) => fs.writeFileSync(REMNANTS, JSON.stringify(db, null, 2));
const newRemnant = (db, r, extra) => {
  const w = +r.w, h = +r.h, t = +r.thickness;
  if (!(w > 0 && h > 0 && t > 0) || !r.material) throw new Error('A remnant needs a material, thickness, length and width');
  const no = db.nextNo++;
  // an L / T remnant: its two rectangles, relative to its bounding box w x h
  const rects = Array.isArray(r.rects) && r.rects.length > 1
    ? r.rects.map((q) => ({ x: +q.x, y: +q.y, w: +q.w, h: +q.h })).filter((q) => q.w > 0 && q.h > 0) : null;
  return { id: `R${no}-${crypto.randomBytes(2).toString('hex')}`, no, material: String(r.material), thickness: t,
    w: Math.max(w, 0), h: Math.max(h, 0), ...(rects?.length > 1 ? { rects } : {}), status: 'available', note: r.note ? String(r.note) : '',
    createdAt: new Date().toISOString(), ...extra };
};

app.get('/api/remnants', (req, res) => res.json(readRemnants().items));

app.post('/api/remnants', wrap(async (req, res) => {
  const db = readRemnants();
  const r = newRemnant(db, req.body, { source: 'manual' });
  db.items.push(r);
  writeRemnants(db);
  res.json(r);
}));

app.delete('/api/remnants/:id', wrap(async (req, res) => {
  const db = readRemnants();
  db.items = db.items.filter((r) => r.id !== req.params.id);
  writeRemnants(db);
  res.json({ ok: true });
}));

// A job was cut: use up the remnants it was nested on, keep its new offcuts.
app.post('/api/remnants/cut', wrap(async (req, res) => {
  const { jobId, jobName, used = [], add = [] } = req.body || {};
  const db = readRemnants();
  const conflicts = [];
  const now = new Date().toISOString();
  for (const id of used) {
    const r = db.items.find((x) => x.id === id);
    if (!r || r.status !== 'available') { conflicts.push(id); continue; }
    Object.assign(r, { status: 'used', usedBy: jobId || '', usedByName: jobName || '', usedAt: now });
  }
  const added = add.map((a) => newRemnant(db, a, { source: 'job', fromJob: jobId || '', fromJobName: jobName || '' }));
  db.items.push(...added);
  writeRemnants(db);
  res.json({ added, conflicts });
}));

// Undo a "cut": put the used remnants back, drop the offcuts it added (if still unused).
app.post('/api/remnants/uncut', wrap(async (req, res) => {
  const { used = [], added = [] } = req.body || {};
  const db = readRemnants();
  const kept = [];
  for (const id of used) {
    const r = db.items.find((x) => x.id === id);
    if (r) Object.assign(r, { status: 'available', usedBy: undefined, usedByName: undefined, usedAt: undefined });
  }
  db.items = db.items.filter((r) => {
    if (!added.includes(r.id)) return true;
    if (r.status === 'used') { kept.push(r.id); return true; }   // already used by another job
    return false;
  });
  writeRemnants(db);
  res.json({ ok: true, kept });
}));

// ---------- label printing (Zebra, raw ZPL) ----------
// mode "network": send to the printer's raw port (9100) at host[:port]
// mode "share":   Windows only, a USB printer shared under a name: copy /b file \\localhost\name
app.post('/api/print', wrap(async (req, res) => {
  const { zpl, mode, host, share } = req.body || {};
  if (typeof zpl !== 'string' || !zpl.includes('^XA')) return res.status(400).json({ error: 'Nothing to print' });
  if (mode === 'network') {
    const m = /^([\w.-]+)(?::(\d+))?$/.exec(String(host || '').trim());
    if (!m) return res.status(400).json({ error: 'Printer address should look like 192.168.1.50 or 192.168.1.50:9100' });
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: m[1], port: Number(m[2] || 9100) }, () => sock.end(zpl, 'utf8'));
      sock.setTimeout(8000, () => { sock.destroy(); reject(new Error(`No answer from the printer at ${host}`)); });
      sock.on('error', (e) => reject(new Error(`Printer ${host}: ${e.message}`)));
      sock.on('close', (hadErr) => { if (!hadErr) resolve(); });
    });
    return res.json({ ok: true });
  }
  if (mode === 'share') {
    if (process.platform !== 'win32') return res.status(400).json({ error: 'Shared-printer printing only works when the app runs on Windows' });
    const name = String(share || '').trim();
    if (!/^[\w .()-]+$/.test(name)) return res.status(400).json({ error: 'Give the printer\'s share name (letters, numbers, spaces, - . ( ) only)' });
    const file = path.join(os.tmpdir(), `labels-${crypto.randomBytes(4).toString('hex')}.zpl`);
    fs.writeFileSync(file, zpl, 'utf8');
    try {
      await new Promise((resolve, reject) => execFile('cmd', ['/c', 'copy', '/b', file, `\\\\localhost\\${name}`], { windowsHide: true },
        (err, stdout, stderr) => (err ? reject(new Error(`Could not print to \\\\localhost\\${name}: ${stderr || stdout || err.message}`)) : resolve())));
    } finally { fs.rmSync(file, { force: true }); }
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Pick a printer connection (network or shared printer) in the label settings' });
}));

// ---------- jobs ----------
const jobPath = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad job id');
  return path.join(JOBS, `${id}.json`);
};

app.get('/api/jobs', (req, res) => {
  const jobs = fs.readdirSync(JOBS).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOBS, f), 'utf8'));
      return { id: j.id, name: j.name, updated: j.updated, parts: j.parts?.length || 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  res.json(jobs);
});

app.get('/api/jobs/:id', wrap(async (req, res) => {
  res.type('json').send(fs.readFileSync(jobPath(req.params.id), 'utf8'));
}));

app.post('/api/jobs', wrap(async (req, res) => {
  const job = req.body;
  job.id = job.id || `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  job.updated = new Date().toISOString();
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
  res.json({ id: job.id, updated: job.updated });
}));

app.delete('/api/jobs/:id', wrap(async (req, res) => {
  fs.rmSync(jobPath(req.params.id), { force: true });
  res.json({ ok: true });
}));

// Start listening. The desktop app calls this itself (and falls back to a free
// port if 3100 is taken); `npm start` / `node server.js` starts it right away.
export function startServer({ port = Number(process.env.PORT || 3100), host = process.env.HOST || '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const p = server.address().port;
      console.log(`Cabinet CAM ${VERSION} on http://${host === '0.0.0.0' ? 'localhost' : host}:${p}  (Onshape auth: ${onshape.authMode()}, data: ${DATA_DIR})`);
      resolve({ server, port: p, host });
    });
    server.once('error', reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((e) => { console.error(e.code === 'EADDRINUSE' ? 'Cabinet CAM is already running on that port (or something else is using it).' : e); process.exit(1); });
}
