// Entorno de pruebas: simula Electron para ejecutar el main.js y el preload.js REALES,
// y conecta la interfaz (jsdom) a ellos igual que lo haría la app instalada.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

function makeElectron(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edupanel-test-'));
  const handlers = {};
  const windows = [];
  const sent = [];
  const opened = [];
  const hooks = {};
  const state = { encryption: true, singleLock: opts.singleLock !== false };
  const appHandlers = {};
  class FakeWC {
    constructor() { this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; }
    send(ch, ...a) { sent.push([ch, ...a]); if (hooks.onSend) hooks.onSend(ch); }
    setWindowOpenHandler() {}
    reload() {}
  }
  class BrowserWindow {
    constructor(opts) { this.opts = opts; this.webContents = new FakeWC(); windows.push(this); }
    setMenuBarVisibility() {}
    loadFile(f) { this.file = f; }
    isMinimized() { return false; }
    focus() {}
    static getAllWindows() { return windows; }
  }
  const xor = (buf) => Buffer.from(buf.map((b) => b ^ 0x5a));
  const electron = {
    app: {
      getPath: () => dataDir, getVersion: () => '0.9.0', isPackaged: false,
      requestSingleInstanceLock: () => state.singleLock, quit: () => { state.quit = true; },
      on: (ev, fn) => { appHandlers[ev] = fn; },
      whenReady: () => Promise.resolve()
    },
    BrowserWindow,
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    safeStorage: {
      isEncryptionAvailable: () => state.encryption,
      encryptString: (s) => xor(Buffer.from(s, 'utf8')),
      decryptString: (b) => xor(Buffer.from(b)).toString('utf8')
    },
    shell: { openExternal: (u) => opened.push(u) },
    session: { defaultSession: { setPermissionRequestHandler(fn) { state.permReq = fn; }, setPermissionCheckHandler(fn) { state.permCheck = fn; } } },
    powerMonitor: { on: (ev, fn) => { state['pm:' + ev] = fn; } },
    Menu: { setApplicationMenu: (m) => { state.menu = m; } }
  };
  return { electron, dataDir, handlers, windows, sent, opened, state, appHandlers, hooks };
}

// Carga main.js con el Electron simulado y devuelve utilidades
function loadMain(opts = {}) {
  process.setMaxListeners(100);
  const env = makeElectron(opts);
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? env.electron : orig.call(this, req, ...rest); };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes('node_modules') && !k.includes(path.join('tests', ''))) delete require.cache[k];
  let mainExports;
  try { mainExports = require(path.join(ROOT, 'main.js')); } finally { Module._load = orig; }
  env.test = mainExports.__test;
  env.about = require(path.join(ROOT, 'src', 'about.config.js'));
  const trustedEvent = { senderFrame: { url: env.test.APP_URL + 'index.html' } };
  env.call = (ch, ...a) => env.handlers[ch](trustedEvent, ...a);
  env.callUntrusted = (ch, ...a) => env.handlers[ch]({ senderFrame: { url: 'https://evil.example/x.html' } }, ...a);
  env.file = (n) => path.join(env.dataDir, n);
  return env;
}

// Construye el objeto window.sigma a partir del preload.js REAL
function loadPreload(env) {
  let api = null;
  const lockCbs = [];
  const fakeRenderer = {
    contextBridge: { exposeInMainWorld: (_n, a) => { api = a; } },
    ipcRenderer: { invoke: (ch, ...a) => env.call(ch, ...a), on: (ch, cb) => { if (ch === 'app:lock') lockCbs.push(cb); } }
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fakeRenderer : orig.call(this, req, ...rest); };
  delete require.cache[path.join(ROOT, 'preload.js')];
  try { require(path.join(ROOT, 'preload.js')); } finally { Module._load = orig; }
  // Cuando main manda 'app:lock', avisamos al preload
  env.deliverLock = () => lockCbs.forEach((cb) => cb());
  env.hooks.onSend = (ch) => { if (ch === 'app:lock') env.deliverLock(); };
  return api;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function reporter(title) {
  const out = []; let fails = 0;
  return {
    ck: (name, cond) => { if (!cond) fails++; out.push((cond ? 'OK   ' : 'FAIL ') + name); },
    done: () => { console.log('== ' + title + '\n' + out.join('\n')); if (fails) process.exitCode = 1; return fails; }
  };
}
module.exports = { ROOT, loadMain, loadPreload, wait, reporter };
