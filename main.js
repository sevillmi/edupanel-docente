const { app, BrowserWindow, ipcMain, safeStorage, shell, session, powerMonitor, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const sec = require('./security');

let ABOUT = {};
try { ABOUT = require('./src/about.config.js'); } catch {}

const HOME = os.homedir();
const APP_URL = pathToFileURL(path.join(__dirname, 'src')).href + '/';
const ALLOWED_HOSTS = new Set(['aistudio.google.com', 'platform.openai.com', 'platform.claude.com']);
const AUTOLOCK_OPTIONS = [1, 5, 15, 30];
const MAX_DB_CHARS = 20 * 1024 * 1024;
const AI_TIMEOUT_MS = 90000;
const MAX_LOG_BYTES = 200 * 1024;

const dir = () => app.getPath('userData');
const P = {
  settings: () => path.join(dir(), 'settings.json'),
  data: () => path.join(dir(), 'data.bin'),
  bak: () => path.join(dir(), 'data.bak'),
  log: () => path.join(dir(), 'errors.log')
};

// ---------- Registro de errores (sin datos personales) ----------
let rendererLogCount = 0;
setInterval(() => { rendererLogCount = 0; }, 60000).unref();

function logError(where, message, stack) {
  try {
    const entry = {
      t: new Date().toISOString(), v: app.getVersion(),
      where: String(where).slice(0, 60),
      msg: sec.redact(message, HOME).slice(0, 500),
      stack: sec.redact(stack || '', HOME).slice(0, 1500)
    };
    const f = P.log();
    try { if (fs.statSync(f).size > MAX_LOG_BYTES) fs.renameSync(f, f + '.old'); } catch {}
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  } catch {}
}
function readLog(max = 30) {
  try {
    return fs.readFileSync(P.log(), 'utf8').split('\n').filter(Boolean).slice(-max)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
process.on('uncaughtException', (e) => logError('main', e?.message, e?.stack));
process.on('unhandledRejection', (e) => logError('main-promise', e?.message || String(e), e?.stack));

// ---------- Archivos: escritura atómica y cifrado ----------
const cipher = {
  available: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b)
};
function writeAtomic(file, buf) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
const tryRead = (f) => { try { return JSON.parse(sec.unseal(fs.readFileSync(f), cipher)); } catch { return undefined; } };

let lastBak = 0;
function readData() {
  const hasMain = fs.existsSync(P.data());
  const hasBak = fs.existsSync(P.bak());
  if (!hasMain && !hasBak) return { state: 'none' };
  let d = hasMain ? tryRead(P.data()) : undefined;
  if (d !== undefined) return { state: 'ok', data: d };
  d = hasBak ? tryRead(P.bak()) : undefined;
  if (d !== undefined) {
    logError('db', 'Datos principales ilegibles; se recuperó la copia automática');
    return { state: 'recovered', data: d };
  }
  return { state: 'corrupt' };
}
function quarantine() {
  const ts = Date.now();
  for (const f of [P.data(), P.bak()]) { try { if (fs.existsSync(f)) fs.renameSync(f, f.replace(/\.(bin|bak)$/, '') + '.corrupt-' + ts); } catch {} }
}
function writeData(obj) {
  const json = JSON.stringify(obj);
  if (json.length > MAX_DB_CHARS) throw new Error('Datos demasiado grandes');
  const now = Date.now();
  // Copia automática del último estado legible (como máximo una por minuto)
  if (now - lastBak > 60000 && fs.existsSync(P.data()) && tryRead(P.data()) !== undefined) {
    try { fs.copyFileSync(P.data(), P.bak()); lastBak = now; } catch {}
  }
  writeAtomic(P.data(), sec.seal(json, cipher));
}

// ---------- Ajustes (claves de IA, PIN) ----------
const DEFAULTS = {
  provider: 'anthropic',
  models: { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' },
  keys: {}, pin: null, recovery: null, fails: 0, lockUntil: 0, autolockMin: 5
};
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(P.settings(), 'utf8'));
    return {
      ...structuredClone(DEFAULTS), ...s,
      models: { ...DEFAULTS.models, ...(s.models || {}) },
      keys: s.keys && typeof s.keys === 'object' ? s.keys : {},
      fails: Number(s.fails) || 0, lockUntil: Number(s.lockUntil) || 0,
      autolockMin: AUTOLOCK_OPTIONS.includes(s.autolockMin) ? s.autolockMin : 5
    };
  } catch (e) {
    if (e && e.code !== 'ENOENT') logError('settings', 'Ajustes ilegibles; se usan valores por defecto');
    return structuredClone(DEFAULTS);
  }
}
const saveSettings = (s) => writeAtomic(P.settings(), JSON.stringify(s, null, 2));

