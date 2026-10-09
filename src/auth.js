/**
 * Authentication primitives.
 *
 * Two independent gates, per the architecture plan:
 *
 *   League Password — gates the landing page, every tool, and every data API
 *   route. Verified once, then carried in a signed session cookie.
 *
 *   Admin Password — gates Site Configuration only. Deliberately has NO
 *   persistent session: it is re-checked on every page open and every
 *   individual setting change, a "sudo per sensitive action" model.
 *
 * CPU note: Workers Free allows ~10ms CPU per invocation. PBKDF2 is deliberately
 * expensive, so it runs only on an actual password check — never per request.
 * Ordinary requests verify an HMAC over a short cookie, which is one SHA-256.
 */

const enc = new TextEncoder();

// Tuned by measurement against a deployed Free-plan Worker, not guessed.
export const PBKDF2_ITERATIONS = 100000;

function b64urlEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

/**
 * Compare two strings without leaking their relationship through timing.
 * Length is compared first only to size the loop; every byte is still mixed in.
 */
export function timingSafeEqual(a, b) {
  const x = String(a === undefined || a === null ? '' : a);
  const y = String(b === undefined || b === null ? '' : b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i % x.length || 0) || 0) ^ (y.charCodeAt(i % y.length || 0) || 0);
  }
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

/** Produce a self-describing hash string: pbkdf2$<iterations>$<salt>$<hash> */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  let salt;
  try {
    salt = b64urlDecodeBytes(parts[2]);
  } catch {
    return false;
  }
  const hash = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(b64urlEncode(hash), parts[3]);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function sign(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64urlEncode(sig);
}

/**
 * Issue a session token. Payload is visible (base64url, not encrypted) but
 * cannot be altered without the secret, which never leaves the Worker.
 */
export async function createSession(secret, scope, ttlSeconds) {
  const payload = {
    s: scope,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    n: randomToken(8),
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await sign(secret, body);
  return `${body}.${sig}`;
}

export async function readSession(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await sign(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export const SESSION_COOKIE = 'eft_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours — caps how long an
// abandoned tab can keep polling, which is the only usage pattern that scales
// cost with time rather than with people.

/* How long a League Password sign-in lasts. The administrator picks a stop on this scale in Site Configuration;
   null (nothing chosen) means the default. 'infinite' is a ten-year session, which no browser outlasts. */
export const SESSION_STOPS = [1, 2, 4, 8, 12, 24, 72, 168, 720, 2160, 'infinite'];
export const SESSION_DEFAULT_HOURS = 8;
export const SESSION_INFINITE_SECONDS = 60 * 60 * 24 * 3650;
export function sessionHoursOf(cfg) {
  const v = cfg && cfg.sessionHours;
  return SESSION_STOPS.includes(v) ? v : SESSION_DEFAULT_HOURS;
}
export function sessionSecondsOf(cfg) {
  const h = sessionHoursOf(cfg);
  return h === 'infinite' ? SESSION_INFINITE_SECONDS : h * 3600;
}
/** "8 hours", "3 days", "forever": the length in the words members and the administrator read. */
export function sessionWords(h) {
  if (h === 'infinite') return 'until signed out or the League Password changes';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = h / 24;
  return `${d} day${d === 1 ? '' : 's'}`;
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const piece of header.split(';')) {
    const idx = piece.indexOf('=');
    if (idx < 0) continue;
    if (piece.slice(0, idx).trim() === name) return piece.slice(idx + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Does this request carry a valid League Password session? */
export async function hasLeagueSession(request, cfg) {
  if (!cfg.sessionSecret) return false;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const payload = await readSession(cfg.sessionSecret, token);
  if (!payload || payload.s !== 'league') return false;
  // A changed League Password ends every sign-in made before it, however long that sign-in was meant to last.
  if (Number.isFinite(cfg.sessionsFrom) && !(payload.iat >= cfg.sessionsFrom)) return false;
  return true;
}

/**
 * Verify the Admin Password for a single action.
 *
 * There is intentionally no admin session and no cookie — the caller must
 * present the password on every admin page open and every setting change.
 */
export async function checkAdminPassword(cfg, supplied) {
  if (!cfg.adminPasswordHash) return false;
  if (!supplied) return false;
  return verifyPassword(supplied, cfg.adminPasswordHash);
}
