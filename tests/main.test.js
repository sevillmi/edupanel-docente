// Pruebas de la lógica de seguridad del proceso principal (main.js real, Electron simulado)
const fs = require('fs');
const path = require('path');
const { loadMain, reporter } = require('./harness');
const sec = require('../security');
const { ck, done } = reporter('Seguridad del proceso principal');

(async () => {
  // ---------- security.js (funciones puras) ----------
  ck('validPin acepta 4-8 dígitos', sec.validPin('4821') && sec.validPin('48213976') && !sec.validPin('123') && !sec.validPin('123456789') && !sec.validPin('12a4') && !sec.validPin(1234));
  ck('weakPin detecta 0000, 1234, 4321, 2580', ['0000', '1234', '4321', '2580', '99999'].every(sec.weakPin) && !sec.weakPin('4821') && !sec.weakPin('7391'));
  const salt = sec.newSalt(); const h = sec.hashSecret('4821', salt);
  ck('hash con sal: verifica bien y rechaza mal', sec.verifySecret('4821', salt, h) && !sec.verifySecret('4822', salt, h) && !sec.verifySecret('4821', sec.newSalt(), h) && h !== '4821');
  const rc = sec.makeRecovery();
  ck('código de recuperación con formato XXXX-XXXX-XXXX sin caracteres ambiguos', /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$/.test(rc) && sec.normCode(rc.toLowerCase() + ' ') === rc.replace(/-/g, ''));
  ck('espera progresiva', sec.failDelayMs(4) === 0 && sec.failDelayMs(5) === 30000 && sec.failDelayMs(10) === 60000 && sec.failDelayMs(15) === 120000 && sec.failDelayMs(100) === 900000);
  ck('cleanKey limpia espacios y rechaza basura', sec.cleanKey('  sk-ant-abc 123456789 \n') === 'sk-ant-abc123456789' && sec.cleanKey('corta') === null && sec.cleanKey('x'.repeat(401)) === null);
  const hosts = new Set(['aistudio.google.com']);
  ck('enlaces: solo https permitido, mailto solo al correo del autor',
    sec.isAllowedLink('https://aistudio.google.com/apikey', hosts) && !sec.isAllowedLink('https://aistudio.google.com.evil.com/', hosts) &&
    !sec.isAllowedLink('http://aistudio.google.com/', hosts) && !sec.isAllowedLink('file:///C:/Windows/System32/calc.exe', hosts) && !sec.isAllowedLink('javascript:alert(1)', hosts) &&
    sec.isAllowedLink('mailto:yo@correo.com?subject=Hola', hosts, 'yo@correo.com') && !sec.isAllowedLink('mailto:otro@correo.com', hosts, 'yo@correo.com') && !sec.isAllowedLink('mailto:yo@correo.com', hosts, ''));
  const red = sec.redact('Fallo con sk-ant-api03-ABCDEF123456 y AIzaSyABCDEFGHIJ y Bearer abc.def en C:\\Users\\Maria Lopez\\Desktop y "Ana Mora Rojas Perez de la Cruz 6-1 nota 90"', '/home/x');
  ck('redact oculta claves, usuario de Windows y citas largas', !/ABCDEF123456|AIzaSyABC|abc\.def|Maria|Ana Mora/.test(red) && /REDACTADO/.test(red) && /Users\\~/.test(red));
  const cip = { available: () => true, encrypt: (s) => Buffer.from(s).map((b) => b ^ 7), decrypt: (b) => Buffer.from(b.map((x) => x ^ 7)).toString() };
  ck('seal/unseal: ida y vuelta, y no queda texto plano', sec.unseal(sec.seal('hola Ñandú', cip), cip) === 'hola Ñandú' && !sec.seal('hola', cip).toString().includes('hola'));

  // ---------- main.js ----------
  const m = loadMain();
  const students = { institutions: [{ id: 'i1', name: 'Escuela X' }], students: [{ id: 's1', name: 'Ana Mora Secreta' }] };

  ck('rechaza llamadas desde un origen no confiable', (await m.callUntrusted('db:load')).ok === false && (await m.callUntrusted('ai:generate', 'a', 'b')).ok === false);
  ck('sin PIN: la app está abierta desde el inicio', (await m.call('pin:status')).enabled === false && (await m.call('db:load')).state === 'none');

  // datos cifrados en disco, atómicos y con copia
  ck('db:save rechaza JSON roto, arreglos y gigantes', (await m.call('db:save', '{x')).ok === false && (await m.call('db:save', '[1]')).ok === false && (await m.call('db:save', 'a'.repeat(21 * 1024 * 1024))).ok === false && (await m.call('db:save', 5)).ok === false);
  ck('db:save guarda y db:load recupera', (await m.call('db:save', JSON.stringify(students))).ok && JSON.stringify((await m.call('db:load')).data) === JSON.stringify(students));
  const raw = fs.readFileSync(m.file('data.bin'));
  ck('el archivo en disco NO contiene texto legible (cifrado)', !raw.toString('latin1').includes('Ana Mora') && !raw.toString('utf8').includes('Escuela X') && raw.subarray(0, 2).toString() === 'E1');
  ck('no quedan archivos temporales', !fs.existsSync(m.file('data.bin.tmp')));
  // copia automática y recuperación
  await m.call('db:save', JSON.stringify({ ...students, institutions: [{ id: 'i1', name: 'Segunda versión' }] }));
  ck('se creó la copia automática (data.bak)', fs.existsSync(m.file('data.bak')));
  fs.writeFileSync(m.file('data.bin'), Buffer.from('EBASURA-corrupta'));
  let r = await m.call('db:load');
  ck('archivo principal dañado → recupera desde la copia', r.state === 'recovered' && r.data.institutions[0].name === 'Escuela X');
  fs.writeFileSync(m.file('data.bak'), Buffer.from('xx'));
  r = await m.call('db:load');
  ck('ambos dañados → "corrupt" y se conservan como evidencia', r.state === 'corrupt' && fs.readdirSync(m.dataDir).some((f) => f.startsWith('data.corrupt-')) && !fs.existsSync(m.file('data.bin')));
  ck('tras corrupto, se puede empezar de cero', (await m.call('db:load')).state === 'none' && (await m.call('db:save', JSON.stringify(students))).ok);

  // cifrado no disponible
  m.state.encryption = false;
  await m.call('db:save', JSON.stringify(students));
  ck('sin cifrado del sistema: se informa y se lee igual', (await m.call('pin:status')).encrypted === false && (await m.call('db:load')).data.students[0].name === 'Ana Mora Secreta');
  m.state.encryption = true;
  await m.call('db:save', JSON.stringify(students));

  // ---------- Ajustes y claves ----------
  ck('settings:save valida proveedor, modelo y clave', (await m.call('settings:save', { provider: 'evil' })).ok === false &&
    (await m.call('settings:save', { provider: 'openai', models: { openai: '../../x; rm' } })).ok === false &&
    (await m.call('settings:save', { provider: 'openai', apiKey: 'corta' })).ok === false && (await m.call('settings:save', null)).ok === false);
  const KEY = 'sk-ant-api03-SECRETKEY1234567890';
  ck('guarda clave válida', (await m.call('settings:save', { provider: 'anthropic', models: { anthropic: 'claude-sonnet-5-5' }, apiKey: ' ' + KEY + ' ' })).ok);
  const st = fs.readFileSync(m.file('settings.json'), 'utf8');
  ck('la clave en disco no está en texto plano ni en base64 simple', !st.includes('SECRETKEY') && !st.includes(Buffer.from(KEY).toString('base64')));
  const gs = await m.call('settings:get');
  ck('settings:get nunca devuelve la clave', JSON.stringify(gs).includes('SECRETKEY') === false && gs.hasKey.anthropic === true);

  // ---------- IA: llamadas, errores y tiempos ----------
  let lastReq = null; let mode = 'ok';
  global.fetch = async (url, opts) => {
    lastReq = { url, opts, body: JSON.parse(opts.body) };
    if (mode === 'offline') throw new TypeError('fetch failed');
    if (mode === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    const mk = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (mode === '401') return mk(401, { error: { message: 'invalid x-api-key' } });
    if (mode === '429') return mk(429, {});
    if (mode === '500') return mk(500, 'no-json');
    if (mode === 'html') return { ok: true, status: 200, json: async () => { throw new Error('no json'); } };
    if (mode === 'empty') return mk(200, { content: [{ text: '  ' }] });
    return mk(200, { content: [{ type: 'text', text: 'Respuesta ' }, { type: 'text', text: 'lista' }] });
  };
  r = await m.call('ai:generate', 'sistema', 'hola');
  ck('Claude: ok, encabezados correctos y texto unido', r.ok && r.text === 'Respuesta lista' && lastReq.opts.headers['x-api-key'] === KEY && lastReq.url.startsWith('https://api.anthropic.com/') && lastReq.body.messages[0].content === 'hola');
  for (const [md, re] of [['401', /clave no es válida/], ['429', /límite de uso|saldo/], ['500', /problemas en este momento/], ['offline', /conexión a internet/], ['empty', /no devolvió texto/], ['html', /no devolvió texto/]]) {
    mode = md; r = await m.call('ai:generate', 's', 'hola');
    ck(`IA modo ${md}: mensaje claro en español`, r.ok === false && re.test(r.error) && !r.error.includes(KEY));
  }
  mode = 'ok';
  ck('IA: valida entradas', (await m.call('ai:generate', 5, 'x')).ok === false && (await m.call('ai:generate', 's', '   ')).ok === false && (await m.call('ai:generate', 's', 'x'.repeat(120001))).ok === false);
  // OpenAI y Gemini
  await m.call('settings:save', { provider: 'openai', apiKey: 'sk-proj-OPENAIKEY123456' });
  global.fetch = async (url, opts) => { lastReq = { url, opts, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'de OpenAI' } }] }) }; };
  r = await m.call('ai:generate', 's', 'p');
  ck('OpenAI: Bearer y respuesta', r.ok && r.text === 'de OpenAI' && lastReq.opts.headers.authorization === 'Bearer sk-proj-OPENAIKEY123456');
  await m.call('settings:save', { provider: 'gemini', apiKey: 'AIzaSyGEMINIKEY12345' });
  global.fetch = async (url, opts) => { lastReq = { url, opts, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'de ' }, { text: 'Gemini' }] } }] }) }; };
  r = await m.call('ai:generate', 's', 'p');
  ck('Gemini: la clave va en encabezado (no en la URL)', r.ok && r.text === 'de Gemini' && !lastReq.url.includes('AIza') && lastReq.opts.headers['x-goog-api-key'] === 'AIzaSyGEMINIKEY12345');
  await m.call('settings:save', { provider: 'anthropic' });
  ck('borrar clave funciona y valida proveedor', (await m.call('settings:deleteKey', 'zzz')).ok === false && (await m.call('settings:deleteKey', 'gemini')).ok && (await m.call('settings:get')).hasKey.gemini === false);
  // límite de solicitudes simultáneas
  const releases = []; global.fetch = () => new Promise((res) => { releases.push(() => res({ ok: true, status: 200, json: async () => ({ content: [{ text: 'x' }] }) })); });
  const p1 = m.call('ai:generate', 's', 'a'); const p2 = m.call('ai:generate', 's', 'b'); await new Promise((r2) => setTimeout(r2, 10));
  const p3 = await m.call('ai:generate', 's', 'c');
  ck('máximo 2 solicitudes simultáneas', p3.ok === false && /en curso/.test(p3.error));
  releases.forEach((f) => f()); await p1; await p2;
  // tiempo agotado: reducimos el tiempo usando temporizadores falsos
  const realST = global.setTimeout; mode = 'hang';
  global.fetch = async (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  global.setTimeout = (fn, ms, ...a) => realST(fn, ms === 90000 ? 20 : ms, ...a);
  r = await m.call('ai:generate', 's', 'hola'); global.setTimeout = realST;
  ck('IA que no responde: se corta con aviso claro', r.ok === false && /tardó demasiado/.test(r.error));

  // ---------- PIN ----------
  ck('PIN débil y mal formado rechazados', (await m.call('pin:set', '1234')).ok === false && (await m.call('pin:set', '0000')).ok === false && (await m.call('pin:set', 'abcd')).ok === false && (await m.call('pin:set', '12')).ok === false);
  r = await m.call('pin:set', '4821');
  const RECOVERY = r.recovery;
  ck('crear PIN devuelve código de recuperación', r.ok && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/.test(RECOVERY));
  const sj = fs.readFileSync(m.file('settings.json'), 'utf8');
  ck('PIN y código se guardan solo como hash con sal', !sj.includes('4821') && !sj.includes(RECOVERY.replace(/-/g, '')) && /"salt"/.test(sj));
  ck('con PIN activo y sesión abierta se puede seguir', (await m.call('db:load')).ok === true);
  await m.call('pin:lock');
  const lk = await m.call('db:load');
  ck('bloqueada: datos, IA, ajustes y registro quedan inaccesibles', lk.locked === true && (await m.call('db:save', '{}')).locked === true && (await m.call('ai:generate', 's', 'p')).locked === true && (await m.call('settings:get')).hasKey.anthropic === undefined && (await m.call('log:get')).locked === true && (await m.call('open:external', 'https://aistudio.google.com/')).locked === true);
  ck('bloqueada: el estado sí se puede consultar', (await m.call('pin:status')).locked === true);
  r = await m.call('pin:unlock', '1111');
  ck('PIN incorrecto rechazado', r.ok === false && /incorrecto/.test(r.error) && (await m.call('db:load')).locked === true);
  for (let i = 0; i < 3; i++) await m.call('pin:unlock', '2222');
  r = await m.call('pin:unlock', '3333'); // quinto fallo
  ck('5 fallos → espera de 30 s', r.ok === false && r.wait >= 29);
  r = await m.call('pin:unlock', '4821');
  ck('durante la espera ni el PIN correcto entra', r.ok === false && r.wait > 0);
  const sObj = JSON.parse(fs.readFileSync(m.file('settings.json'), 'utf8'));
  sObj.lockUntil = Date.now() - 1; fs.writeFileSync(m.file('settings.json'), JSON.stringify(sObj));
  r = await m.call('pin:unlock', '4821');
  ck('pasada la espera, el PIN correcto entra y se limpian los fallos', r.ok === true && (await m.call('db:load')).ok === true && JSON.parse(fs.readFileSync(m.file('settings.json'), 'utf8')).fails === 0);
  // la espera sobrevive a reiniciar la app
  await m.call('pin:lock'); for (let i = 0; i < 5; i++) await m.call('pin:unlock', '9090');
  const m2 = (() => { const keep = m.dataDir; const e2 = loadMain(); fs.cpSync(keep, e2.dataDir, { recursive: true }); return e2; })();
  ck('reiniciar la app no reinicia el castigo', (await m2.call('pin:status')).wait > 0 && (await m2.call('pin:unlock', '4821')).ok === false);
  const so = JSON.parse(fs.readFileSync(m.file('settings.json'), 'utf8')); so.lockUntil = 0; fs.writeFileSync(m.file('settings.json'), JSON.stringify(so));
  await m.call('pin:unlock', '4821');

  // cambiar / quitar PIN
  ck('cambiar PIN exige el actual', (await m.call('pin:set', '7391', 'xxxx')).ok === false && (await m.call('pin:set', '7391')).ok === false);
  r = await m.call('pin:set', '7391', '4821');
  ck('cambiar PIN: ok y genera código nuevo', r.ok && r.recovery !== RECOVERY);
  await m.call('pin:lock');
  ck('el PIN viejo ya no sirve y el nuevo sí', (await m.call('pin:unlock', '4821')).ok === false && (await m.call('pin:unlock', '7391')).ok === true);
  const NEWREC = r.recovery;

  // recuperación
  await m.call('pin:lock');
  ck('código de recuperación viejo (invalidado) no sirve', (await m.call('pin:recover', RECOVERY, '5566')).ok === false);
  ck('recuperación valida el PIN nuevo', (await m.call('pin:recover', NEWREC, '1111')).ok === false);
  r = await m.call('pin:recover', NEWREC.toLowerCase().replace(/-/g, ' '), '8264');
  ck('recuperación con el código correcto (sin importar mayúsculas/guiones)', r.ok && r.recovery !== NEWREC && (await m.call('db:load')).ok === true);
  await m.call('pin:lock');
  ck('tras recuperar, el PIN nuevo funciona', (await m.call('pin:unlock', '8264')).ok === true);
  ck('quitar PIN exige el PIN', (await m.call('pin:disable', '0000')).ok === false && (await m.call('pin:disable', '8264')).ok === true && (await m.call('pin:status')).enabled === false);

  // autobloqueo
  await m.call('pin:set', '4821');
  ck('autolock acepta solo valores permitidos', (await m.call('settings:autolock', 3)).ok === false && (await m.call('settings:autolock', 1)).ok === true);
  m.sent.length = 0; m.test.autolockTick();
  ck('no se bloquea mientras hay actividad reciente', (await m.call('db:load')).ok === true && m.sent.length === 0);
  m.test.setActivity(Date.now() - 61000); m.test.autolockTick();
  ck('se bloquea sola tras la inactividad y avisa a la ventana', (await m.call('db:load')).locked === true && m.sent.some((x) => x[0] === 'app:lock'));
  await m.call('pin:unlock', '4821'); m.test.setActivity(Date.now() - 61000);
  await m.call('app:activity'); m.test.autolockTick();
  ck('"actividad" reinicia el contador', (await m.call('db:load')).ok === true);

  // restablecer todo
  await m.call('pin:lock');
  ck('restablecer funciona estando bloqueada y borra todo', (await m.call('app:resetAll')).ok && !fs.existsSync(m.file('data.bin')) && !fs.existsSync(m.file('data.bak')) && !fs.existsSync(m.file('settings.json')) && (await m.call('pin:status')).enabled === false && (await m.call('db:load')).state === 'none');

  // ---------- Registro de errores ----------
  await m.call('log:clear');
  await m.call('log:error', { where: 'prueba', message: 'Fallo con ' + KEY + ' en C:\\Users\\Mike Sevilla\\x', stack: 'at C:\\Users\\Mike Sevilla\\app.js:1' });
  let lg = (await m.call('log:get')).entries;
  ck('el registro guarda el error sin claves ni usuario de Windows', lg.length === 1 && lg[0].where === 'ui:prueba' && !JSON.stringify(lg).includes('SECRETKEY') && !/Mike|Sevilla/.test(JSON.stringify(lg)) && lg[0].v === '0.9.0');
  for (let i = 0; i < 60; i++) await m.call('log:error', { where: 'spam', message: 'x' });
  ck('límite de 30 reportes por minuto desde la interfaz', (await m.call('log:get')).entries.length <= 31);
  ck('log:error ignora entradas inválidas', (await m.call('log:error', null)).ok === false && (await m.call('log:error', 'texto')).ok === false);
  await m.call('log:clear');
  ck('borrar registro', (await m.call('log:get')).entries.length === 0);
  // error interno en un manejador → no revienta y deja rastro
  m.test.logError('main', 'Error de prueba en C:\\Users\\Pepe\\x');
  ck('errores internos quedan registrados y redactados', JSON.stringify((await m.call('log:get')).entries).includes('Pepe') === false);

  // enlaces
  ck('open:external solo abre lo permitido', (await m.call('open:external', 'https://platform.claude.com/settings/keys')) === true && (await m.call('open:external', 'https://evil.com')) === false && (await m.call('open:external', 'file:///etc/passwd')) === false && (await m.call('open:external', { a: 1 })) === false);
  ck('solo se abrió lo permitido', m.opened.length === 1 && m.opened[0].startsWith('https://platform.claude.com'));

  // ---------- Ventana y endurecimiento ----------
  const m3 = loadMain(); await new Promise((r2) => setTimeout(r2, 20));
  const w = m3.windows[0];
  ck('ventana creada con aislamiento, sandbox y sin Node', w && w.opts.webPreferences.contextIsolation === true && w.opts.webPreferences.sandbox === true && w.opts.webPreferences.nodeIntegration === false && w.opts.webPreferences.webSecurity === true);
  ck('se carga solo el archivo local', /src[\\/]index\.html$/.test(w.file));
  ck('menú de la aplicación eliminado', m3.state.menu === null);
  ck('permisos: solo portapapeles', await new Promise((res) => m3.state.permReq(null, 'clipboard-read', res)) === true && await new Promise((res) => m3.state.permReq(null, 'media', res)) === false && m3.state.permCheck(null, 'geolocation') === false && await new Promise((res) => m3.state.permReq(null, 'notifications', res)) === false);
  const wc = { h: {}, on(e, f) { this.h[e] = f; }, setWindowOpenHandler(f) { this.f = f; } };
  m3.appHandlers['web-contents-created'](null, wc);
  let prevented = 0; wc.h['will-navigate']({ preventDefault: () => prevented++ }); wc.h['will-attach-webview']({ preventDefault: () => prevented++ });
  ck('navegación, webviews y ventanas nuevas bloqueadas', prevented === 2 && wc.f().action === 'deny');
  const m4 = loadMain({ singleLock: false }); await new Promise((r2) => setTimeout(r2, 20));
  ck('segunda instancia: se cierra sin abrir ventana', m4.state.quit === true && m4.windows.length === 0);
  done();
})().catch((e) => { console.error('ERROR en la prueba', e); process.exit(1); });
