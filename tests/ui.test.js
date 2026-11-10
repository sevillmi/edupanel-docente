// Pruebas de interfaz: la UI real (jsdom) conectada al main.js y preload.js REALES (Electron simulado)
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { ROOT, loadMain, loadPreload, wait, reporter } = require('./harness');
const { ck, done } = reporter('Interfaz + candado + errores (integración)');

async function makeUI({ legacy, skipSetup = true, email = '', prep } = {}) {
  const env = loadMain();
  await wait(15);
  if (prep) await prep(env); // deja archivos en la carpeta de datos ANTES de que la interfaz arranque
  const api = loadPreload(env);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.sigma = api; w.confirm = () => true;
  if (legacy) w.localStorage.setItem('edupanel-db', JSON.stringify(legacy));
  if (skipSetup) w.localStorage.setItem('edupanel-setup-skipped', '1');
  w.eval(fs.readFileSync(path.join(ROOT, 'src', 'about.config.js'), 'utf8'));
  w.ABOUT.email = email; env.about.email = email;
  w.eval(fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8') + '\nwindow.__t = { get db() { return db; }, get locked() { return locked; }, get dbReady() { return dbReady; }, get route() { return route; } };');
  const $ = (id) => w.document.getElementById(id);
  const ui = {
    env, api, w, $, view: () => $('view').textContent,
    until: async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(15); } return false; },
    pin: async (v) => { $('lpin').value = v; $('lgo').click(); await wait(160); },
    close: () => w.close()
  };
  return ui;
}
const basic = () => ({ institutions: [{ id: 'i1', name: 'Escuela Central' }], current: 'i1', theme: 'light',
  students: [{ id: 's1', inst: 'i1', name: 'Ana Mora', gender: 'Femenino', level: 'Sexto', section: '6-1', subject: 'Mate' }], evals: [], grades: [], attendance: [] });