function encryptKey(text) {
  return cipher.available() ? 'enc:' + cipher.encrypt(text).toString('base64') : 'raw:' + Buffer.from(text).toString('base64');
}
function decryptKey(stored) {
  try {
    if (!stored) return '';
    const buf = Buffer.from(stored.slice(4), 'base64');
    return stored.startsWith('enc') ? cipher.decrypt(buf) : buf.toString();
  } catch { return ''; }
}

// ---------- Candado (PIN) ----------
let unlocked = false;
let lastActivity = Date.now();
const isOpen = () => !loadSettings().pin || unlocked;

function lockNow() {
  if (!loadSettings().pin) return;
  unlocked = false;
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('app:lock'); } catch {} }
}
function autolockTick() {
  const s = loadSettings();
  if (s.pin && unlocked && Date.now() - lastActivity > s.autolockMin * 60000) lockNow();
}

// Aplica la espera progresiva tras fallos; check() decide si el dato es correcto
function gate(s, check, wrongMsg) {
  const now = Date.now();
  if (s.lockUntil > now) return { ok: false, wait: Math.ceil((s.lockUntil - now) / 1000), error: 'Demasiados intentos.' };
  if (check()) {
    if (s.fails || s.lockUntil) { s.fails = 0; s.lockUntil = 0; saveSettings(s); }
    return { ok: true };
  }
  s.fails = (s.fails || 0) + 1;
  const d = sec.failDelayMs(s.fails);
  s.lockUntil = d ? now + d : 0;
  saveSettings(s);
  return { ok: false, error: wrongMsg, wait: d ? Math.ceil(d / 1000) : 0 };
}
function installPin(s, pin) {
  const salt = sec.newSalt();
  s.pin = { salt, hash: sec.hashSecret(pin, salt) };
  const code = sec.makeRecovery();
  const rs = sec.newSalt();
  s.recovery = { salt: rs, hash: sec.hashSecret(sec.normCode(code), rs) };
  s.fails = 0; s.lockUntil = 0;
  saveSettings(s);
  unlocked = true; lastActivity = Date.now();
  return code;
}
function pinProblem(pin) {
  if (!sec.validPin(pin)) return 'El PIN debe tener de 4 a 8 números.';
  if (sec.weakPin(pin)) return 'Ese PIN es muy fácil de adivinar (por ejemplo 1234 o 0000). Elige otro.';
  return null;
}

// ---------- IPC: solo desde nuestra propia interfaz ----------
const trusted = (e) => String(e?.senderFrame?.url || '').startsWith(APP_URL);
const LOCKED = { ok: false, error: 'La aplicación está bloqueada.', locked: true };

function handle(channel, fn, { open = true, lockedValue = LOCKED } = {}) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) { logError('ipc', 'Llamada rechazada en ' + channel); return { ok: false, error: 'No permitido.' }; }
    if (open && !isOpen()) return lockedValue;
    try {
      return await fn(...args);
    } catch (err) {
      logError('ipc:' + channel, err?.message, err?.stack);
      return { ok: false, error: 'Ocurrió un error interno. Se guardó un registro.' };
    }
  });
}

// ---------- Llamadas a los proveedores de IA ----------
function apiError(status, raw) {
  let msg;
  if (status === 401 || status === 403) msg = 'La clave no es válida o no tiene permiso. Revisa que la copiaste completa.';
  else if (status === 429) msg = 'Se alcanzó el límite de uso o la cuenta no tiene saldo. Revisa tu cuenta en la página del proveedor.';
  else if (status === 404) msg = 'El modelo escrito no existe. Revisa el nombre en Perfil → IA.';
  else if (status >= 500) msg = 'El proveedor tiene problemas en este momento. Intenta de nuevo en unos minutos.';
  else msg = sec.redact(raw || 'No se pudo completar la solicitud.', HOME).slice(0, 200);
  const err = new Error(msg);
  err.expected = true;
  return err;
}
async function postJSON(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, data?.error?.message);
    return data;
  } finally { clearTimeout(timer); }
}
async function callAI({ system, prompt }) {
  const s = loadSettings();
  const provider = s.provider;
  const key = decryptKey(s.keys[provider]);
  const model = s.models[provider];
  if (!key) { const e = new Error('Falta la API key. Agrégala en Perfil → IA.'); e.expected = true; throw e; }
  let text = '';
  if (provider === 'anthropic') {
    const d = await postJSON('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }] });
    text = (Array.isArray(d.content) ? d.content : []).map((b) => b.text || '').join('');
  } else if (provider === 'openai') {
    const d = await postJSON('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + key },
      { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] });
    text = d.choices?.[0]?.message?.content || '';
  } else if (provider === 'gemini') {
    const d = await postJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key },
      { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  } else {
    throw new Error('Proveedor no soportado');
  }
  if (!text.trim()) { const e = new Error('La IA no devolvió texto. Intenta de nuevo con otra redacción.'); e.expected = true; throw e; }
  return text;
}

