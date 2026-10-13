// Schlieger FVE Hub — server
// Bez závislostí (jen Node 20+). Dělá čtyři věci:
//   1. podává hub (Schlieger-FVE-Hub.html)
//   2. drží společná data všech uživatelů v jednom JSON souboru na disku (DATA_DIR)
//   3. přihlašuje e-mailem a heslem a podle role rozhoduje, co komu pošle a co od koho přijme
//   4. každé ráno se zeptá ABRY, které faktury jsou uhrazené, označí je a založí upozornění
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(DIR, 'data');
const HUB_FILE = process.env.HUB_FILE || [path.join(DIR, 'Schlieger-FVE-Hub.html'), path.join(DIR, '..', 'Schlieger-FVE-Hub.html')].find((p) => fs.existsSync(p));
const STATE_FILE = path.join(DATA_DIR, 'hub-state.json');
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || (PROD ? '' : 'dev-secret-neni-pro-ostry-provoz');
if (!SECRET || SECRET.length < 16) { console.error('Chybí SESSION_SECRET (aspoň 16 znaků).'); process.exit(1); }
if (!HUB_FILE) { console.error('Nenašel jsem Schlieger-FVE-Hub.html.'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

const COLLECTIONS = ['customers', 'quotes', 'contracts', 'orders', 'launches', 'tickets', 'events', 'crews', 'leads', 'protocols', 'notifications'];
const SESSION_DAYS = 7;
const MAX_BODY = 40 * 1024 * 1024;

// ---------- data ----------
function emptyState() { const s = { v: 1, settings: {} }; for (const c of COLLECTIONS) s[c] = []; return s; }
let db = { rev: 1, state: emptyState() };
if (fs.existsSync(STATE_FILE)) { try { db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { console.error('Datový soubor nejde přečíst:', e.message); process.exit(1); } }
for (const c of COLLECTIONS) if (!Array.isArray(db.state[c])) db.state[c] = [];
db.state.settings = db.state.settings || {};
let saveTimer = null;
function save() {
  db.rev++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, STATE_FILE);
    const day = new Date().toISOString().slice(0, 10), bak = path.join(DATA_DIR, `zaloha-${day}.json`);   // jedna záloha denně, drží se 30 dní
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(STATE_FILE, bak);
      for (const f of fs.readdirSync(DATA_DIR).filter((x) => /^zaloha-\d{4}-\d\d-\d\d\.json$/.test(x)).sort().slice(0, -30)) fs.unlinkSync(path.join(DATA_DIR, f));
    }
  }, 150);
}
const users = () => (db.state.settings.users = db.state.settings.users || []);