(async () => {
  // ================= Migración, cifrado y XSS =================
  let u = await makeUI({ legacy: { ...basic(), institutions: [{ id: 'i1', name: 'Escuela <b>X</b>' }],
    students: [{ id: 's1', inst: 'i1', name: '<img src=x onerror="window.__pwn=1">', gender: 'Femenino' }, { id: 'bad" onmouseover="x', inst: 'i1', name: 'Malo' }] } });
  ck('arranca y carga los datos', await u.until(() => u.w.__t.dbReady && u.w.__t.locked === false));
  const stored = (await u.api.dbLoad());
  ck('migración: datos del navegador pasan a archivo cifrado y se borran de localStorage', stored.state === 'ok' && u.w.localStorage.getItem('edupanel-db') === null && !fs.readFileSync(u.env.file('data.bin')).toString('latin1').includes('Escuela'));
  ck('migración: registro con id manipulado descartado', stored.data.students.length === 1);
  u.w.go('registrar', 'estudiantes'); await wait(30);
  ck('XSS: nombre con HTML se muestra como texto, no se ejecuta', !u.$('view').querySelector('img') && u.w.__pwn === undefined && /<img src=x/.test(u.view()));
  ck('XSS: nombre de institución con HTML se escapa', !u.$('inst').querySelector('b') && /Escuela <b>X<\/b>/.test(u.$('inst').textContent));

  // guardar por la interfaz → va al archivo cifrado, no a localStorage
  u.$('n').value = 'Nuevo Estudiante'; u.$('add').click(); await wait(60);
  const after = await u.api.dbLoad();
  ck('agregar estudiante se guarda cifrado en disco', after.data.students.some((s) => s.name === 'Nuevo Estudiante') && u.w.localStorage.getItem('edupanel-db') === null);
  u.close();

  // ================= Candado =================
  u = await makeUI({ legacy: basic() });
  await u.until(() => u.w.__t.dbReady);
  u.w.go('perfil', 'seguridad');
  ck('Seguridad: muestra estado y formulario de PIN', await u.until(() => u.$('sp1')) && /Cifrado de datos/.test(u.view()) && /Registro de errores/.test(u.view()));
  u.$('sp1').value = '4821'; u.$('sp2').value = '4822'; u.$('spSet').click(); await wait(40);
  ck('PIN distinto en la confirmación → aviso', /no coinciden/.test(u.$('smsg').textContent));
  u.$('sp1').value = '1234'; u.$('sp2').value = '1234'; u.$('spSet').click();
  ck('PIN fácil de adivinar → aviso', await u.until(() => /muy fácil/.test(u.$('smsg').textContent)));
  u.$('sp1').value = '4821'; u.$('sp2').value = '4821'; u.$('spSet').click();
  ck('PIN válido → muestra el código de recuperación una sola vez', await u.until(() => u.$('recOk')));
  const RECOVERY = u.$('view').querySelector('.recovery .code').textContent.trim();
  ck('código con formato correcto', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/.test(RECOVERY));
  u.$('recOk').click(); await u.until(() => !u.$('recOk') && u.$('lockNow'));
  ck('tras confirmar, ya no se muestra el código y aparece "Bloquear ahora"', !/recovery/.test(u.$('view').innerHTML) && !!u.$('lockNow'));

  const snap = fs.readFileSync(u.env.file('data.bin'));
  u.$('lockNow').click(); await wait(40);
  ck('bloquear: pantalla de PIN visible y contenido borrado del DOM', !u.$('lock').hidden && u.w.document.body.classList.contains('locked') && u.$('view').innerHTML === '' && u.$('inst').innerHTML === '' && u.w.__t.dbReady === false && !/Ana Mora|Escuela Central/.test(u.w.document.body.textContent));
  u.w.save(); await wait(40);
  ck('bloqueada: guardar no pisa los datos', Buffer.compare(snap, fs.readFileSync(u.env.file('data.bin'))) === 0);
  ck('bloqueada: la API rechaza leer datos', (await u.api.dbLoad()).locked === true);
  await u.pin('1111');
  ck('PIN incorrecto → mensaje y sigue bloqueada', /incorrecto/.test(u.$('lmsg').textContent) && u.w.__t.locked === true);
  await u.pin('4821');
  ck('PIN correcto → vuelve al panel con los datos', await u.until(() => u.w.__t.locked === false && /Filtros del dashboard/.test(u.view())) && u.w.__t.db.students.length === 1 && u.$('lock').hidden);

  // autobloqueo (main avisa a la ventana)
  await u.api.setAutolock(1);
  u.env.test.setActivity(Date.now() - 61000); u.env.test.autolockTick(); await wait(40);
  ck('autobloqueo por inactividad: la interfaz se bloquea sola', u.w.__t.locked === true && !u.$('lock').hidden && u.$('view').innerHTML === '');
  // la actividad del usuario reinicia el contador
  await u.pin('4821'); await u.until(() => u.w.__t.locked === false);
  u.env.test.setActivity(Date.now() - 50000); u.w.document.dispatchEvent(new u.w.Event('mousemove')); await wait(30);
  u.env.test.autolockTick(); await wait(30);
  ck('mover el mouse cuenta como actividad (no se bloquea)', u.w.__t.locked === false);

  // olvidé mi PIN
  u.w.lockApp(); await wait(30);
  u.$('lforgot').click();
  u.$('rcode').value = 'AAAA-AAAA-AAAA'; u.$('rpin1').value = '7391'; u.$('rpin2').value = '7391'; u.$('rgo').click();
  ck('código de recuperación incorrecto → aviso', await u.until(() => /no es correcto/.test(u.$('rmsg').textContent)));
  u.$('rcode').value = RECOVERY.toLowerCase(); u.$('rpin1').value = '7391'; u.$('rpin2').value = '7390'; u.$('rgo').click();
  ck('PIN nuevo no coincide → aviso', await u.until(() => /no coinciden/.test(u.$('rmsg').textContent)));
  u.$('rpin2').value = '7391'; u.$('rgo').click();
  ck('recuperación correcta → muestra código nuevo', await u.until(() => u.$('rcont')) && u.$('rcont').disabled === true);
  const NEWCODE = u.$('lock').querySelector('.code').textContent.trim();
  ck('el código nuevo es distinto al anterior', NEWCODE !== RECOVERY);
  u.$('rsaved').checked = true; u.$('rsaved').dispatchEvent(new u.w.Event('change')); u.$('rcont').click();
  ck('continúa dentro de la app con los datos', await u.until(() => u.w.__t.locked === false && u.w.__t.db.students.length === 1 && /Filtros del dashboard/.test(u.view())));
  u.w.lockApp(); await wait(30); await u.pin('7391');
  ck('el PIN nuevo funciona', await u.until(() => u.w.__t.locked === false));

  // espera tras 5 fallos
  u.w.lockApp(); await wait(30);
  for (let i = 0; i < 5; i++) await u.pin('0001');
  ck('5 fallos → cuenta regresiva y campos desactivados', /Espera \d+ s/.test(u.$('lmsg').textContent) && u.$('lpin').disabled === true && u.$('lgo').disabled === true);
  await u.api.pinUnlock('7391'); // aún en espera: no debe entrar
  ck('mientras espera, ni el PIN correcto entra', (await u.api.dbLoad()).locked === true);
  u.close();

  // reinicio de la app: arranca bloqueada y pide PIN
  const env0 = u.env; const keepDir = env0.dataDir;
  const sObj = JSON.parse(fs.readFileSync(env0.file('settings.json'), 'utf8')); sObj.lockUntil = 0; fs.writeFileSync(env0.file('settings.json'), JSON.stringify(sObj));
  u = await makeUI({ prep: (e) => fs.cpSync(keepDir, e.dataDir, { recursive: true }) }); // misma carpeta de datos que la sesión anterior
  await wait(150);
  ck('al reiniciar con PIN, la app arranca bloqueada', !u.$('lock').hidden && u.w.__t.locked === true && u.$('view').innerHTML === '');
  await u.pin('7391');
  ck('y entra con el PIN', await u.until(() => u.w.__t.locked === false && u.w.__t.db.students.length === 1));
  // quitar el PIN desde Seguridad
  u.w.go('perfil', 'seguridad'); await u.until(() => u.$('offBtn'));
  u.$('off0').value = '0001'; u.$('offBtn').click(); await u.until(() => /no es correcto/.test(u.$('smsg').textContent));
  ck('quitar PIN exige el PIN correcto', /no es correcto/.test(u.$('smsg').textContent));
  u.$('off0').value = '7391'; u.$('offBtn').click(); await u.until(() => u.$('sp1'));
  ck('PIN quitado: vuelve el formulario para crear uno', !!u.$('sp1') && (await u.api.pinStatus()).enabled === false);
  // sin PIN, si se llama al bloqueo manual no hay candado que pedir
  u.close();

  // ================= Restablecer sin PIN ni código =================
  u = await makeUI({ legacy: basic() }); await u.until(() => u.w.__t.dbReady);
  u.w.go('perfil', 'seguridad'); await u.until(() => u.$('sp1')); u.$('sp1').value = '4821'; u.$('sp2').value = '4821'; u.$('spSet').click(); await u.until(() => u.$('recOk'));
  u.w.lockApp(); await wait(30); u.$('lforgot').click(); u.$('rwipe').click();
  u.$('wt').value = 'no'; u.$('wgo').click(); await wait(30);
  ck('restablecer pide escribir BORRAR', /Escribe BORRAR/.test(u.$('wmsg').textContent) && u.w.__t.locked === true);
  u.$('wt').value = 'borrar'; u.$('wgo').click();
  ck('restablecer: borra todo y vuelve al asistente de clave', await u.until(() => /Paso 1/.test(u.view())) && !fs.existsSync(u.env.file('data.bin')) && !fs.existsSync(u.env.file('settings.json')) && (await u.api.pinStatus()).enabled === false);
  u.close();

  // ================= Asistente de clave con el main real =================
  u = await makeUI({ skipSetup: false });
  ck('primer inicio sin clave → asistente', await u.until(() => /Paso 1/.test(u.view())));
  u.$('sk').value = 'abc'; u.$('go3').click(); await u.until(() => /no parece válida/.test(u.$('msg').textContent));
  ck('clave demasiado corta → aviso y no se guarda', /no parece válida/.test(u.$('msg').textContent) && !(await u.api.getSettings()).hasKey.anthropic);
  let mode = '401'; global.fetch = async () => (mode === '401' ? { ok: false, status: 401, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ content: [{ text: 'listo' }] }) });
  u.$('sk').value = 'sk-ant-api03-MALAMALAMALA'; u.$('go3').click(); await u.until(() => /no es válida/.test(u.$('msg').textContent));
  ck('clave rechazada por el proveedor → aviso claro y NO queda guardada', /no es válida/.test(u.$('msg').textContent) && !(await u.api.getSettings()).hasKey.anthropic);
  mode = 'ok'; u.$('sk').value = 'sk-ant-api03-BUENABUENABUENA'; u.$('go3').click();
  ck('clave válida → conectada', await u.until(() => u.$('start')) && (await u.api.getSettings()).hasKey.anthropic === true);
  u.$('start').click();
  ck('empezar lleva al panel/centro', await u.until(() => /Primero agrega tu centro|Filtros del dashboard/.test(u.view())));
  u.close();

  // ================= Errores: captura y registro =================
  u = await makeUI({ legacy: basic() }); await u.until(() => u.w.__t.dbReady);
  u.w.dispatchEvent(new u.w.ErrorEvent('error', { error: new Error('boom de prueba'), message: 'boom de prueba' })); await wait(50);
  ck('error de la interfaz → aviso amable y queda en el registro', /Se guardó un registro/.test(u.$('toasts').textContent) && (await u.api.logGet()).entries.some((e) => e.msg === 'boom de prueba'));
  const ev = new u.w.Event('unhandledrejection'); ev.reason = new Error('promesa rota'); u.w.dispatchEvent(ev); await wait(50);
  ck('promesa rechazada → también se registra', (await u.api.logGet()).entries.some((e) => e.msg === 'promesa rota'));
  ck('no se llena la pantalla de avisos (uno cada 10 s)', u.$('toasts').children.length === 1);
  u.w.viewPlanear = () => { throw new Error('vista rota'); };
  u.w.go('planear'); await wait(40);
  ck('una pantalla que falla muestra tarjeta de error en vez de quedar en blanco', /No se pudo mostrar esta pantalla/.test(u.view()) && (await u.api.logGet()).entries.some((e) => e.where === 'ui:vista:planear'));
  u.$('rb').click(); await wait(30);
  ck('"Volver al inicio" recupera la app', /Filtros del dashboard/.test(u.view()));
  const realInfo = u.w.sigma.appInfo; u.w.sigma.appInfo = async () => { throw new Error('info rota'); };
  u.w.go('perfil', 'acerca'); await wait(60);
  ck('una pantalla asíncrona que falla también se controla', /No se pudo mostrar esta pantalla/.test(u.view()));
  u.w.sigma.appInfo = realInfo;
  // arranque fallido → reintentar
  const realStatus = u.w.sigma.pinStatus; u.w.sigma.pinStatus = async () => { throw new Error('sin main'); };
  await u.w.boot();
  ck('si el arranque falla: pantalla con "Reintentar"', /No se pudo iniciar/.test(u.$('lock').textContent) && !!u.$('retry'));
  u.w.sigma.pinStatus = realStatus; u.$('retry').click();
  ck('reintentar recupera la app', await u.until(() => /Filtros del dashboard/.test(u.view()) && u.$('lock').hidden));

  // registro de errores visible en Seguridad (sin correo configurado)
  await u.api.logError({ where: 'demo', message: 'visible en la lista' });
  u.w.go('perfil', 'seguridad'); await u.until(() => u.$('logCopy'));
  ck('Seguridad muestra el registro; sin correo configurado no ofrece enviar', /visible en la lista/.test(u.view()) && !u.$('logMail') && /correo de contacto aún no está configurado/.test(u.view()));
  u.$('logClear').click();
  ck('borrar registro desde la interfaz', await u.until(() => /Sin errores registrados/.test(u.view())));
  u.close();

  // ================= Acerca de, FAQ y correo =================
  u = await makeUI({ legacy: basic(), email: 'contacto@ejemplo.com' }); await u.until(() => u.w.__t.dbReady);
  u.$('help').click(); await u.until(() => u.$('faqQ'));
  const total = u.w.document.querySelectorAll('details.faq').length;
  ck('el botón "?" abre las preguntas frecuentes (con varias preguntas)', total >= 15);
  u.$('faqQ').value = 'olvido'; u.$('faqQ').dispatchEvent(new u.w.Event('input'));
  const n1 = u.w.document.querySelectorAll('details.faq').length;
  ck('buscador filtra ("olvido" → pregunta del PIN)', n1 >= 1 && n1 < total && /PIN/.test(u.$('faqList').textContent));
  u.$('faqQ').value = 'SECCION INEXISTENTE zzz'; u.$('faqQ').dispatchEvent(new u.w.Event('input'));
  ck('buscador sin resultados', /No encontré nada/.test(u.$('faqList').textContent));
  u.$('faqQ').value = 'CLAVE'; u.$('faqQ').dispatchEvent(new u.w.Event('input'));
  const nMay = u.w.document.querySelectorAll('details.faq').length;
  u.$('faqQ').value = 'recuperacion'; u.$('faqQ').dispatchEvent(new u.w.Event('input'));
  ck('buscador ignora mayúsculas y tildes ("CLAVE" / "recuperacion" sin tilde)', nMay >= 3 && /código de recuperación/.test(u.$('faqList').textContent));
  u.w.go('perfil', 'acerca'); await u.until(() => /Por qué existe/.test(u.view()));
  ck('Acerca de: nombre, intención, versión, principios y aviso', /Michael Sevilla/.test(u.view()) && /Versión 0\.9\.0/.test(u.view()) && /Por qué existe/.test(u.view()) && /Privacidad primero/.test(u.view()) && /No es una herramienta oficial del Ministerio/.test(u.view()));
  ck('Acerca de: botón de contacto cuando hay correo', !!u.$('mailMe') && /contacto@ejemplo\.com/.test(u.view()));
  u.$('mailMe').click(); await wait(40);
  ck('el botón abre el correo del autor (y nada más)', u.env.opened.length === 1 && u.env.opened[0].startsWith('mailto:contacto@ejemplo.com'));
  ck('no se puede usar la app para abrir otro correo o enlace', (await u.api.openLink('mailto:otro@x.com')) === false && (await u.api.openLink('https://evil.com')) === false);
  await u.api.logError({ where: 'demo', message: 'Línea con ñandú y tildes ' + 'x'.repeat(900) });
  u.w.go('perfil', 'seguridad'); await u.until(() => u.$('logMail'));
  u.$('logMail').click(); await wait(40);
  ck('"Enviar por correo" arma un mailto válido (con asunto y registro) aunque el registro sea largo', u.env.opened.length === 2 && /subject=EduPanel/.test(u.env.opened[1]) && decodeURIComponent(u.env.opened[1]).includes('Registro técnico'));
  u.close();

  // ================= Importar / exportar respaldo y borrar todo =================
  u = await makeUI({ legacy: basic() }); await u.until(() => u.w.__t.dbReady);
  u.w.go('perfil', 'datos'); await u.until(() => u.$('imp'));
  ck('Datos: avisa que el respaldo no está cifrado', /NO está cifrado/.test(u.view()));
  const feed = async (text) => { const f = new u.w.File([text], 'r.json'); Object.defineProperty(u.$('file'), 'files', { value: [f], configurable: true }); u.$('file').dispatchEvent(new u.w.Event('change')); await wait(80); };
  await feed('{"hola":1}'); ck('respaldo con formato inválido → aviso', /no es un respaldo válido/.test(u.$('msg').textContent));
  await feed('esto no es json'); ck('archivo que no es JSON → aviso', /no es un respaldo válido/.test(u.$('msg').textContent));
  await feed(JSON.stringify({ current: 'zzz', theme: 'dark',
    institutions: [{ id: 'ok1', name: 'Escuela buena', zona: 'Rural' }, { id: 'id malo!', name: 'Mala' }],
    students: [{ id: 's9', inst: 'ok1', name: 'P'.repeat(500), age: '999', internet: 'quizá' }, { id: 's10', inst: 'noexiste', name: 'Huérfano' }, { id: 's11', inst: 'ok1', name: '  ' }],
    evals: [{ id: 'e1', inst: 'ok1', name: 'Prueba', due: 'mañana' }],
    grades: [{ evalId: 'e1', studentId: 's9', score: 5000 }, { evalId: 'e1', studentId: 'fantasma', score: 50 }, { evalId: 'e1', studentId: 's9', score: 'abc' }],
    attendance: [{ studentId: 's9', date: '2026-11-02', present: 1 }, { studentId: 's9', date: 'ayer', present: true }] }));
  const d = u.w.__t.db;
  ck('importar: se limpian ids malos, huérfanos y vacíos', d.institutions.length === 1 && d.students.length === 1 && d.evals.length === 1 && d.attendance.length === 1);
  ck('importar: valores fuera de rango o raros se corrigen', d.students[0].name.length === 120 && d.students[0].age === '' && d.students[0].internet === '' && d.evals[0].due === '' && d.grades.length === 1 && d.grades[0].score === 100 && d.current === 'ok1' && d.theme === 'dark');
  ck('importar: queda guardado cifrado', (await u.api.dbLoad()).data.institutions[0].name === 'Escuela buena');
  u.w.URL.createObjectURL = () => 'blob:test'; u.w.go('perfil', 'datos'); await u.until(() => u.$('exp'));
  const before = (await u.api.logGet()).entries.length; u.$('exp').click(); await wait(40);
  ck('exportar respaldo no genera errores', (await u.api.logGet()).entries.length === before);
  u.$('wipeT').value = 'x'; u.$('wipe').click(); await wait(30);
  ck('borrar todo exige escribir BORRAR', /Escribe BORRAR/.test(u.$('wmsg').textContent) && fs.existsSync(u.env.file('data.bin')));
  u.$('wipeT').value = 'borrar'; u.$('wipe').click();
  ck('borrar todo: elimina datos y vuelve al asistente', await u.until(() => /Paso 1/.test(u.view())) && !fs.existsSync(u.env.file('data.bin')) && u.w.__t.db.students.length === 0);
  u.close();

  // ================= Recuperación automática y datos dañados =================
  u = await makeUI({ prep: async (e) => {
    await e.call('db:save', JSON.stringify(basic())); await e.call('db:save', JSON.stringify({ ...basic(), institutions: [{ id: 'i1', name: 'Versión 2' }] }));
    fs.writeFileSync(e.file('data.bin'), 'EXXdañado'); } });
  await wait(150);
  ck('archivo dañado + copia buena → recupera y avisa', /Se recuperó la copia automática/.test(u.$('toasts').textContent) && u.w.__t.db.institutions[0].name === 'Escuela Central');
  u.close();
  u = await makeUI({ prep: (e) => { fs.writeFileSync(e.file('data.bin'), 'EXXdañado'); fs.writeFileSync(e.file('data.bak'), 'EXXdañado'); } });
  await wait(150);
  ck('todo dañado → avisa, conserva evidencia y deja empezar de nuevo', /No se pudieron leer los datos/.test(u.$('toasts').textContent) && u.w.__t.dbReady === true && fs.readdirSync(u.env.dataDir).some((f) => f.startsWith('data.corrupt-')));
  u.close();

  done();
})().catch((e) => { console.error('ERROR en la prueba', e); process.exit(1); });