let aiActive = 0;
handle('ai:generate', async (system, prompt) => {
  if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'La solicitud está vacía o no es válida.' };
  if (prompt.length > 120000 || system.length > 6000) return { ok: false, error: 'El texto es demasiado largo. Acórtalo e intenta de nuevo.' };
  if (aiActive >= 2) return { ok: false, error: 'Ya hay solicitudes en curso. Espera un momento.' };
  aiActive++;
  try {
    return { ok: true, text: await callAI({ system, prompt }) };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'La IA tardó demasiado en responder. Intenta de nuevo.' };
    if (err instanceof TypeError && (err.message === 'fetch failed' || err.cause)) return { ok: false, error: 'No hay conexión a internet. Revísala e intenta de nuevo.' };
    if (!err.expected) logError('ai', err?.message, err?.stack);
    return { ok: false, error: err.expected ? err.message : 'No se pudo completar la solicitud. Se guardó un registro.' };
  } finally { aiActive--; }
});

// ---------- Ajustes ----------
handle('settings:get', () => {
  const s = loadSettings();
  return { provider: s.provider, models: s.models, hasKey: Object.fromEntries(sec.PROVIDERS.map((p) => [p, !!s.keys[p]])) };
}, { lockedValue: { provider: 'anthropic', models: DEFAULTS.models, hasKey: {}, locked: true } });

handle('settings:save', (data) => {
  const { provider, models, apiKey } = data || {};
  if (!sec.PROVIDERS.includes(provider)) return { ok: false, error: 'Proveedor no válido.' };
  const s = loadSettings();
  for (const p of sec.PROVIDERS) {
    const m = models && models[p];
    if (m !== undefined && m !== '') {
      if (typeof m !== 'string' || !sec.MODEL_RE.test(m.trim())) return { ok: false, error: 'El nombre del modelo tiene caracteres no válidos.' };
      s.models[p] = m.trim();
    }
  }
  if (apiKey) {
    const k = sec.cleanKey(apiKey);
    if (!k) return { ok: false, error: 'La clave no parece válida (muy corta o con caracteres extraños).' };
    s.keys[provider] = encryptKey(k);
  }
  s.provider = provider;
  saveSettings(s);
  return { ok: true };
});

handle('settings:deleteKey', (provider) => {
  if (!sec.PROVIDERS.includes(provider)) return { ok: false, error: 'Proveedor no válido.' };
  const s = loadSettings();
  delete s.keys[provider];
  saveSettings(s);
  return { ok: true };
});

handle('settings:autolock', (min) => {
  if (!AUTOLOCK_OPTIONS.includes(min)) return { ok: false, error: 'Valor no válido.' };
  const s = loadSettings(); s.autolockMin = min; saveSettings(s);
  return { ok: true };
});

