// Onshape API client: API-key (local dev) or OAuth2 (deployed) auth,
// FeatureScript evaluation, and decoding of Onshape's typed FS values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// API keys entered in the app (Onshape keys dialog) are kept with this PC's
// data and used when .env / the environment doesn't supply any.
const KEYS_FILE = dataPath('onshape-keys.json');
const envKeys = !!(process.env.ONSHAPE_ACCESS_KEY && process.env.ONSHAPE_SECRET_KEY);
if (!envKeys) {
  try {
    const k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (k.accessKey && k.secretKey) { process.env.ONSHAPE_ACCESS_KEY = k.accessKey; process.env.ONSHAPE_SECRET_KEY = k.secretKey; }
  } catch {}
}
// what the keys dialog shows: never the keys themselves
export function keyInfo() {
  const a = process.env.ONSHAPE_ACCESS_KEY || '';
  return { hasKeys: !!(a && process.env.ONSHAPE_SECRET_KEY), accessKeyEnd: a ? a.slice(-4) : '', fromEnv: envKeys };
}
export function saveKeys(accessKey, secretKey) {
  accessKey = String(accessKey || '').trim(); secretKey = String(secretKey || '').trim();
  if (!accessKey || !secretKey) throw new Error('Both the access key and the secret key are needed');
  fs.writeFileSync(KEYS_FILE, JSON.stringify({ accessKey, secretKey, savedAt: new Date().toISOString() }, null, 2));
  process.env.ONSHAPE_ACCESS_KEY = accessKey;
  process.env.ONSHAPE_SECRET_KEY = secretKey;
}
export function clearKeys() {
  fs.rmSync(KEYS_FILE, { force: true });
  if (!envKeys) { delete process.env.ONSHAPE_ACCESS_KEY; delete process.env.ONSHAPE_SECRET_KEY; }
}

const BASE = process.env.ONSHAPE_BASE_URL || 'https://cad.onshape.com';
const API = `${BASE}/api/${process.env.ONSHAPE_API_VERSION || 'v6'}`;
const OAUTH = process.env.ONSHAPE_OAUTH_URL || 'https://oauth.onshape.com';
const TOKEN_FILE = dataPath('oauth-token.json');
const USAGE_FILE = dataPath('api-usage.json');

// Counts successful API calls per year (only 2xx/3xx count toward Onshape's limit).
let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
function countCall() {
  const y = String(new Date().getFullYear());
  usage[y] = (usage[y] || 0) + 1;
  try { fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch {}
}
export const callsThisYear = () => usage[String(new Date().getFullYear())] || 0;

export const EXTRACT_SCRIPT = fs.readFileSync(path.join(__dirname, 'extract.fs'), 'utf8');

// ---------- auth ----------

export function authMode() {
  if (process.env.ONSHAPE_ACCESS_KEY && process.env.ONSHAPE_SECRET_KEY) return 'apikey';
  if (process.env.ONSHAPE_CLIENT_ID && process.env.ONSHAPE_CLIENT_SECRET) return 'oauth';
  return 'none';
}

let token = null;
try { token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}

function saveToken(t) {
  token = { ...t, obtained_at: Date.now() };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

export function isConnected() {
  const mode = authMode();
  if (mode === 'apikey') return true;
  if (mode === 'oauth') return !!token?.access_token;
  return false;
}

export function oauthLoginUrl(state) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ONSHAPE_CLIENT_ID,
    redirect_uri: process.env.ONSHAPE_REDIRECT_URI,
    state,
  });
  return `${OAUTH}/oauth/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${OAUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.ONSHAPE_CLIENT_ID,
      client_secret: process.env.ONSHAPE_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`Onshape token request failed: ${res.status} ${await res.text()}`);
  saveToken(await res.json());
}

export const oauthExchange = (code) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: process.env.ONSHAPE_REDIRECT_URI });

async function authHeader() {
  const mode = authMode();
  if (mode === 'apikey') {
    const b = Buffer.from(`${process.env.ONSHAPE_ACCESS_KEY}:${process.env.ONSHAPE_SECRET_KEY}`).toString('base64');
    return `Basic ${b}`;
  }
  if (mode === 'oauth') {
    if (!token?.access_token) throw new Error('Not signed in to Onshape');
    const expiresAt = token.obtained_at + (token.expires_in - 60) * 1000;
    if (Date.now() > expiresAt && token.refresh_token) {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
    }
    return `Bearer ${token.access_token}`;
  }
  throw new Error('No Onshape credentials configured (see .env.example)');
}

async function api(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: await authHeader(),
      Accept: 'application/json;charset=UTF-8; qs=0.09',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Onshape ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 500)}`);
  countCall();
  return text ? JSON.parse(text) : null;
}

// ---------- documents ----------

// https://cad.onshape.com/documents/{did}/{w|v|m}/{id}/e/{eid}
export function parseOnshapeUrl(url) {
  const m = /documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i.exec(url || '');
  if (!m) throw new Error('Paste a Part Studio URL like https://cad.onshape.com/documents/…/w/…/e/…');
  return { did: m[1], wvm: m[2], wvmid: m[3], eid: m[4] };
}

export async function evaluateExtraction(ref) {
  const { did, wvm, wvmid, eid } = ref;
  const res = await api('POST', `/partstudios/d/${did}/${wvm}/${wvmid}/e/${eid}/featurescript`, {
    script: EXTRACT_SCRIPT,
    queries: {},
  });
  const notices = (res.notices || []).map((n) => {
    const m = n.message?.message ?? n.message;
    const loc = (n.stackTrace || n.message?.stackTrace || [])[0];
    const line = loc?.line ?? loc?.message?.line;
    return `${n.level || n.message?.level || ''} ${typeof m === 'string' ? m : JSON.stringify(n)}${line ? ` (extract.fs line ${line})` : ''}`.trim();
  });
  if (res.result == null) {
    throw new Error(`FeatureScript returned nothing. ${notices.join(' | ') || ''} ${res.console || ''}`.trim());
  }
  return { parts: decode(res.result) || [], notices, console: res.console || '' };
}

// ---------- FS value decoding ----------
// Handles both {btType:"...BTFSValueArray", value:[...]} and
// {typeName:"BTFSValueArray", message:{value:[...]}} shapes.
export function decode(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  const t = String(v.btType || v.typeName || '');
  const body = v.message && typeof v.message === 'object' && v.typeName ? v.message : v;
  if (!t) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = decode(val);
    return out;
  }
  if (/MapEntry/.test(t)) return [decode(body.key), decode(body.value)];
  if (/ValueMap/.test(t)) {
    const out = {};
    for (const e of body.value || []) {
      const [k, val] = decode(e);
      out[typeof k === 'string' ? k : JSON.stringify(k)] = val;
    }
    return out;
  }
  if (/ValueArray/.test(t)) return (body.value || []).map(decode);
  if (/ValueUndefined/.test(t)) return null;
  if (/ValueWithUnits/.test(t)) return body.value; // SI value
  if (/ValueNumber|ValueString|ValueBoolean/.test(t)) return body.value;
  // enums, functions, queries, etc.
  return body.value !== undefined ? decode(body.value) : (body.typeTag || t);
}
