// ================= EduPanel Docente =================
const PASS = 70; // nota mínima de aprobación (ajústala si tu nivel usa otra)
const PROVIDERS = { anthropic: 'Claude (Anthropic)', openai: 'OpenAI', gemini: 'Gemini (Google)' };
const SYSTEM_BASE =
  'Eres un asistente para docentes de Costa Rica (MEP). Responde siempre en español, ' +
  'con lenguaje claro y profesional, alineado a los programas de estudio del MEP cuando aplique.';

const $ = (id) => document.getElementById(id);
const $view = $('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (n) => (n == null ? '—' : String(Math.round(n * 10) / 10));

// ---------- Avisos y registro de errores ----------
function toast(msg, kind = '') {
  try {
    const t = document.createElement('div');
    t.className = 'toast ' + kind; t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 7000);
  } catch {}
}
let lastErrToast = 0;
function reportError(where, err) {
  try {
    window.sigma.logError({ where, message: String((err && err.message) || err || 'Error'), stack: String((err && err.stack) || '') }).catch(() => {});
  } catch {}
  const n = Date.now();
  if (n - lastErrToast > 10000) {
    lastErrToast = n;
    toast('Algo no salió como se esperaba. Se guardó un registro del problema (Perfil → Seguridad).', 'err');
  }
}
window.addEventListener('error', (e) => reportError('ui', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('ui-promise', e.reason));

// ---------- Datos (en memoria; el guardado cifrado lo hace el proceso principal) ----------
const EMPTY = () => ({ institutions: [], current: null, students: [], evals: [], grades: [], attendance: [], theme: 'light' });
let db = EMPTY();
let dbReady = false; // hasta cargar los datos reales NO se guarda nada (evita pisarlos con datos vacíos)
let locked = true;

function save() {
  if (!dbReady || locked) return;
  window.sigma.dbSave(JSON.stringify(db)).then((r) => {
    if (r && r.ok === false && !r.locked) toast('No se pudieron guardar los datos. Haz un respaldo en Perfil → Datos y seguridad.', 'err');
  }).catch((e) => reportError('guardar', e));
}

// Reconstruye los datos con campos y tamaños permitidos (protege contra archivos dañados o manipulados)
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n = 200) => String(v ?? '').slice(0, n);
function sanitizeDb(d) {
  const out = EMPTY();
  if (!d || typeof d !== 'object') return out;
  const arr = (a, max) => (Array.isArray(a) ? a.slice(0, max) : []);
  const okId = (x) => typeof x === 'string' && ID_RE.test(x);
  out.institutions = arr(d.institutions, 50).filter((i) => i && okId(i.id)).map((i) => ({
    id: i.id, name: str(i.name, 120), region: str(i.region, 120), provincia: str(i.provincia, 80), canton: str(i.canton, 80),
    distrito: str(i.distrito, 80), zona: ZONAS.includes(i.zona) ? i.zona : '', contexto: str(i.contexto, 2000), profile: str(i.profile, 4000) }));
  const insts = new Set(out.institutions.map((i) => i.id));
  out.students = arr(d.students, 5000).filter((s) => s && okId(s.id) && insts.has(s.inst) && str(s.name).trim())
    .map((s) => ({ id: s.id, inst: s.inst, ...normStudent(s) }));
  const sids = new Set(out.students.map((s) => s.id));
  out.evals = arr(d.evals, 5000).filter((e) => e && okId(e.id) && insts.has(e.inst)).map((e) => ({
    id: e.id, inst: e.inst, name: str(e.name, 120), subject: str(e.subject, 80),
    due: DATE_RE.test(e.due) ? e.due : '', created: DATE_RE.test(e.created) ? e.created : '' }));
  const eids = new Set(out.evals.map((e) => e.id));
  out.grades = arr(d.grades, 100000).filter((g) => g && eids.has(g.evalId) && sids.has(g.studentId) && Number.isFinite(+g.score))
    .map((g) => ({ evalId: g.evalId, studentId: g.studentId, score: Math.max(0, Math.min(100, +g.score)) }));
  out.attendance = arr(d.attendance, 300000).filter((a) => a && sids.has(a.studentId) && DATE_RE.test(a.date))
    .map((a) => ({ studentId: a.studentId, date: a.date, present: !!a.present }));
  out.current = insts.has(d.current) ? d.current : out.institutions[0]?.id || null;
  out.theme = d.theme === 'dark' ? 'dark' : 'light';
  return out;
}

// ---------- Estado de interfaz ----------
let route = { tab: 'registrar', sub: 'panel' };
let filters = { gender: '', level: '', section: '', subject: '' };
let attRange = 14;
let selEval = null;
let attDate = iso(new Date());
let aiCfg = { provider: 'anthropic', hasKey: {} };

function go(tab, sub) {
  route = { tab, sub: sub || (tab === 'registrar' ? 'panel' : tab === 'crear' ? 'evaluacion' : '') };
  render();
}

// ---------- Cabecera ----------
function renderHeader() {
  document.documentElement.dataset.theme = db.theme;
  const sel = $('inst');
  sel.innerHTML =
    (db.institutions.length ? '' : '<option value="">Selecciona institución</option>') +
    db.institutions.map((i) => `<option value="${esc(i.id)}" ${i.id === db.current ? 'selected' : ''}>${esc(i.name)}</option>`).join('') +
    '<option value="__new">+ Nueva institución</option>';
  if (!db.institutions.length) sel.value = '';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === route.tab));
  $('aiStatus').textContent = aiCfg.hasKey[aiCfg.provider] ? '● IA: ' + PROVIDERS[aiCfg.provider] : '○ IA sin configurar';
}
$('inst').onchange = (e) => {
  if (e.target.value === '__new') return go('perfil', 'centros');
  db.current = e.target.value || null; save(); render();
};
$('theme').onclick = () => { db.theme = db.theme === 'dark' ? 'light' : 'dark'; save(); renderHeader(); };
$('avatar').onclick = () => go('perfil');
$('help').onclick = () => go('perfil', 'faq');
$('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); };

async function refreshAI() {
  const s = await window.sigma.getSettings();
  aiCfg = { provider: s.provider, hasKey: s.hasKey, models: s.models };
  renderHeader();
  return s;
}

// ---------- Utilidades de vista ----------
function subnav(items, cur) {
  return `<div class="subnav">${items.map(([k, l]) => `<button data-sub="${k}" class="${k === cur ? 'active' : ''}">${l}</button>`).join('')}</div>`;
}
function bindSubnav() {
  $view.querySelectorAll('.subnav button').forEach((b) => (b.onclick = () => go(route.tab, b.dataset.sub)));
}
function needInst() {
  if (db.current) return true;
  $view.innerHTML = `<div class="card empty"><b>Primero agrega tu centro educativo.</b><br><br>
    <button class="primary" id="goc">Agregar centro</button></div>`;
  $('goc').onclick = () => go('perfil', 'centros');
  return false;
}
const scopedStudents = () => db.students.filter((s) => s.inst === db.current);
const scopedEvals = () => db.evals.filter((e) => e.inst === db.current);

function listHTML(items, empty) {
  return items.length ? `<ul class="list">${items.join('')}</ul>` : `<div class="empty">${empty}</div>`;
}
function card(title, subt, body, right = '') {
  return `<div class="card"><div class="card-h"><div><h2>${title}</h2><small>${subt}</small></div>${right}</div>${body}</div>`;
}
function bars(data, color) {
  if (!data.length) return '';
  return data.map((d) => `<div class="bar"><span class="n">${esc(d.label)}</span>
    <span class="tr"><span class="f" style="display:block;width:${Math.max(0, Math.min(100, d.pct))}%;--c:${d.color || color || 'var(--blue)'}"></span></span>
    <span class="x">${esc(d.text)}</span></div>`).join('');
}
function lineSvg(points) {
  const W = 300, H = 120, p = 14;
  const x = (i) => (points.length === 1 ? W / 2 : p + (i * (W - 2 * p)) / (points.length - 1));
  const y = (v) => H - p - (v / 100) * (H - 2 * p);
  const pts = points.map((q, i) => `${x(i)},${y(q.value)}`).join(' ');
  return `<svg class="line" viewBox="0 0 ${W} ${H + 14}" preserveAspectRatio="none">
    <line x1="${p}" y1="${y(PASS)}" x2="${W - p}" y2="${y(PASS)}" stroke="currentColor" opacity=".15" stroke-dasharray="3 3"/>
    <polyline points="${pts}" fill="none" stroke="#159947" stroke-width="2.5" stroke-linejoin="round"/>
    ${points.map((q, i) => `<circle cx="${x(i)}" cy="${y(q.value)}" r="3" fill="#159947"><title>${esc(q.label)}: ${fmt(q.value)}%</title></circle>`).join('')}
    <text x="${p}" y="${H + 10}" font-size="9" fill="currentColor" opacity=".6">${esc(points[0].label)}</text>
    <text x="${W - p}" y="${H + 10}" font-size="9" text-anchor="end" fill="currentColor" opacity=".6">${esc(points[points.length - 1].label)}</text></svg>`;
}

// ---------- Cálculo de métricas del panel ----------
function metrics(f) {
  const students = scopedStudents().filter((s) =>
    (!f.gender || s.gender === f.gender) && (!f.level || s.level === f.level) &&
    (!f.section || s.section === f.section) && (!f.subject || s.subject === f.subject));
  const ids = new Set(students.map((s) => s.id));
  const evals = scopedEvals().filter((e) => !f.subject || !e.subject || e.subject === f.subject);
  const evMap = Object.fromEntries(evals.map((e) => [e.id, e]));
  const grades = db.grades.filter((g) => ids.has(g.studentId) && evMap[g.evalId]);
  const att = db.attendance.filter((a) => ids.has(a.studentId));

  const rows = students.map((s) => {
    const sc = grades.filter((g) => g.studentId === s.id).map((g) => g.score);
    return { s, avg: avgOf(sc), abs: att.filter((a) => a.studentId === s.id && !a.present).length };
  });
  const graded = rows.filter((r) => r.avg != null);
  const general = avgOf(graded.map((r) => r.avg));
  const risk = (r) => r.avg != null && r.avg < PASS;
  const doble = rows.filter((r) => risk(r) && r.abs >= 3);
  const desercion = rows.filter((r) => r.abs >= 3);
  const alertas = rows.filter((r) => risk(r) || r.abs >= 3);

  const now = new Date(); const t0 = iso(now);
  const t7 = iso(new Date(now.getTime() + 7 * 864e5));
  const porVencer = evals.filter((e) => e.due && e.due >= t0 && e.due <= t7).sort((a, b) => a.due.localeCompare(b.due));

  const byMonth = {};
  grades.forEach((g) => { const e = evMap[g.evalId]; const m = (e.due || e.created || t0).slice(0, 7); (byMonth[m] ||= []).push(g.score); });
  const periodos = Object.keys(byMonth).sort().map((m) => ({
    m, avg: avgOf(byMonth[m]), pass: (byMonth[m].filter((v) => v >= PASS).length / byMonth[m].length) * 100 }));

  const dist = [['0–59', 0, 59], ['60–69', 60, 69], ['70–79', 70, 79], ['80–89', 80, 89], ['90–100', 90, 100]].map(([l, a, b]) => ({
    label: l, n: grades.filter((g) => g.score >= a && g.score <= b).length }));

  const alertMonths = {};
  att.filter((a) => !a.present).forEach((a) => { const m = a.date.slice(0, 7); ((alertMonths[m] ||= {})[a.studentId] ||= 0); alertMonths[m][a.studentId]++; });
  const alertTrend = Object.keys(alertMonths).sort().slice(-6).map((m) => ({
    m, n: Object.values(alertMonths[m]).filter((c) => c >= 3).length }));

  return { students, rows, graded, general, doble, desercion, alertas, porVencer, evals, periodos, dist, alertTrend, att,
    top: [...graded].sort((a, b) => b.avg - a.avg).slice(0, 5),
    worst: [...graded].sort((a, b) => a.avg - b.avg).slice(0, 5),
    cobertura: students.length ? (graded.length / students.length) * 100 : 0 };
}
function attendanceSeries(m, days) {
  const out = []; const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = iso(new Date(now.getTime() - i * 864e5));
    const recs = m.att.filter((a) => a.date === d);
    if (recs.length) out.push({ label: d.slice(5), value: (recs.filter((r) => r.present).length / recs.length) * 100 });
  }
  return out;
}

