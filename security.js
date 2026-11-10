// Funciones puras de seguridad (sin Electron) para poder probarlas por separado.
const crypto = require('crypto');

const PROVIDERS = ['anthropic', 'openai', 'gemini'];
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,80}$/;

// ---- PIN y código de recuperación (scrypt + sal) ----
const validPin = (p) => typeof p === 'string' && /^\d{4,8}$/.test(p);
function weakPin(p) {
  if (/^(\d)\1+$/.test(p)) return true; // 0000, 1111…
  const d = [...p].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return true; // 1234, 4321…
  return ['1212', '1122', '2580', '0852', '1357', '2468'].includes(p);
}
const newSalt = () => crypto.randomBytes(16).toString('hex');
const hashSecret = (secret, saltHex) => crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), 32).toString('hex');
function verifySecret(secret, saltHex, hashHex) {
  try {
    const a = Buffer.from(hashSecret(secret, saltHex), 'hex');
    const b = Buffer.from(hashHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusiones
function makeRecovery() {
  let c = '';
  for (let i = 0; i < 12; i++) c += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return c.match(/.{4}/g).join('-');
}
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Espera progresiva: cada 5 fallos 30 s, 60 s, 120 s… hasta 15 min
function failDelayMs(fails) {
  return fails > 0 && fails % 5 === 0 ? Math.min(30 * 2 ** (fails / 5 - 1), 900) * 1000 : 0;
}

// ---- Validación de entradas ----
function cleanKey(k) {
  const s = String(k ?? '').replace(/\s+/g, '');
  return s.length >= 10 && s.length <= 400 ? s : null;
}

// ---- Privacidad en los registros de error ----
const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)/gi;
function redact(s, home) {
  let t = String(s ?? '');
  if (home) t = t.split(home).join('~');
  return t
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\r\n\"'`]+/gi, '$1~') // usuario de Windows en rutas (puede llevar espacios)
    .replace(SECRET_RE, '[REDACTADO]')
    .replace(/(["'`])([^"'`\n]{25,})\1/g, '$1…$1'); // citas largas (p. ej. fragmentos de datos en errores de JSON)
}

// ---- Enlaces externos permitidos ----
function isAllowedLink(url, hosts, email) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return hosts.has(u.hostname);
    if (u.protocol === 'mailto:') return !!email && decodeURIComponent(u.pathname).toLowerCase() === String(email).toLowerCase();
  } catch {}
  return false;
}

// ---- Cifrado de archivos (el cifrador se inyecta: safeStorage en la app real) ----
function seal(str, cipher) {
  return cipher.available()
    ? Buffer.concat([Buffer.from('E1'), cipher.encrypt(str)])
    : Buffer.concat([Buffer.from('P1'), Buffer.from(str)]);
}
function unseal(buf, cipher) {
  const tag = buf.subarray(0, 2).toString();
  const body = buf.subarray(2);
  if (tag === 'E1') return cipher.decrypt(body);
  if (tag === 'P1') return body.toString();
  throw new Error('Formato de datos desconocido');
}

module.exports = { PROVIDERS, MODEL_RE, validPin, weakPin, newSalt, hashSecret, verifySecret, makeRecovery, normCode,
  failDelayMs, cleanKey, redact, isAllowedLink, seal, unseal };