// ---------- oprávnění (stejná pravidla jako v hubu — výchozí zákazy se čtou přímo z jeho kódu) ----------
let PERM_DENY = {};
function loadPermDefaults() {
  const html = fs.readFileSync(HUB_FILE, 'utf8'), m = html.match(/const PERM_DENY=(\{[\s\S]*?\});/);
  if (m) PERM_DENY = Function('return ' + m[1])();
}
loadPermDefaults();
function can(role, key) {
  if (role === 'admin') return true;
  const p = (db.state.settings.perms || {})[role] || {};
  return p[key] !== undefined ? !!p[key] : !(PERM_DENY[role] || []).includes(key);
}
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, email: u.email, phone: u.phone || '', pass: true });
/* co uživatel dostane: bez hesel a bez toho, co jeho role vidět nemá */
function stateFor(user) {
  const s = JSON.parse(JSON.stringify(db.state));
  s.settings.users = users().map(publicUser);
  if (!can(user.role, 'prijate')) s.notifications = s.notifications.filter((n) => n.kind !== 'paid-out');
  if (!can(user.role, 'prijate')) for (const o of s.orders) {
    const hidden = new Set((o.invoices || []).filter((f) => f.kind === 'prijata').map((f) => f.fileId).filter(Boolean));
    o.invoices = (o.invoices || []).filter((f) => f.kind !== 'prijata');
    o.files = (o.files || []).filter((f) => !hidden.has(f.id));
  }
  return s;
}
/* co od uživatele přijmeme: skryté části zakázky se vrátí z uložených dat, aby je uložením nesmazal */
function mergeOrder(user, incoming) {
  if (can(user.role, 'prijate')) return incoming;
  const cur = db.state.orders.find((o) => o.id === incoming.id); if (!cur) return incoming;
  const hid = (cur.invoices || []).filter((f) => f.kind === 'prijata'), ids = new Set(hid.map((f) => f.fileId).filter(Boolean));
  incoming.invoices = (incoming.invoices || []).filter((f) => f.kind !== 'prijata').concat(hid);
  incoming.files = (incoming.files || []).filter((f) => !ids.has(f.id)).concat((cur.files || []).filter((f) => ids.has(f.id)));
  return incoming;
}
function applyPatch(user, patch) {
  for (const c of COLLECTIONS) {
    const p = (patch.collections || {})[c]; if (!p || c === 'notifications') continue;
    const arr = db.state[c];
    for (let item of p.upsert || []) {
      if (!item || !item.id) continue;
      if (c === 'orders') item = mergeOrder(user, item);
      const i = arr.findIndex((x) => x.id === item.id); if (i >= 0) arr[i] = item; else arr.push(item);
    }
    if ((p.remove || []).length) db.state[c] = arr.filter((x) => !p.remove.includes(x.id));
  }
  if (patch.settings && can(user.role, 'nav.pricelist')) {
    const keep = { users: users(), perms: db.state.settings.perms };
    db.state.settings = Object.assign({}, patch.settings, { users: keep.users, perms: can(user.role, 'nav.users') ? (patch.settings.perms || {}) : keep.perms });
  } else if (patch.settings && can(user.role, 'nav.users')) db.state.settings.perms = patch.settings.perms || {};
  for (const k of ['v', 'demoVer', 'demoCleared']) if (patch.meta && patch.meta[k] !== undefined && user.role === 'admin') db.state[k] = patch.meta[k];
  save();
}

// ---------- hesla a přihlášení ----------
function hashPassword(pass) { const salt = crypto.randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pass, salt, 64).toString('hex'); }
function checkPassword(u, pass) {
  if (u.scrypt) { const [, salt, hash] = u.scrypt.split('$'); const h = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), 64); return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex')); }
  /* uživatel založený ještě v prohlížeči (otisk SHA-256) — po prvním přihlášení se heslo převede na scrypt */
  if (typeof u.pass === 'string' && u.pass.length === 64) {
    const legacy = crypto.createHash('sha256').update('fve-hub|' + String(u.email || '').trim().toLowerCase() + '|' + pass).digest('hex');
    if (crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(u.pass))) { u.scrypt = hashPassword(pass); delete u.pass; save(); return true; }
  }
  return false;
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeSession(uid) { const v = `${uid}.${Date.now() + SESSION_DAYS * 864e5}`; return `${v}.${sign(v)}`; }
function readSession(req) {
  const m = /(?:^|;\s*)fvehub=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [uid, exp, sig] = decodeURIComponent(m[1]).split('.'); if (!uid || !exp || !sig) return null;
  const good = sign(`${uid}.${exp}`); if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  if (Number(exp) < Date.now()) return null;
  return users().find((u) => u.id === uid) || null;
}
const cookie = (req, val, maxAge) => `fvehub=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${(req.headers['x-forwarded-proto'] || '').includes('https') || PROD ? '; Secure' : ''}`;
const attempts = new Map();   // brzda proti hádání hesel: 8 pokusů za 10 minut z jedné adresy
function throttled(ip) { const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 6e5); attempts.set(ip, a); return a.length >= 8; }
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const newId = () => crypto.randomBytes(6).toString('base64url');