// ---------- Datos del docente (cifrados en disco) ----------
handle('db:load', () => {
  const r = readData();
  if (r.state === 'corrupt') quarantine();
  return { ok: true, ...r };
});
handle('db:save', (json) => {
  if (typeof json !== 'string' || json.length > MAX_DB_CHARS) return { ok: false, error: 'Datos no válidos o demasiado grandes.' };
  let obj;
  try { obj = JSON.parse(json); } catch { return { ok: false, error: 'Datos no válidos.' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'Datos no válidos.' };
  writeData(obj);
  return { ok: true };
});

// ---------- Candado: PIN, bloqueo y recuperación ----------
handle('pin:status', () => {
  const s = loadSettings();
  return { enabled: !!s.pin, locked: !!s.pin && !unlocked, encrypted: cipher.available(), autolockMin: s.autolockMin,
    wait: s.lockUntil > Date.now() ? Math.ceil((s.lockUntil - Date.now()) / 1000) : 0 };
}, { open: false });

handle('pin:unlock', (pin) => {
  const s = loadSettings();
  if (!s.pin) { unlocked = true; return { ok: true }; }
  const g = gate(s, () => sec.validPin(pin) && sec.verifySecret(pin, s.pin.salt, s.pin.hash), 'PIN incorrecto.');
  if (g.ok) { unlocked = true; lastActivity = Date.now(); }
  return g;
}, { open: false });

handle('pin:set', (newPin, currentPin) => {
  const s = loadSettings();
  const bad = pinProblem(newPin);
  if (bad) return { ok: false, error: bad };
  if (s.pin) {
    const g = gate(s, () => sec.validPin(currentPin) && sec.verifySecret(currentPin, s.pin.salt, s.pin.hash), 'El PIN actual no es correcto.');
    if (!g.ok) return g;
  }
  return { ok: true, recovery: installPin(s, newPin) };
});

handle('pin:disable', (pin) => {
  const s = loadSettings();
  if (!s.pin) return { ok: true };
  const g = gate(s, () => sec.validPin(pin) && sec.verifySecret(pin, s.pin.salt, s.pin.hash), 'El PIN no es correcto.');
  if (!g.ok) return g;
  s.pin = null; s.recovery = null; saveSettings(s); unlocked = true;
  return { ok: true };
});

handle('pin:lock', () => { if (loadSettings().pin) unlocked = false; return { ok: true }; }, { open: false });

handle('pin:recover', (code, newPin) => {
  const s = loadSettings();
  if (!s.pin || !s.recovery) return { ok: false, error: 'No hay PIN configurado.' };
  const bad = pinProblem(newPin);
  if (bad) return { ok: false, error: bad };
  const g = gate(s, () => sec.verifySecret(sec.normCode(code), s.recovery.salt, s.recovery.hash), 'El código de recuperación no es correcto.');
  if (!g.ok) return g;
  return { ok: true, recovery: installPin(s, newPin) };
}, { open: false });

handle('app:activity', () => { if (unlocked) lastActivity = Date.now(); return { ok: true }; }, { open: false });

// Borra TODO (datos, clave de IA y PIN). Se usa si se olvidó el PIN y el código de recuperación.
handle('app:resetAll', () => {
  for (const f of [P.data(), P.bak(), P.settings(), P.data() + '.tmp', P.settings() + '.tmp']) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { for (const f of fs.readdirSync(dir())) if (/^data\.corrupt-/.test(f)) fs.rmSync(path.join(dir(), f), { force: true }); } catch {}
  unlocked = true;
  return { ok: true };
}, { open: false });

// ---------- Información, registro de errores y enlaces ----------
handle('app:info', () => ({ version: app.getVersion(), encrypted: cipher.available() }), { open: false });

handle('log:error', (entry) => {
  if (!entry || typeof entry !== 'object' || ++rendererLogCount > 30) return { ok: false };
  logError('ui:' + String(entry.where || '').slice(0, 40), String(entry.message || '').slice(0, 500), String(entry.stack || '').slice(0, 1500));
  return { ok: true };
}, { open: false });
handle('log:get', () => ({ ok: true, entries: readLog(30) }));
handle('log:clear', () => { try { fs.rmSync(P.log(), { force: true }); fs.rmSync(P.log() + '.old', { force: true }); } catch {} return { ok: true }; });

handle('open:external', (url) => {
  if (typeof url === 'string' && url.length < 3000 && sec.isAllowedLink(url, ALLOWED_HOSTS, ABOUT.email)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

// ---------- Ventana ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600, title: 'EduPanel Docente',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, devTools: !app.isPackaged
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('did-start-loading', () => { if (loadSettings().pin) unlocked = false; }); // recargar = volver a pedir PIN
  win.webContents.on('render-process-gone', (_e, d) => {
    logError('renderer', 'La interfaz se cerró inesperadamente: ' + (d && d.reason));
    if (d && d.reason !== 'clean-exit') { try { win.reload(); } catch {} }
  });
  win.webContents.on('unresponsive', () => logError('renderer', 'La interfaz dejó de responder'));
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized && w.isMinimized()) w.restore(); w.focus(); }
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    wc.on('will-navigate', (ev) => ev.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const okPerms = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(okPerms.has(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => okPerms.has(perm));
    powerMonitor.on('lock-screen', lockNow);
    powerMonitor.on('suspend', lockNow);
    setInterval(autolockTick, 15000).unref();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { __test: { autolockTick, lockNow, logError, APP_URL, setActivity: (t) => { lastActivity = t; } } };