// ================= VISTAS: REGISTRAR =================
const REG_TABS = [['panel', 'Panel'], ['estudiantes', 'Estudiantes'], ['asistencia', 'Asistencia'], ['notas', 'Notas']];

function viewRegistrar() {
  if (!needInst()) return;
  ({ panel, estudiantes, asistencia, notas }[route.sub] || panel)();
}

function panel() {
  const all = scopedStudents();
  const opts = (k) => [...new Set(all.map((s) => s[k]).filter(Boolean))].sort();
  const sel = (id, label, k, all_) => `<div><label>${label}</label><select id="${id}"><option value="">${all_}</option>
    ${opts(k).map((v) => `<option ${filters[k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>`;
  const m = metrics(filters);
  const kpi = (t, v, l, c) => `<div class="card kpi" style="--c:${c}"><div class="t">${t}</div><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const person = (r, extra) => `<li><span>${esc(r.s.name)} <small class="hint">${esc(r.s.section || '')}</small></span><span>${extra}</span></li>`;
  const ser = attendanceSeries(m, attRange);

  $view.innerHTML = subnav(REG_TABS, 'panel') + `
    <div class="card"><div class="card-h"><div><h2>Filtros del dashboard</h2><small>Ajusta las métricas por género, nivel, sección y materia.</small></div></div>
      <div class="filters">${sel('fg', 'Género', 'gender', 'Todos los géneros')}${sel('fn', 'Nivel educativo', 'level', 'Todos los niveles')}
      ${sel('fs', 'Sección', 'section', 'Todas las secciones')}${sel('fm', 'Materia', 'subject', 'Todas las materias')}</div></div>
    <div class="grid">
      ${kpi('Matrícula', m.students.length, 'Estudiantes', 'var(--blue)')}
      ${kpi('Rendimiento', m.general == null ? '0%' : fmt(m.general) + '%', 'Promedio general', 'var(--purple)')}
      ${kpi('Alertas', m.alertas.length, 'Activas', 'var(--red)')}
      ${kpi('Por vencer', m.porVencer.length, 'Próximos 7 días', 'var(--amber)')}
    </div>
    <div class="grid2">
      ${card('Necesita tu atención', 'Bajo rendimiento + baja asistencia',
        listHTML(m.doble.map((r) => person(r, `<span class="tag">${fmt(r.avg)}% · ${r.abs} aus.</span>`)), '✓ Sin estudiantes en doble riesgo'))}
      ${card('Por vencer', 'Próximos 7 días',
        listHTML(m.porVencer.map((e) => `<li><span>${esc(e.name)}</span><span>${esc(e.due)}</span></li>`), '✓ Sin evaluaciones por vencer esta semana'),
        '<button class="ghost" id="newEval">Crear →</button>')}
      ${card('Rendimiento por período', 'Promedio y tasa de aprobación',
        m.periodos.length ? m.periodos.map((p) => `<div style="margin-bottom:8px"><small class="hint">${p.m}</small>${bars([
          { label: 'Promedio', pct: p.avg, text: fmt(p.avg) + '%', color: 'var(--blue)' },
          { label: 'Aprobación', pct: p.pass, text: fmt(p.pass) + '%', color: 'var(--brand)' }])}</div>`).join('') : '<div class="empty">Sin datos por período</div>')}
      ${card('Tendencia de alertas', 'Estudiantes con 3+ ausencias por mes',
        m.alertTrend.length ? bars(m.alertTrend.map((a) => ({ label: a.m, pct: Math.min(100, (a.n / Math.max(1, m.students.length)) * 100), text: String(a.n), color: 'var(--red)' }))) : '<div class="empty">Sin datos de alertas</div>')}
      ${card('Distribución de notas', 'Cantidad de notas por rango',
        m.dist.some((d) => d.n) ? bars(m.dist.map((d) => ({ label: d.label, pct: (d.n / Math.max(...m.dist.map((x) => x.n))) * 100, text: String(d.n) }))) : '<div class="empty">Sin notas registradas</div>')}
      ${card('Cobertura', 'Notas registradas',
        `<div class="big">${fmt(m.cobertura)}%</div><div class="hint" style="text-align:center">${m.graded.length} de ${m.students.length} estudiantes</div>
         ${bars([{ label: '', pct: m.cobertura, text: '', color: 'var(--brand)' }])}<div class="hint" style="text-align:center">${m.evals.length} evaluaciones creadas</div>`)}
      ${card('Top 5', 'Mejores promedios', listHTML(m.top.map((r) => person(r, fmt(r.avg) + '%')), 'Sin datos'))}
      ${card('Riesgo', 'Peores promedios', listHTML(m.worst.map((r) => person(r, fmt(r.avg) + '%')), 'Sin datos'))}
      ${card('Deserción', '3+ ausencias', listHTML(m.desercion.map((r) => person(r, r.abs + ' ausencias')), 'Sin riesgo'))}
    </div>
    ${card('Tendencia de asistencia', 'Seguimiento diario de estudiantes presentes',
      ser.length ? lineSvg(ser) : '<div class="empty">Sin datos de asistencia</div>',
      `<div class="pills">${[7, 14, 30, 90].map((d) => `<button data-r="${d}" class="${d === attRange ? 'on' : ''}">${d}d</button>`).join('')}</div>`)}`;

  bindSubnav();
  [['fg', 'gender'], ['fn', 'level'], ['fs', 'section'], ['fm', 'subject']].forEach(([id, k]) => ($(id).onchange = (e) => { filters[k] = e.target.value; render(); }));
  $view.querySelectorAll('.pills button').forEach((b) => (b.onclick = () => { attRange = +b.dataset.r; render(); }));
  $('newEval').onclick = () => go('registrar', 'notas');
}

// ---------- Estudiantes: datos ampliados, importación y JSON ----------
const FIELD_ALIASES = {
  name: ['nombre', 'estudiante', 'nombre completo', 'alumno', 'alumna'],
  gender: ['genero', 'sexo'],
  age: ['edad'],
  level: ['nivel', 'grado'],
  section: ['seccion', 'grupo'],
  subject: ['materia', 'asignatura'],
  community: ['comunidad', 'distrito', 'residencia', 'barrio', 'lugar'],
  internet: ['internet', 'conectividad', 'acceso a internet'],
  support: ['adecuacion', 'adecuacion curricular'],
  notes: ['notas', 'observaciones', 'observacion']
};
const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function splitLine(line, d) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
function normStudent(o) {
  const g = norm(o.gender), net = norm(o.internet), sp = norm(o.support), age = parseInt(o.age, 10);
  return {
    name: str(o.name, 120).trim(),
    gender: /^(f|fem|mujer)/.test(g) ? 'Femenino' : /^(m|masc|hombre)/.test(g) ? 'Masculino' : g ? 'Otro' : '',
    age: age >= 3 && age <= 25 ? age : '',
    level: str(o.level, 60).trim(), section: str(o.section, 40).trim(), subject: str(o.subject, 80).trim(),
    community: str(o.community, 120).trim(),
    internet: /^(s|si|yes)/.test(net) ? 'Sí' : /^(l|lim|a veces|parcial)/.test(net) ? 'Limitado' : /^(n|no)/.test(net) ? 'No' : '',
    support: sp.includes('no signif') ? 'No significativa' : sp.includes('signif') ? 'Significativa' : sp.includes('acceso') ? 'De acceso' : 'Ninguna',
    notes: str(o.notes, 500).trim()
  };
}
function parseStudents(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: 0 };
  const d = ['\t', ';', ','].find((c) => lines[0].includes(c)) || ',';
  let cells = lines.map((l) => splitLine(l, d));
  const keys = Object.keys(FIELD_ALIASES);
  const hit = cells[0].map((h) => keys.find((k) => FIELD_ALIASES[k].includes(norm(h))));
  let map;
  if (hit.includes('name')) { map = hit; cells = cells.slice(1); }
  else map = ['name', 'gender', 'age', 'level', 'section', 'subject']; // sin encabezado: orden por defecto
  const rows = [];
  cells.forEach((r) => {
    const o = {}; r.forEach((v, i) => { if (map[i] && v) o[map[i]] = v; });
    if (o.name) rows.push(normStudent(o));
  });
  return { rows, skipped: cells.length - rows.length };
}
function studentsJSON(list) {
  return JSON.stringify({ centro: currentInst()?.name || '', exportado: iso(new Date()),
    estudiantes: list.map(({ id, inst, ...rest }) => rest) }, null, 2);
}
function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}