// ---------- ABRA: ranní kontrola úhrad ----------
// Zatím ABRA Flexi (REST). Zapne se nastavením ABRA_URL, ABRA_COMPANY, ABRA_USER, ABRA_PASSWORD.
// Faktury se párují podle čísla (kód dokladu nebo variabilní symbol).
const ABRA = { url: (process.env.ABRA_URL || '').replace(/\/+$/, ''), company: process.env.ABRA_COMPANY || '', user: process.env.ABRA_USER || '', pass: process.env.ABRA_PASSWORD || '', hour: Number(process.env.ABRA_SYNC_HOUR || 6) };
const abraOn = () => !!(ABRA.url && ABRA.company && ABRA.user);
let abraLast = { at: null, ok: null, text: 'Kontrola zatím neproběhla.' };
async function abraFetch(evidence) {
  const r = await fetch(`${ABRA.url}/c/${encodeURIComponent(ABRA.company)}/${evidence}.json?detail=custom:kod,varSym,stavUhrK,zbyvaUhradit&limit=0`, {
    headers: { Authorization: 'Basic ' + Buffer.from(ABRA.user + ':' + ABRA.pass).toString('base64'), Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`ABRA ${evidence}: HTTP ${r.status}`);
  const j = await r.json(); return (j.winstrom && j.winstrom[evidence]) || [];
}
const normNo = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();
async function abraSync() {
  if (!abraOn()) { abraLast = { at: new Date().toISOString(), ok: false, text: 'ABRA není nastavená.' }; return abraLast; }
  try {
    const paid = { vydana: new Set(), prijata: new Set() };
    for (const [kind, ev] of [['vydana', 'faktura-vydana'], ['prijata', 'faktura-prijata']])
      for (const f of await abraFetch(ev)) if (f.stavUhrK === 'stavUhr.uhrazeno' || (f.stavUhrK === 'stavUhr.uhrazenoRucne')) { paid[kind].add(normNo(f.kod)); if (f.varSym) paid[kind].add(normNo(f.varSym)); }
    const today = new Date().toISOString().slice(0, 10); let n = 0;
    for (const o of db.state.orders) for (const f of o.invoices || []) {
      if (f.paid || !f.number || !paid[f.kind] || !paid[f.kind].has(normNo(f.number))) continue;
      f.paid = today; f.paidBy = 'abra'; n++;
      db.state.notifications.push({ id: newId(), date: today, kind: f.kind === 'vydana' ? 'paid-in' : 'paid-out', orderId: o.id, invNo: f.number, amount: f.amount,
        text: f.kind === 'vydana' ? `${o.customer && o.customer.name || 'Zákazník'} zaplatil fakturu ${f.number}` : `Uhrazena přijatá faktura ${f.number}${f.supplier ? ' — ' + f.supplier : ''}` });
    }
    db.state.notifications = db.state.notifications.slice(-300);
    if (n) save();
    abraLast = { at: new Date().toISOString(), ok: true, text: n ? `Nově uhrazeno: ${n}` : 'Žádná nová úhrada.' };
  } catch (e) { abraLast = { at: new Date().toISOString(), ok: false, text: 'Kontrola ABRY selhala: ' + e.message }; console.error(abraLast.text); }
  return abraLast;
}
let abraDay = '';
setInterval(() => { const d = new Date(), day = d.toISOString().slice(0, 10); if (abraOn() && d.getHours() >= ABRA.hour && abraDay !== day) { abraDay = day; abraSync(); } }, 5 * 60 * 1000);

// ---------- HTTP ----------
function send(res, code, body, headers) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(HUB_FILE), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    /* každý zápis musí přijít z hubu (vlastní hlavička) — ochrana proti podvrženým požadavkům z cizích stránek */
    if (req.method !== 'GET' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    const me = readSession(req);

    if (req.method === 'GET' && p === '/api/me') return send(res, 200, { hub: true, setup: !users().length, user: me ? publicUser(me) : null, rev: db.rev });
    if (req.method === 'POST' && p === '/api/setup') {   // první uživatel (Vedení) — jen dokud žádný neexistuje
      if (users().length) return send(res, 409, { error: 'Uživatelé už existují.' });
      const b = await readBody(req), email = String(b.email || '').trim().toLowerCase();
      if (process.env.SETUP_TOKEN && b.token !== process.env.SETUP_TOKEN) return send(res, 403, { error: 'Špatný instalační kód.' });
      if (!b.name || !emailOk(email) || String(b.password || '').length < 8) return send(res, 400, { error: 'Vyplň jméno, e-mail a heslo aspoň o 8 znacích.' });
      const u = { id: newId(), name: String(b.name), email, role: 'admin', phone: '', scrypt: hashPassword(String(b.password)) };
      users().push(u); save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeSession(u.id), SESSION_DAYS * 86400) });
    }
    if (req.method === 'POST' && p === '/api/login') {
      if (throttled(ip)) return send(res, 429, { error: 'Moc pokusů. Zkus to za pár minut.' });
      const b = await readBody(req), email = String(b.email || '').trim().toLowerCase(), u = users().find((x) => String(x.email || '').toLowerCase() === email);
      if (!u || !checkPassword(u, String(b.password || ''))) { attempts.get(ip).push(Date.now()); return send(res, 401, { error: 'Špatný e-mail nebo heslo.' }); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeSession(u.id), SESSION_DAYS * 86400) });
    }
    if (req.method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });

    if (!me) return send(res, 401, { error: 'Nepřihlášen.' });
    if (req.method === 'GET' && p === '/api/rev') return send(res, 200, { rev: db.rev });
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, { rev: db.rev, user: publicUser(me), state: stateFor(me), abra: { on: abraOn(), last: abraLast } });
    if (req.method === 'POST' && p === '/api/patch') { applyPatch(me, await readBody(req)); return send(res, 200, { rev: db.rev }); }

    if (p.startsWith('/api/users')) {   // správa uživatelů — jen role s oprávněním „Uživatelé a role"
      if (!can(me.role, 'nav.users')) return send(res, 403, { error: 'Na správu uživatelů nemáš oprávnění.' });
      const admins = () => users().filter((x) => x.role === 'admin').length;
      if (req.method === 'POST' && p === '/api/users') {
        const b = await readBody(req), email = String(b.email || '').trim().toLowerCase(); let u = b.id ? users().find((x) => x.id === b.id) : null;
        if (!b.name || !emailOk(email)) return send(res, 400, { error: 'Vyplň jméno a platný e-mail.' });
        if (users().some((x) => x.id !== b.id && String(x.email || '').toLowerCase() === email)) return send(res, 400, { error: 'Uživatel s tímto e-mailem už existuje.' });
        if ((!u || b.password) && String(b.password || '').length < 8) return send(res, 400, { error: 'Heslo musí mít aspoň 8 znaků.' });
        if (u && u.role === 'admin' && b.role !== 'admin' && admins() < 2) return send(res, 400, { error: 'Aspoň jeden uživatel musí mít roli Vedení.' });
        if (!u) { u = { id: newId() }; users().push(u); }
        Object.assign(u, { name: String(b.name), email, role: String(b.role || 'oz'), phone: String(b.phone || '') });
        if (b.password) { u.scrypt = hashPassword(String(b.password)); delete u.pass; }
        if (u.role === 'oz') { const reps = String(db.state.settings.reps || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean); if (!reps.includes(u.name)) db.state.settings.reps = [...reps, u.name].join(', '); }
        save(); return send(res, 200, { ok: true, id: u.id });
      }
      if (req.method === 'DELETE') {
        const id = p.split('/').pop(), u = users().find((x) => x.id === id); if (!u) return send(res, 404, { error: 'Uživatel neexistuje.' });
        if (u.role === 'admin' && admins() < 2) return send(res, 400, { error: 'Posledního uživatele s rolí Vedení smazat nejde.' });
        db.state.settings.users = users().filter((x) => x.id !== id); save(); return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && p === '/api/abra/sync') {
      if (!can(me.role, 'nav.invoices')) return send(res, 403, { error: 'Bez oprávnění.' });
      return send(res, 200, await abraSync());
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(req.method, p, e.message);
    return send(res, e.message === 'too large' ? 413 : 500, { error: e.message === 'too large' ? 'Požadavek je moc velký.' : 'Chyba serveru.' });
  }
});
server.listen(PORT, () => console.log(`FVE Hub běží na portu ${PORT} · data: ${STATE_FILE} · ABRA: ${abraOn() ? 'zapnuto' : 'vypnuto'}`));