function estudiantes() {
  const list = scopedStudents();
  const opt = (arr) => arr.map((o) => `<option>${o}</option>`).join('');
  $view.innerHTML = subnav(REG_TABS, 'estudiantes') + `
    <div class="card"><div class="card-h"><div><h2>Agregar estudiante</h2><small>Los datos se guardan solo en este equipo. A la IA nunca se envían nombres ni notas: solo cifras del grupo.</small></div></div>
      <div class="row"><div><label>Nombre</label><input id="n" /></div>
        <div><label>Género</label><select id="g">${opt(['Femenino', 'Masculino', 'Otro'])}</select></div>
        <div><label>Edad</label><input id="age" type="number" min="3" max="25" /></div></div>
      <div class="row"><div><label>Nivel</label><input id="l" placeholder="Sexto" /></div>
        <div><label>Sección</label><input id="sc" placeholder="6-1" /></div>
        <div><label>Materia</label><input id="m" placeholder="Matemática" /></div></div>
      <div class="row"><div><label>Comunidad</label><input id="com" placeholder="Barrio o localidad" /></div>
        <div><label>Internet en casa</label><select id="net"><option value="">Sin dato</option>${opt(['Sí', 'Limitado', 'No'])}</select></div>
        <div><label>Adecuación curricular</label><select id="sup">${opt(['Ninguna', 'De acceso', 'No significativa', 'Significativa'])}</select></div></div>
      <label>Notas del docente (privadas)</label><input id="nt" />
      <button class="primary" id="add">Agregar</button></div>
    <div class="card"><div class="card-h"><div><h2>Importar lista</h2><small>Copia las filas desde Excel o Word y pégalas aquí, o carga un archivo .csv o .json. La app las convierte sola a datos estructurados (JSON).</small></div></div>
      <textarea id="paste" placeholder="Nombre;Género;Edad;Sección&#10;Ana Mora;F;11;6-1&#10;Luis Rojas;M;12;6-1"></textarea>
      <div id="prev" class="hint"></div>
      <button class="primary" id="doImp" disabled>Importar</button> <button class="ghost" id="fileBtn">Cargar archivo…</button>
      <input type="file" id="file" accept=".csv,.txt,.json" style="display:none" /></div>
    <div class="card"><div class="card-h"><div><h2>Lista (${list.length})</h2><small>Con encabezados reconocibles (nombre, género, edad, nivel, sección, materia, comunidad, internet, adecuación, notas) se asignan solos.</small></div>
      ${list.length ? '<button class="ghost" id="expJ">Descargar JSON</button>' : ''}</div>
      ${list.length ? `<table><tr><th>Nombre</th><th>Género</th><th>Edad</th><th>Nivel</th><th>Sección</th><th>Materia</th><th>Adecuación</th><th>Internet</th><th></th></tr>
      ${list.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.gender)}</td><td>${esc(s.age)}</td><td>${esc(s.level)}</td><td>${esc(s.section)}</td><td>${esc(s.subject)}</td>
      <td>${esc(s.support || '')}</td><td>${esc(s.internet || '')}</td><td><button class="ghost danger" data-del="${esc(s.id)}">Quitar</button></td></tr>`).join('')}</table>` : '<div class="empty">Aún no hay estudiantes</div>'}</div>`;
  bindSubnav();

  $('add').onclick = () => {
    const name = $('n').value.trim(); if (!name) return;
    db.students.push({ id: uid(), inst: db.current, ...normStudent({
      name, gender: $('g').value, age: $('age').value, level: $('l').value, section: $('sc').value, subject: $('m').value,
      community: $('com').value, internet: $('net').value, support: $('sup').value, notes: $('nt').value }) });
    save(); render();
  };
  let pending = [];
  const preview = (rows, skipped) => {
    pending = rows;
    $('doImp').disabled = !rows.length;
    $('prev').innerHTML = rows.length
      ? `Se detectaron <b>${rows.length}</b> estudiantes${skipped ? ` (${skipped} filas sin nombre omitidas)` : ''}. Vista previa:
         <div class="output" style="font-size:12px;max-height:170px;overflow:auto">${esc(JSON.stringify(rows.slice(0, 2), null, 2))}</div>`
      : 'No se detectaron estudiantes. Revisa que haya una columna con el nombre.';
  };
  $('paste').oninput = () => { const t = $('paste').value; if (!t.trim()) { $('prev').textContent = ''; pending = []; $('doImp').disabled = true; return; } const r = parseStudents(t); preview(r.rows, r.skipped); };
  $('doImp').onclick = () => { pending.forEach((p) => db.students.push({ id: uid(), inst: db.current, ...p })); save(); render(); };
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const text = String(rd.result);
      if (f.name.toLowerCase().endsWith('.json')) {
        try {
          const d = JSON.parse(text); const arr = Array.isArray(d) ? d : d.estudiantes;
          const rows = (arr || []).filter((x) => x && x.name).map(normStudent);
          preview(rows, (arr || []).length - rows.length);
        } catch { $('prev').textContent = 'El archivo JSON no es válido.'; }
      } else { $('paste').value = text; const r = parseStudents(text); preview(r.rows, r.skipped); }
    };
    rd.readAsText(f);
  };
  if ($('expJ')) $('expJ').onclick = () => download('estudiantes-' + iso(new Date()) + '.json', studentsJSON(list));
  $view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.del;
    db.students = db.students.filter((s) => s.id !== id);
    db.grades = db.grades.filter((g) => g.studentId !== id);
    db.attendance = db.attendance.filter((a) => a.studentId !== id);
    save(); render();
  }));
}

// ---------- Contexto: zona + perfil agregado del grupo ----------
const currentInst = () => db.institutions.find((i) => i.id === db.current);
function groupProfile(list) {
  const n = list.length; if (!n) return '';
  const cnt = (k, v) => list.filter((s) => s[k] === v).length;
  const ages = list.map((s) => +s.age).filter((a) => a > 0);
  const out = [`Estudiantes: ${n}`];
  if (ages.length) out.push(`Edades: ${Math.min(...ages)}–${Math.max(...ages)} años (promedio ${fmt(avgOf(ages))})`);
  out.push(`Género: ${cnt('gender', 'Femenino')} femenino, ${cnt('gender', 'Masculino')} masculino, ${cnt('gender', 'Otro')} otro`);
  if (list.some((s) => s.internet)) out.push(`Internet en casa: ${cnt('internet', 'Sí')} sí, ${cnt('internet', 'Limitado')} limitado, ${cnt('internet', 'No')} no`);
  const sup = list.filter((s) => s.support && s.support !== 'Ninguna').length;
  if (sup) out.push(`Con adecuación curricular: ${sup} de ${n}`);
  const comm = {}; list.forEach((s) => { if (s.community) comm[s.community] = (comm[s.community] || 0) + 1; });
  const top = Object.entries(comm).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) out.push('Comunidades de procedencia: ' + top.map(([k, v]) => `${k} (${v})`).join(', '));
  return out.join('\n');
}
function contextBlock() {
  const i = currentInst(); if (!i) return '';
  const parts = [];
  const loc = [i.distrito, i.canton, i.provincia].filter(Boolean).join(', ');
  if (loc || i.zona) parts.push(`Ubicación del centro: ${loc || 'no indicada'}${i.zona ? ` (zona ${i.zona.toLowerCase()})` : ''}.`);
  if (i.profile) parts.push(`Perfil contextual de la zona (revisado por el docente):\n${i.profile}`);
  const g = groupProfile(scopedStudents());
  if (g) parts.push(`Perfil del grupo (cifras agregadas, sin nombres):\n${g}`);
  return parts.length ? 'CONTEXTO PARA ADAPTAR LOS MATERIALES\n' + parts.join('\n\n') : '';
}

function asistencia() {
  const list = scopedStudents();
  const state = {};
  list.forEach((s) => { const r = db.attendance.find((a) => a.studentId === s.id && a.date === attDate); state[s.id] = r ? r.present : true; });
  $view.innerHTML = subnav(REG_TABS, 'asistencia') + `
    <div class="card"><div class="card-h"><div><h2>Asistencia</h2><small>Marca quién está presente y guarda el día.</small></div>
      <div style="width:170px"><input type="date" id="d" value="${attDate}" max="${iso(new Date())}" /></div></div>
      ${list.length ? `<table><tr><th>Estudiante</th><th>Sección</th><th>Presente</th></tr>
      ${list.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.section)}</td><td><input type="checkbox" data-a="${esc(s.id)}" ${state[s.id] ? 'checked' : ''} /></td></tr>`).join('')}</table>
      <button class="primary" id="saveA">Guardar asistencia</button> <span id="msg" class="msg-ok"></span>` : '<div class="empty">Agrega estudiantes primero</div>'}</div>`;
  bindSubnav();
  $('d').onchange = (e) => { attDate = e.target.value || attDate; render(); };
  if (list.length) $('saveA').onclick = () => {
    const ids = new Set(list.map((s) => s.id));
    db.attendance = db.attendance.filter((a) => !(a.date === attDate && ids.has(a.studentId)));
    $view.querySelectorAll('[data-a]').forEach((c) => db.attendance.push({ studentId: c.dataset.a, date: attDate, present: c.checked }));
    save(); $('msg').textContent = 'Guardado ✓';
  };
}

function notas() {
  const evals = scopedEvals().sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  if (!evals.find((e) => e.id === selEval)) selEval = evals[0]?.id || null;
  const ev = evals.find((e) => e.id === selEval);
  const stu = ev ? scopedStudents().filter((s) => !ev.subject || s.subject === ev.subject) : [];
  const grade = (sid) => db.grades.find((g) => g.evalId === selEval && g.studentId === sid)?.score ?? '';
  $view.innerHTML = subnav(REG_TABS, 'notas') + `
    <div class="card"><div class="card-h"><div><h2>Nueva evaluación</h2><small>Tarea, prueba, proyecto…</small></div></div>
      <div class="row"><div><label>Nombre</label><input id="en" /></div><div><label>Materia (opcional)</label><input id="es" /></div>
      <div><label>Fecha de entrega</label><input type="date" id="ed" /></div></div><button class="primary" id="addE">Crear evaluación</button></div>
    <div class="card"><div class="card-h"><div><h2>Notas</h2><small>Escribe la nota de 0 a 100; se guarda al salir de la casilla.</small></div>
      ${evals.length ? `<div style="width:260px"><select id="evSel">${evals.map((e) => `<option value="${esc(e.id)}" ${e.id === selEval ? 'selected' : ''}>${esc(e.name)}${e.due ? ' · ' + e.due : ''}</option>`).join('')}</select></div>` : ''}</div>
      ${ev ? (stu.length ? `<table><tr><th>Estudiante</th><th>Sección</th><th>Nota</th></tr>${stu.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.section)}</td>
        <td><input type="number" min="0" max="100" data-s="${esc(s.id)}" value="${esc(grade(s.id))}" /></td></tr>`).join('')}</table>` : '<div class="empty">No hay estudiantes para esta materia</div>')
        + `<button class="ghost danger" id="delE" style="margin-top:12px">Eliminar evaluación</button>` : '<div class="empty">Crea una evaluación para registrar notas</div>'}</div>`;
  bindSubnav();
  $('addE').onclick = () => {
    const name = $('en').value.trim(); if (!name) return;
    const e = { id: uid(), inst: db.current, name, subject: $('es').value.trim(), due: $('ed').value, created: iso(new Date()) };
    db.evals.push(e); selEval = e.id; save(); render();
  };
  if ($('evSel')) $('evSel').onchange = (e) => { selEval = e.target.value; render(); };
  $view.querySelectorAll('input[data-s]').forEach((inp) => (inp.onchange = () => {
    const sid = inp.dataset.s;
    db.grades = db.grades.filter((g) => !(g.evalId === selEval && g.studentId === sid));
    if (inp.value !== '' && !isNaN(+inp.value)) db.grades.push({ evalId: selEval, studentId: sid, score: Math.max(0, Math.min(100, +inp.value)) });
    save();
  }));
  if ($('delE')) $('delE').onclick = () => {
    db.evals = db.evals.filter((e) => e.id !== selEval); db.grades = db.grades.filter((g) => g.evalId !== selEval);
    selEval = null; save(); render();
  };
}

// ================= VISTAS: IA =================
function aiForm(host, { title, sub, fields, buildPrompt, system, extra = '', ctx = true }) {
  const ctxHTML = ctx && contextBlock()
    ? '<label class="chk"><input type="checkbox" name="ctx" checked /> Adaptar al contexto de mi zona y grupo</label>' : '';
  host.innerHTML = `<div class="card"><div class="card-h"><div><h2>${title}</h2><small>${sub}</small></div></div><form id="f">
      ${fields.map((f) => `<label>${f.label}</label>` + (f.type === 'textarea' ? `<textarea name="${f.name}" placeholder="${f.ph || ''}"></textarea>`
        : f.type === 'select' ? `<select name="${f.name}">${f.options.map((o) => `<option>${o}</option>`).join('')}</select>`
        : `<input name="${f.name}" placeholder="${f.ph || ''}" />`)).join('')}
      ${extra}${ctxHTML}<button class="primary" type="submit">Generar con IA</button> <span id="msg"></span></form></div><div id="out"></div>`;
  const form = $('f');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); const msg = $('msg');
    btn.disabled = true; msg.textContent = ' Generando…'; msg.className = 'hint';
    const data = Object.fromEntries(new FormData(form));
    let prompt = buildPrompt(data);
    if (data.ctx) prompt += '\n\n' + contextBlock() + '\n\nAdapta ejemplos, situaciones y actividades a este contexto, sin estereotipar ni asumir condiciones de estudiantes concretos.';
    const r = await window.sigma.generate(SYSTEM_BASE + ' ' + system, prompt);
    btn.disabled = false;
    if (!r.ok) { msg.textContent = ' ' + r.error; msg.className = 'msg-err'; return; }
    msg.textContent = '';
    if (!$('out')) return; // la pantalla cambió o la app se bloqueó mientras la IA respondía
    $('out').innerHTML = `<div class="card"><div class="output">${esc(r.text)}</div><button class="ghost" id="copy" style="margin-top:10px">Copiar</button></div>`;
    $('copy').onclick = () => navigator.clipboard.writeText(r.text).then(() => toast('Copiado.')).catch(() => toast('No se pudo copiar.', 'err'));
  };
}

function viewPlanear() {
  const noZone = db.current && !currentInst()?.profile;
  $view.innerHTML = '<h1>Planear</h1><p class="sub">Genera una mediación pedagógica lista para ajustar.</p>' +
    (noZone ? '<div class="card hint">💡 Agrega el contexto de tu zona para que las actividades se adapten a tu comunidad. <button class="ghost" id="zoneGo">Configurar</button></div>' : '') +
    '<div id="ai"></div>';
  if (noZone) $('zoneGo').onclick = () => go('perfil', 'zona');
  aiForm($('ai'), {
    title: 'Planeamiento didáctico', sub: 'Propósito, aprendizajes esperados, mediación y evaluación.',
    system: 'Diseña planeamientos con propósito, aprendizajes esperados, indicadores, mediación (inicio, desarrollo, cierre) y evaluación.',
    fields: [
      { name: 'materia', label: 'Asignatura', ph: 'Estudios Sociales' }, { name: 'nivel', label: 'Nivel', ph: 'Sexto grado' },
      { name: 'tema', label: 'Tema / aprendizaje esperado', type: 'textarea' }, { name: 'duracion', label: 'Duración', ph: '2 lecciones de 40 min' }],
    buildPrompt: (d) => `Elabora un planeamiento didáctico.\nAsignatura: ${d.materia}\nNivel: ${d.nivel}\nTema: ${d.tema}\nDuración: ${d.duracion}`
  });
}

const CREAR_TABS = [['evaluacion', 'Evaluación'], ['retro', 'Retroalimentación'], ['analisis', 'Análisis del panel']];
function viewCrear() {
  $view.innerHTML = '<h1>Crear con IA</h1><p class="sub">Usa la IA configurada en tu perfil.</p>' + subnav(CREAR_TABS, route.sub) + '<div id="ai"></div>';
  bindSubnav();
  const host = $('ai');
  if (route.sub === 'retro') {
    aiForm(host, {
      ctx: false, title: 'Retroalimentación', sub: 'No incluyas datos personales del estudiante.',
      system: 'Da retroalimentación formativa: fortalezas, aspectos por mejorar y sugerencias concretas, en tono respetuoso y motivador.',
      fields: [{ name: 'criterio', label: 'Criterios / rúbrica', type: 'textarea' }, { name: 'trabajo', label: 'Trabajo del estudiante', type: 'textarea' }],
      buildPrompt: (d) => `Criterios de evaluación:\n${d.criterio}\n\nTrabajo del estudiante:\n${d.trabajo}\n\nRedacta la retroalimentación y propón una nota con justificación.`
    });
  } else if (route.sub === 'analisis') {
    if (!needInst()) return;
    const m = metrics(filters);
    aiForm(host, {
      ctx: false, title: 'Análisis del panel', sub: 'Solo se envían cifras agregadas; nunca nombres de estudiantes.',
      system: 'Eres analista educativo. Interpreta indicadores de un grupo y propone acciones pedagógicas concretas y priorizadas.',
      fields: [{ name: 'foco', label: '¿Qué quieres que analice? (opcional)', type: 'textarea', ph: 'Ej.: cómo mejorar la asistencia en la sección 6-1' }],
      buildPrompt: (d) => `Indicadores agregados del grupo (nota mínima de aprobación ${PASS}):\n` +
        `- Matrícula: ${m.students.length}\n- Promedio general: ${fmt(m.general)}%\n- Estudiantes con bajo rendimiento: ${m.rows.filter((r) => r.avg != null && r.avg < PASS).length}\n` +
        `- Estudiantes con 3+ ausencias: ${m.desercion.length}\n- En doble riesgo: ${m.doble.length}\n- Cobertura de notas: ${fmt(m.cobertura)}%\n` +
        `- Distribución de notas: ${m.dist.map((x) => x.label + ': ' + x.n).join('; ')}\n- Evaluaciones por vencer (7 días): ${m.porVencer.length}\n` +
        `Foco del docente: ${d.foco || 'análisis general'}\nDa un diagnóstico breve y 5 acciones concretas.`
    });
  } else {
    aiForm(host, {
      title: 'Evaluación', sub: 'Pruebas escritas, rúbricas y listas de cotejo.',
      system: 'Crea instrumentos de evaluación con tabla de especificaciones, ítems variados y clave de respuestas o rúbrica con niveles de desempeño.',
      fields: [
        { name: 'tipo', label: 'Instrumento', type: 'select', options: ['Prueba escrita', 'Rúbrica', 'Lista de cotejo', 'Quiz corto'] },
        { name: 'materia', label: 'Asignatura y nivel', ph: 'Español, I grado' },
        { name: 'contenido', label: 'Contenidos a evaluar', type: 'textarea' }, { name: 'puntos', label: 'Puntaje total', ph: '30' }],
      buildPrompt: (d) => `Crea un instrumento: ${d.tipo}.\nAsignatura y nivel: ${d.materia}\nContenidos: ${d.contenido}\nPuntaje total: ${d.puntos}`
    });
  }
}

// ================= VISTA: PERFIL =================
const PERFIL_TABS = [['cuenta', 'Cuenta'], ['ia', 'IA'], ['centros', 'Centros educativos'], ['zona', 'Contexto de la zona'], ['seguridad', 'Seguridad'], ['datos', 'Datos y respaldo'], ['faq', 'Preguntas frecuentes'], ['acerca', 'Acerca de']];
const ZONAS = ['Urbana', 'Semiurbana', 'Rural', 'Rural dispersa', 'Costera', 'Territorio indígena'];
async function viewPerfil() {
  const sub = route.sub || 'cuenta';
  $view.innerHTML = `<h1>Mi perfil</h1><p class="sub">Administra tu cuenta, preferencias y centros educativos.</p>${subnav(PERFIL_TABS, sub)}<div id="p"></div>`;
  bindSubnav();
  const host = $('p');

  if (sub === 'cuenta') {
    const s = await window.sigma.getSettings();
    host.innerHTML = card('Cuenta y preferencias', 'Tu configuración actual.', `<ul class="list">
      <li><span>Tema</span><b>${db.theme === 'dark' ? 'Oscuro' : 'Claro'}</b></li>
      <li><span>Centros educativos</span><b>${db.institutions.length}</b></li>
      <li><span>Proveedor de IA</span><b>${PROVIDERS[s.provider]}</b></li>
      <li><span>API key</span><b>${s.hasKey[s.provider] ? 'Guardada ✓' : 'Sin configurar'}</b></li></ul>`);
  }

  if (sub === 'ia') {
    const s = await refreshAI();
    host.innerHTML = card('Inteligencia artificial', 'Tu API key se guarda cifrada en este equipo y solo se usa para llamar al proveedor que elijas.', `
      <label>Proveedor</label><select id="prov">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === s.provider ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Modelo</label><input id="model" />
      <label>API key <span id="has" class="hint"></span></label><input id="key" type="password" placeholder="Pega aquí tu API key" autocomplete="off" />
      <button class="primary" id="save">Guardar</button> <button class="ghost" id="del">Borrar clave</button> <button class="ghost" id="test">Probar conexión</button> <button class="ghost" id="guide">Asistente paso a paso</button>
      <div id="msg" style="margin-top:10px"></div>`);
    const sync = () => { $('model').value = s.models[$('prov').value]; $('has').textContent = s.hasKey[$('prov').value] ? '(ya hay una guardada)' : '(vacía)'; };
    $('prov').onchange = sync; sync();
    const say = (t, ok = true) => { $('msg').textContent = t; $('msg').className = ok ? 'msg-ok' : 'msg-err'; };
    $('save').onclick = async () => {
      const provider = $('prov').value;
      const sv = await window.sigma.saveSettings({ provider, models: { [provider]: $('model').value.trim() }, apiKey: $('key').value });
      if (!sv || sv.ok === false) return say((sv && sv.error) || 'No se pudo guardar.', false);
      $('key').value = ''; Object.assign(s, await refreshAI()); sync(); say('Guardado ✓');
    };
    $('guide').onclick = () => go('setup');
    $('del').onclick = async () => { await window.sigma.deleteKey($('prov').value); Object.assign(s, await refreshAI()); sync(); say('Clave borrada.'); };
    $('test').onclick = async () => {
      say('Probando…');
      const r = await window.sigma.generate('Responde con una sola palabra.', 'Di "listo".');
      r.ok ? say('Conexión correcta: ' + r.text.trim()) : say(r.error, false);
    };
  }

  if (sub === 'centros') {
    host.innerHTML = card('Centros educativos', 'Gestiona los centros asociados a tu cuenta.',
      db.institutions.length ? `<ul class="list">${db.institutions.map((i) => `<li><span><b>${esc(i.name)}</b> <small class="hint">${esc(i.region || '')}</small></span>
        <button class="ghost danger" data-d="${esc(i.id)}">Quitar</button></li>`).join('')}</ul>` : '<div class="empty">No tienes centros registrados</div>') +
      card('Agregar centro educativo', 'Vincula otro centro a tu cuenta.', `<label>Nombre del centro</label><input id="cn" placeholder="Ej. Escuela Central" />
        <label>Región educativa</label><input id="cr" placeholder="Ej. Heredia" /><button class="primary" id="addC">Agregar centro</button>`);
    $('addC').onclick = () => {
      const name = $('cn').value.trim(); if (!name) return;
      const i = { id: uid(), name, region: $('cr').value.trim() };
      db.institutions.push(i); db.current = i.id; save(); render();
    };
    host.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
      if (!confirm('¿Quitar este centro y todos sus datos (estudiantes, notas, asistencia)?')) return;
      const id = b.dataset.d;
      const sids = new Set(db.students.filter((s) => s.inst === id).map((s) => s.id));
      const eids = new Set(db.evals.filter((e) => e.inst === id).map((e) => e.id));
      db.institutions = db.institutions.filter((i) => i.id !== id);
      db.students = db.students.filter((s) => s.inst !== id); db.evals = db.evals.filter((e) => e.inst !== id);
      db.grades = db.grades.filter((g) => !eids.has(g.evalId) && !sids.has(g.studentId));
      db.attendance = db.attendance.filter((a) => !sids.has(a.studentId));
      if (db.current === id) db.current = db.institutions[0]?.id || null;
      save(); render();
    }));
  }

  if (sub === 'zona') {
    const i = currentInst();
    if (!i) {
      host.innerHTML = '<div class="card empty"><b>Primero agrega tu centro educativo.</b><br><br><button class="primary" id="goc">Agregar centro</button></div>';
      $('goc').onclick = () => go('perfil', 'centros'); return;
    }
    host.innerHTML = card('Contexto de la zona', `Centro: ${esc(i.name)}. Indica dónde está; la IA propone un perfil general y tú lo corriges.`, `
      <div class="row"><div><label>Provincia</label><input id="zprov" value="${esc(i.provincia)}" /></div>
        <div><label>Cantón</label><input id="zcan" value="${esc(i.canton)}" /></div>
        <div><label>Distrito</label><input id="zdis" value="${esc(i.distrito)}" /></div></div>
      <label>Tipo de zona</label><select id="zz"><option value="">Sin indicar</option>${ZONAS.map((z) => `<option ${i.zona === z ? 'selected' : ''}>${z}</option>`).join('')}</select>
      <label>Lo que sabes de la comunidad (opcional)</label>
      <textarea id="zn" placeholder="Actividades locales, idiomas, recursos, clima, transporte…">${esc(i.contexto)}</textarea>
      <button class="primary" id="zgen">Generar perfil con IA</button> <button class="ghost" id="zsave">Guardar ubicación</button> <span id="zmsg"></span>`) +
      card('Perfil de la zona', 'Es una descripción general y orientativa. Edítala con lo que tú conoces: es lo que se usará al diseñar tus materiales.', `
      <textarea id="zprof" style="min-height:230px">${esc(i.profile)}</textarea>
      <button class="primary" id="zsp">Guardar perfil</button> <span id="zm2"></span>`);
    const saveLoc = () => {
      Object.assign(i, { provincia: $('zprov').value.trim(), canton: $('zcan').value.trim(), distrito: $('zdis').value.trim(), zona: $('zz').value, contexto: $('zn').value.trim() });
      save();
    };
    $('zsave').onclick = () => { saveLoc(); $('zmsg').textContent = 'Guardado ✓'; $('zmsg').className = 'msg-ok'; };
    $('zsp').onclick = () => { i.profile = $('zprof').value.trim(); save(); $('zm2').textContent = 'Guardado ✓'; $('zm2').className = 'msg-ok'; };
    $('zgen').onclick = async () => {
      saveLoc();
      if (!i.provincia && !i.canton && !i.distrito && !i.contexto) { $('zmsg').textContent = 'Escribe al menos la ubicación o algo de la comunidad.'; $('zmsg').className = 'msg-err'; return; }
      $('zgen').disabled = true; $('zmsg').textContent = ' Generando…'; $('zmsg').className = 'hint';
      const loc = [i.distrito, i.canton, i.provincia].filter(Boolean).join(', ') || 'no indicada';
      const r = await window.sigma.generate(
        SYSTEM_BASE + ' Describes contextos escolares con respeto y sin estereotipos.',
        `Centro educativo: ${i.name}\nUbicación: ${loc}, Costa Rica\nTipo de zona: ${i.zona || 'no indicado'}\nInformación aportada por el docente: ${i.contexto || 'ninguna'}\n\n` +
        'Redacta un perfil contextual orientativo (máximo 250 palabras) para diseñar materiales didácticos pertinentes: 1) entorno y actividades económicas o culturales frecuentes, ' +
        '2) recursos y posibles limitaciones (conectividad, transporte, materiales), 3) referentes locales útiles para ejemplos, 4) recomendaciones didácticas. ' +
        'Reglas: presenta todo como generalidades probables, no como hechos sobre estudiantes concretos; no estereotipes ni asumas pobreza, etnia ni condiciones familiares; ' +
        'si no conoces bien la zona, dilo y limítate a lo que se deduce de los datos. Termina con 3 preguntas que el docente debería confirmar.');
      $('zgen').disabled = false;
      if (!r.ok) { $('zmsg').textContent = ' ' + r.error; $('zmsg').className = 'msg-err'; return; }
      $('zprof').value = r.text; $('zmsg').textContent = ' Revisa el perfil, corrígelo y pulsa “Guardar perfil”.'; $('zmsg').className = 'msg-ok';
    };
  }

  if (sub === 'seguridad') {
    const say = (t, ok = false) => { const m = $('smsg'); if (m) { m.textContent = t; m.className = ok ? 'msg-ok' : 'msg-err'; } };
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    const waitMsg = (r) => (r && r.wait ? `Demasiados intentos. Espera ${r.wait} segundos.` : (r && r.error) || 'No se pudo completar.');
    const drawSec = async (recovery) => {
      const [st, info, lg] = await Promise.all([window.sigma.pinStatus(), window.sigma.appInfo(), window.sigma.logGet()]);
      const entries = (lg && lg.entries) || [];
      const logText = entries.map((e) => `${e.t} v${e.v} [${e.where}] ${e.msg}`).join('\n');
      const pinIn = (id) => `<input id="${id}" type="password" inputmode="numeric" maxlength="8" autocomplete="off" />`;
      const recHTML = recovery ? `<div class="card"><div class="recovery"><b>Tu código de recuperación</b>
        <div class="code">${esc(recovery)}</div>
        <p class="hint">Anótalo en papel y guárdalo en un lugar seguro. Solo se muestra ahora y sirve para crear un PIN nuevo si olvidas el actual.</p>
        <button class="ghost" id="recCopy">Copiar</button> <button class="primary" id="recOk">Ya lo guardé</button></div></div>` : '';
      host.innerHTML = recHTML +
        card('Candado de la aplicación', 'Pide un PIN al abrir y se bloquea sola si no la usas.', `<ul class="list">
          <li><span>Cifrado de datos</span><b>${info.encrypted ? 'Activo (cuenta de Windows)' : '⚠ No disponible en este equipo: se guardan sin cifrar'}</b></li>
          <li><span>PIN</span><b>${st.enabled ? 'Activo' : 'Sin PIN'}</b></li></ul>` +
          (st.enabled
            ? `<label>Bloquear automáticamente tras</label><select id="alSel">${[1, 5, 15, 30].map((m) => `<option value="${m}" ${m === st.autolockMin ? 'selected' : ''}>${m} minutos sin usar</option>`).join('')}</select>
               <button class="ghost" id="lockNow" style="margin-top:12px">Bloquear ahora</button>`
            : `<label>Crear PIN (4 a 8 números)</label>${pinIn('sp1')}<label>Repite el PIN</label>${pinIn('sp2')}
               <button class="primary" id="spSet">Activar candado</button>`) + '<div id="smsg" style="margin-top:10px" role="alert"></div>') +
        (st.enabled ? card('Cambiar o quitar el PIN', 'Cambiarlo genera un código de recuperación nuevo.',
          `<label>PIN actual</label>${pinIn('cp0')}<label>PIN nuevo</label>${pinIn('cp1')}<label>Repite el PIN nuevo</label>${pinIn('cp2')}
           <button class="primary" id="cpSet">Cambiar PIN</button>
           <hr style="border:0;border-top:1px solid var(--line);margin:18px 0 4px" />
           <label>Para quitar el candado, escribe tu PIN</label>${pinIn('off0')}
           <button class="ghost danger" id="offBtn" style="margin-top:10px">Quitar PIN</button>`) : '') +
        card('Registro de errores', 'Si algo falla, la app lo anota aquí para que puedas reportarlo. Está diseñado para no incluir tu clave de IA ni datos de la lista de estudiantes.',
          (entries.length ? entries.slice().reverse().slice(0, 10).map((e) => `<div class="logrow">${esc(new Date(e.t).toLocaleString('es-CR'))} · ${esc(e.where)} · ${esc(e.msg)}</div>`).join('')
            : '<div class="empty">Sin errores registrados 🎉</div>') +
          `<div style="margin-top:12px"><button class="ghost" id="logCopy">Copiar registro</button> ${ABOUT.email ? '<button class="primary" id="logMail">Enviar por correo</button>' : ''}
           <button class="ghost" id="logClear">Borrar registro</button></div>` +
          (ABOUT.email ? '' : '<p class="hint">El correo de contacto aún no está configurado.</p>'));

      on('recCopy', async () => { try { await navigator.clipboard.writeText(recovery); toast('Código copiado.'); } catch { toast('No se pudo copiar. Anótalo a mano.', 'err'); } });
      on('recOk', () => drawSec());
      on('spSet', async () => {
        if ($('sp1').value !== $('sp2').value) return say('Los PIN no coinciden.');
        const r = await window.sigma.pinSet($('sp1').value);
        if (r && r.ok) return drawSec(r.recovery);
        say(waitMsg(r));
      });
      on('cpSet', async () => {
        if ($('cp1').value !== $('cp2').value) return say('Los PIN nuevos no coinciden.');
        const r = await window.sigma.pinSet($('cp1').value, $('cp0').value);
        if (r && r.ok) return drawSec(r.recovery);
        say(waitMsg(r));
      });
      on('offBtn', async () => {
        const r = await window.sigma.pinDisable($('off0').value);
        if (r && r.ok) { toast('Candado desactivado.'); return drawSec(); }
        say(waitMsg(r));
      });
      on('lockNow', () => lockApp());
      if ($('alSel')) $('alSel').onchange = async (e) => { const r = await window.sigma.setAutolock(+e.target.value); say(r && r.ok ? 'Guardado ✓' : 'No se pudo guardar.', !!(r && r.ok)); };
      on('logCopy', async () => { try { await navigator.clipboard.writeText(logText || 'Sin errores registrados'); toast('Registro copiado.'); } catch { toast('No se pudo copiar.', 'err'); } });
      on('logMail', async () => {
        const body = 'Describe qué estabas haciendo cuando ocurrió el problema:\n\n\n--- Registro técnico (sin datos de estudiantes) ---\n' + logText.slice(-600);
        const url = `mailto:${ABOUT.email}?subject=${encodeURIComponent('EduPanel Docente: reporte de error')}&body=${encodeURIComponent(body)}`;
        if (!(await window.sigma.openLink(url))) toast('No se pudo abrir el correo. Usa “Copiar registro”.', 'err');
      });
      on('logClear', async () => { await window.sigma.logClear(); drawSec(); });
    };
    await drawSec();
  }

  if (sub === 'faq') {
    host.innerHTML = card('Preguntas frecuentes', 'Respuestas cortas a lo más común.',
      '<input id="faqQ" placeholder="Buscar… (por ejemplo: PIN, clave, respaldo)" /><div id="faqList" style="margin-top:10px"></div>');
    const draw = (q) => {
      const t = norm(q);
      const items = FAQ_ITEMS.filter(([a, b]) => !t || norm(a + ' ' + b).includes(t));
      $('faqList').innerHTML = items.length
        ? items.map(([a, b]) => `<details class="faq"><summary>${esc(a)}</summary><p>${esc(b)}</p></details>`).join('')
        : '<div class="empty">No encontré nada con esa palabra.</div>';
    };
    $('faqQ').oninput = (e) => draw(e.target.value);
    draw('');
  }

  if (sub === 'acerca') {
    const info = await window.sigma.appInfo();
    host.innerHTML = `<div class="card"><div class="about-hero"><p class="big">${esc(ABOUT.appName)}</p>
        <p class="sub">Versión ${esc(info.version)} · ${esc(ABOUT.year)}</p></div>
        <h2>Por qué existe</h2>${ABOUT.intention.map((p) => `<p style="line-height:1.6">${esc(p)}</p>`).join('')}</div>` +
      card('Principios', 'Lo que guía las decisiones de la app.', `<ul class="list" style="display:block">${ABOUT.principles.map(([t, d]) =>
        `<li style="display:block"><b>${esc(t)}</b><br><span class="hint">${esc(d)}</span></li>`).join('')}</ul>`) +
      card('Contacto', `Creado por ${esc(ABOUT.author)}.`, `<p style="line-height:1.6">¿Tienes ideas, encontraste un error o quieres colaborar? Escríbeme.</p>` +
        (ABOUT.email ? `<button class="primary" id="mailMe">Escribir a ${esc(ABOUT.author)}</button> <span class="hint">${esc(ABOUT.email)}</span>`
          : '<p class="hint">El correo de contacto aún no está configurado.</p>')) +
      `<div class="card hint">${esc(ABOUT.disclaimer)}</div>`;
    if ($('mailMe')) $('mailMe').onclick = async () => {
      if (!(await window.sigma.openLink('mailto:' + ABOUT.email + '?subject=' + encodeURIComponent('EduPanel Docente')))) toast('No se pudo abrir el correo.', 'err');
    };
  }

  if (sub === 'datos') {
    host.innerHTML = card('Respaldo de datos', 'Tus datos viven solo en este equipo (cifrados). Exporta una copia de vez en cuando.',
      `<button class="primary" id="exp">Exportar respaldo (.json)</button> <button class="ghost" id="imp">Importar respaldo</button>
       <input type="file" id="file" accept=".json" style="display:none" />
       <p class="hint">⚠ El archivo de respaldo NO está cifrado y contiene datos de estudiantes. Guárdalo en un lugar seguro y no lo envíes por correo ni lo subas a nubes públicas.</p>
       <div id="msg" style="margin-top:10px"></div>`) +
      card('Seguridad', 'Cómo se protege tu información.', `<ul class="list">
        <li><span>API key</span><span>Cifrada con el almacén seguro de Windows</span></li>
        <li><span>Datos del registro</span><span>Cifrados en este equipo; la app conserva una copia automática</span></li>
        <li><span>Datos de estudiantes</span><span>A la IA solo van cifras del grupo, sin nombres ni notas</span></li>
        <li><span>Candado (PIN)</span><span>Se configura en Perfil → Seguridad</span></li></ul>`) +
      card('Borrar todos mis datos', 'Elimina estudiantes, notas, asistencia, clave de IA y PIN de este equipo. No se puede deshacer.',
        `<label>Escribe BORRAR para confirmar</label><input id="wipeT" autocomplete="off" />
         <button class="ghost danger" id="wipe" style="margin-top:10px">Borrar todo</button> <span id="wmsg"></span>`);
    const say = (t, ok = false) => { $('msg').textContent = t; $('msg').className = ok ? 'msg-ok' : 'msg-err'; };
    $('exp').onclick = () => {
      try {
        download('edupanel-respaldo-' + iso(new Date()) + '.json', JSON.stringify(db, null, 2));
      } catch (e) { reportError('exportar', e); say('No se pudo crear el respaldo.'); }
    };
    $('imp').onclick = () => $('file').click();
    $('file').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 10 * 1024 * 1024) return say('El archivo es demasiado grande para ser un respaldo.');
      const rd = new FileReader();
      rd.onerror = () => say('No se pudo leer el archivo.');
      rd.onload = () => {
        try {
          const d = JSON.parse(rd.result);
          if (!d || !Array.isArray(d.institutions) || !Array.isArray(d.students)) throw new Error('formato');
          if (!confirm('Esto reemplazará los datos actuales de la app. ¿Continuar?')) return;
          db = sanitizeDb(d); save(); render();
        } catch { say('El archivo no es un respaldo válido.'); }
      };
      rd.readAsText(f);
    };
    $('wipe').onclick = async () => {
      if ($('wipeT').value.trim().toUpperCase() !== 'BORRAR') { $('wmsg').textContent = ' Escribe BORRAR para confirmar.'; $('wmsg').className = 'msg-err'; return; }
      await wipeEverything();
    };
  }
}

// ================= VISTA: ASISTENTE DE CLAVE (primer inicio) =================
const KEY_GUIDE = {
  anthropic: { url: 'https://platform.claude.com/settings/keys', note: 'Necesita cuenta y, normalmente, agregar un saldo prepagado pequeño. Pon un límite mensual bajo para no gastar de más.' },
  openai: { url: 'https://platform.openai.com/api-keys', note: 'Necesita cuenta y, normalmente, agregar un saldo prepagado pequeño. Pon un límite mensual bajo para no gastar de más.' },
  gemini: { url: 'https://aistudio.google.com/apikey', note: 'Necesita una cuenta de Google. Revisa en esa página las condiciones y límites de uso de tu cuenta.' }
};
function detectProvider(k) {
  k = k.trim();
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}
function viewSetup() {
  let prov = aiCfg.provider || 'anthropic';
  $view.innerHTML = `<h1>¡Bienvenido/a!</h1><p class="sub">Para usar la IA necesitas una clave personal. Son 3 pasos y se hace una sola vez.</p>
    <div class="card"><div class="card-h"><div><h2>Paso 1 · Elige el servicio de IA</h2><small>Puedes cambiarlo después en Perfil.</small></div></div>
      <select id="sp">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === prov ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <p class="hint" id="note"></p>
      <button class="primary" id="open">Abrir la página para crear mi clave</button>
      <ol class="steps"><li>Inicia sesión (o crea una cuenta) en la página que se abre.</li>
        <li>Busca la opción para crear una clave (suele decir “Create API key”).</li>
        <li>Copia la clave y vuelve a esta ventana.</li></ol></div>
    <div class="card"><div class="card-h"><div><h2>Paso 2 · Pega tu clave</h2><small>Se guarda cifrada en este computador. No la compartas con nadie.</small></div></div>
      <div class="row"><input id="sk" type="password" placeholder="Pega aquí tu clave" autocomplete="off" /><button class="ghost" id="paste" style="flex:0">Pegar</button></div></div>
    <div class="card"><div class="card-h"><div><h2>Paso 3 · Probar y guardar</h2><small>Verificamos que la clave funcione.</small></div></div>
      <button class="primary" id="go3" style="margin-top:0">Probar y guardar</button> <button class="ghost" id="skip">Omitir por ahora</button>
      <div id="msg" style="margin-top:12px"></div></div>`;
  const say = (t, ok = true) => { $('msg').textContent = t; $('msg').className = ok ? 'msg-ok' : 'msg-err'; };
  const note = () => { $('note').textContent = KEY_GUIDE[prov].note; };
  note();
  $('sp').onchange = (e) => { prov = e.target.value; note(); };
  $('open').onclick = async () => { if (!(await window.sigma.openLink(KEY_GUIDE[prov].url))) say('No se pudo abrir la página.', false); };
  $('paste').onclick = async () => {
    try { $('sk').value = (await navigator.clipboard.readText()).trim(); } catch { say('No pude leer el portapapeles. Pega con Ctrl+V.', false); }
  };
  $('skip').onclick = () => { localStorage.setItem('edupanel-setup-skipped', '1'); go('registrar'); };
  $('go3').onclick = async () => {
    const key = $('sk').value.trim();
    if (!key) return say('Primero pega tu clave en el paso 2.', false);
    const det = detectProvider(key);
    if (det && det !== prov) { prov = det; $('sp').value = det; note(); }
    $('go3').disabled = true; say('Probando…'); $('msg').className = 'hint';
    const sv = await window.sigma.saveSettings({ provider: prov, models: {}, apiKey: key });
    if (!sv || sv.ok === false) { $('go3').disabled = false; return say((sv && sv.error) || 'No se pudo guardar la clave.', false); }
    const r = await window.sigma.generate('Responde con una sola palabra.', 'Di "listo".');
    $('go3').disabled = false;
    if (!r.ok) { await window.sigma.deleteKey(prov); await refreshAI(); return say(r.error, false); }
    await refreshAI();
    $('msg').innerHTML = `<span class="msg-ok">¡Listo! Tu IA quedó conectada (${esc(PROVIDERS[prov])}).</span><br><button class="primary" id="start">Empezar a usar EduPanel</button>`;
    $('start').onclick = () => go('registrar');
  };
}

// ================= PREGUNTAS FRECUENTES =================
const FAQ_ITEMS = [
  ['¿Qué es EduPanel Docente?', 'Un asistente de escritorio para planear, evaluar y llevar el registro de tu grupo, con inteligencia artificial como apoyo. Es un proyecto independiente: no es una herramienta oficial del MEP.'],
  ['¿Qué es una “clave de IA” (API key) y por qué la necesito?', 'Es una contraseña personal que te da el proveedor de IA (Claude, OpenAI o Gemini). Con ella la app le pide textos a la IA en tu nombre, y el uso se cuenta en tu cuenta del proveedor.'],
  ['¿Dónde consigo mi clave?', 'En Perfil → IA, pulsa “Asistente paso a paso”: te abre la página correcta del proveedor y te guía. Cada proveedor tiene sus propias condiciones; léelas en su página.'],
  ['¿Cuánto cuesta usar la IA?', 'La app no te cobra. El proveedor puede cobrar o limitar el uso según tu plan: cada consulta gasta una pequeña parte de tu saldo o cuota. Conviene poner un límite mensual bajo en la cuenta del proveedor.'],
  ['Dice que mi clave no es válida', 'Revisa que la copiaste completa y sin espacios, que corresponde al proveedor elegido y que tu cuenta tiene saldo o cuota disponible. Si sigue fallando, vuelve a crear una clave nueva.'],
  ['¿Qué datos salen de mi computador?', 'El registro (estudiantes, notas, asistencia) se queda en tu equipo. A la IA solo va lo que escribes en cada formulario y, si dejas marcada la casilla de contexto, el perfil de la zona y cifras del grupo (cuántos son, edades, conectividad), nunca nombres ni notas. Cuidado: en Retroalimentación, el texto del trabajo que pegues sí se envía al proveedor; no incluyas nombres ni datos personales.'],
  ['¿Qué es el PIN y qué pasa si lo olvido?', 'Es un candado opcional (Perfil → Seguridad). Si lo olvidas, en la pantalla de bloqueo usa “Olvidé mi PIN” con el código de recuperación que se te mostró al crearlo. Si perdiste el PIN y el código, la única salida es restablecer la app, y eso borra todos los datos. Por eso conviene guardar el código en papel y hacer respaldos.'],
  ['¿La app se bloquea sola?', 'Sí, si tienes PIN: después de unos minutos sin usarla (tú eliges 1, 5, 15 o 30), al bloquear la sesión de Windows o al suspender el equipo. También puedes bloquearla tú con el botón “Bloquear ahora”.'],
  ['¿Mis datos están cifrados?', 'Sí: se guardan cifrados con el almacén seguro de tu cuenta de Windows, lo que los protege si alguien copia los archivos a otro equipo u otra cuenta. El PIN protege la app abierta. Ninguna de estas medidas ayuda si alguien usa tu sesión de Windows ya desbloqueada, así que usa también contraseña en Windows y bloquea el equipo cuando te ausentes.'],
  ['¿Cómo hago un respaldo o paso mis datos a otro computador?', 'En Perfil → Datos y seguridad pulsa “Exportar respaldo”, y en el otro equipo “Importar respaldo”. La clave de IA y el PIN no viajan en el respaldo: se configuran de nuevo. El archivo NO está cifrado y contiene datos de estudiantes: guárdalo en un lugar seguro.'],
  ['¿Cómo importo mi lista de estudiantes desde Excel?', 'En Registrar → Estudiantes → Importar lista, copia las filas desde Excel y pégalas en el cuadro (o carga un .csv). La app reconoce los encabezados y te muestra una vista previa antes de importar.'],
  ['¿Funciona sin internet?', 'El registro, la asistencia y las notas sí. Las funciones de IA necesitan internet.'],
  ['La IA se equivocó o inventó algo', 'Puede pasar. La IA sugiere borradores: revisa todo antes de usarlo en el aula y compáralo con el programa de estudio oficial. El criterio pedagógico es tuyo.'],
  ['Algo falló o la app se comportó raro', 'La app anota los errores en Perfil → Seguridad → Registro de errores. Puedes copiar el registro o enviarlo por correo al creador. Está diseñado para no incluir tu clave de IA ni datos de la lista de estudiantes.'],
  ['¿Cómo contacto al creador?', 'En Perfil → Acerca de encontrarás su nombre y correo de contacto, además de la intención del proyecto.'],
  ['¿Es una herramienta oficial del MEP?', 'No. Es un proyecto independiente y no está afiliado al MEP. Los programas de estudio y sus contenidos pertenecen al Ministerio.'],
  ['¿Cómo borro mis datos y desinstalo?', 'En Perfil → Datos y seguridad usa “Borrar todos mis datos” y después desinstala la app desde Configuración de Windows → Aplicaciones.']
];

// ================= Render principal =================
function showViewError(e) {
  reportError('vista:' + route.tab, e);
  try {
    $view.innerHTML = '<div class="card empty"><b>No se pudo mostrar esta pantalla.</b><br>Se guardó un registro del problema.<br><br><button class="primary" id="rb">Volver al inicio</button></div>';
    $('rb').onclick = () => { route = { tab: 'registrar', sub: 'panel' }; render(); };
  } catch {}
}
function render() {
  if (locked) return;
  try {
    renderHeader();
    let r;
    if (route.tab === 'setup') r = viewSetup();
    else if (route.tab === 'registrar') r = viewRegistrar();
    else if (route.tab === 'planear') r = viewPlanear();
    else if (route.tab === 'crear') r = viewCrear();
    else if (route.tab === 'perfil') r = viewPerfil();
    if (r && typeof r.catch === 'function') r.catch(showViewError);
  } catch (e) { showViewError(e); }
}

// ================= Candado y arranque =================
let waitTimer = null;
const lockCard = (inner) => `<div class="lock-card"><div class="lock-ico">🔒</div><h1>EduPanel Docente</h1>${inner}</div>`;
function hideLock() { clearInterval(waitTimer); $('lock').hidden = true; $('lock').innerHTML = ''; document.body.classList.remove('locked'); }

function lockApp() {
  locked = true; dbReady = false; db = EMPTY();
  $view.innerHTML = ''; $('inst').innerHTML = ''; $('aiStatus').textContent = '';
  document.body.classList.add('locked');
  window.sigma.pinLock().catch(() => {});
  showUnlock(0);
}

async function wipeEverything() {
  await window.sigma.resetAll();
  try { localStorage.clear(); } catch {}
  hideLock();
  db = EMPTY(); dbReady = true; locked = false;
  await refreshAI();
  go('setup');
}

function showRecoveryCode(code) {
  $('lock').innerHTML = lockCard(`<p class="sub">PIN restablecido. Este es tu nuevo código de recuperación.</p>
    <div class="recovery"><div class="code">${esc(code)}</div><p class="hint">Anótalo en papel. Solo se muestra ahora.</p></div>
    <label class="chk"><input type="checkbox" id="rsaved" /> Ya lo guardé</label>
    <button class="primary" id="rcont" style="width:100%" disabled>Continuar</button>`);
  $('rsaved').onchange = (e) => { $('rcont').disabled = !e.target.checked; };
  $('rcont').onclick = () => afterUnlock();
}

function showRecover() {
  clearInterval(waitTimer);
  $('lock').innerHTML = lockCard(`<p class="sub">Escribe el código de recuperación y elige un PIN nuevo.</p>
    <input id="rcode" class="txt" placeholder="XXXX-XXXX-XXXX" autocomplete="off" />
    <input id="rpin1" type="password" inputmode="numeric" maxlength="8" placeholder="PIN nuevo" autocomplete="off" />
    <input id="rpin2" type="password" inputmode="numeric" maxlength="8" placeholder="Repite el PIN" autocomplete="off" />
    <button class="primary" id="rgo" style="width:100%">Restablecer PIN</button><div id="rmsg" class="msg-err" role="alert" style="margin-top:10px"></div>
    <p><button class="link" id="rback">Volver</button> · <button class="link" id="rwipe">No tengo el código</button></p>`);
  const msg = (t) => { $('rmsg').textContent = t; };
  $('rback').onclick = () => showUnlock(0);
  $('rwipe').onclick = showWipe;
  $('rgo').onclick = async () => {
    if ($('rpin1').value !== $('rpin2').value) return msg('Los PIN no coinciden.');
    $('rgo').disabled = true;
    const r = await window.sigma.pinRecover($('rcode').value, $('rpin1').value);
    $('rgo').disabled = false;
    if (r && r.ok) return showRecoveryCode(r.recovery);
    msg(r && r.wait ? `Demasiados intentos. Espera ${r.wait} segundos.` : (r && r.error) || 'No se pudo restablecer el PIN.');
  };
}

function showWipe() {
  $('lock').innerHTML = lockCard(`<p class="sub">Sin el PIN ni el código de recuperación no es posible recuperar los datos. Puedes restablecer la app: <b>se borrará todo</b> (estudiantes, notas, asistencia, clave de IA y PIN).</p>
    <input id="wt" class="txt" placeholder="Escribe BORRAR" autocomplete="off" />
    <button class="primary" id="wgo" style="width:100%">Borrar todo y empezar de cero</button><div id="wmsg" class="msg-err" style="margin-top:10px"></div>
    <p><button class="link" id="wback">Volver</button></p>`);
  $('wback').onclick = () => showUnlock(0);
  $('wgo').onclick = async () => {
    if ($('wt').value.trim().toUpperCase() !== 'BORRAR') { $('wmsg').textContent = 'Escribe BORRAR para confirmar.'; return; }
    await wipeEverything();
  };
}

function showUnlock(initialWait) {
  clearInterval(waitTimer);
  const L = $('lock');
  L.hidden = false; document.body.classList.add('locked');
  L.innerHTML = lockCard(`<p class="sub">Escribe tu PIN para continuar.</p>
    <input id="lpin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="PIN" />
    <button class="primary" id="lgo" style="width:100%">Entrar</button>
    <div id="lmsg" class="msg-err" role="alert" style="margin-top:10px"></div>
    <p><button class="link" id="lforgot">Olvidé mi PIN</button></p>`);
  const msg = (t) => { $('lmsg').textContent = t; };
  const countdown = (sec) => {
    clearInterval(waitTimer);
    let n = sec;
    $('lpin').disabled = true; $('lgo').disabled = true;
    const tick = () => {
      if (n <= 0) { clearInterval(waitTimer); $('lpin').disabled = false; $('lgo').disabled = false; msg(''); $('lpin').focus(); return; }
      msg(`Demasiados intentos. Espera ${n} s.`); n--;
    };
    tick(); waitTimer = setInterval(tick, 1000);
  };
  const submit = async () => {
    const pin = $('lpin').value;
    if (!pin) return;
    $('lgo').disabled = true;
    const r = await window.sigma.pinUnlock(pin);
    $('lgo').disabled = false;
    if (r && r.ok) return afterUnlock();
    $('lpin').value = '';
    if (r && r.wait) countdown(r.wait); else msg((r && r.error) || 'No se pudo verificar el PIN.');
  };
  $('lgo').onclick = submit;
  $('lpin').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('lforgot').onclick = showRecover;
  if (initialWait) countdown(initialWait); else $('lpin').focus();
}

async function loadDb() {
  const r = await window.sigma.dbLoad();
  if (!r || r.ok === false) throw new Error((r && r.error) || 'No se pudieron leer los datos');
  dbReady = false;
  if (r.state === 'none') {
    // Migración desde la versión anterior, que guardaba los datos en el navegador sin cifrar
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem('edupanel-db')); } catch (e) { reportError('migracion', e); }
    db = legacy ? sanitizeDb(legacy) : EMPTY();
    dbReady = true;
    if (legacy) {
      const w = await window.sigma.dbSave(JSON.stringify(db));
      if (w && w.ok) { try { localStorage.removeItem('edupanel-db'); } catch {} }
      else toast('No se pudieron proteger los datos anteriores. No se borraron: inténtalo de nuevo.', 'err');
    }
  } else if (r.state === 'corrupt') {
    db = EMPTY(); dbReady = true;
    toast('No se pudieron leer los datos guardados. Se conservó una copia dañada. Puedes importar un respaldo en Perfil → Datos y seguridad.', 'err');
  } else {
    db = sanitizeDb(r.data); dbReady = true;
    if (r.state === 'recovered') toast('Se recuperó la copia automática más reciente de tus datos.');
  }
}

function routeAfterLoad() {
  route = { tab: 'registrar', sub: 'panel' };
  const noKey = !Object.values(aiCfg.hasKey).some(Boolean);
  let skipped = false;
  try { skipped = !!localStorage.getItem('edupanel-setup-skipped'); } catch {}
  if (noKey && !skipped) go('setup'); else render();
}

async function afterUnlock() {
  try {
    hideLock(); locked = false;
    await loadDb();
    await refreshAI();
    routeAfterLoad();
  } catch (e) { showFatal(e); }
}

function showFatal(e) {
  reportError('inicio', e);
  document.body.classList.remove('locked');
  $('lock').hidden = false;
  $('lock').innerHTML = lockCard(`<p class="sub">No se pudo iniciar la aplicación. Se guardó un registro del problema.</p>
    <button class="primary" id="retry" style="width:100%">Reintentar</button>`);
  $('retry').onclick = () => boot();
}

async function boot() {
  try {
    const st = await window.sigma.pinStatus();
    if (st && st.enabled && st.locked) { locked = true; showUnlock(st.wait); return; }
    hideLock(); locked = false;
    await loadDb();
    await refreshAI();
    routeAfterLoad();
  } catch (e) { showFatal(e); }
}

window.sigma.onLock(() => lockApp());
let lastPing = 0;
['mousemove', 'keydown', 'click', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => {
  const n = Date.now();
  if (!locked && n - lastPing > 5000) { lastPing = n; window.sigma.activity().catch(() => {}); }
}, { passive: true }));

boot();
