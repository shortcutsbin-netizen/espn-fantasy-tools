/**
 * Login rate limiting.
 *
 * One Durable Object instance per client IP. Password checks are deliberately
 * expensive, but expense alone does not stop a patient attacker, and the League
 * Password is the only thing standing in front of real league-member data. A
 * sliding window caps how fast guesses can be made.
 *
 * Failures count; a success clears the window, so an ordinary user who mistypes
 * a few times is never penalised once they get it right.
 */

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILURES = 10;

export class LoginThrottle {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.failures = null;

    this.state.blockConcurrencyWhile(async () => {
      this.failures = (await this.state.storage.get('failures')) || [];
    });
  }

  prune(now) {
    this.failures = this.failures.filter((t) => now - t < WINDOW_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    this.prune(now);

    if (url.pathname === '/check') {
      const blocked = this.failures.length >= MAX_FAILURES;
      return json({
        blocked,
        failures: this.failures.length,
        retryAfterSeconds: blocked
          ? Math.max(1, Math.ceil((WINDOW_MS - (now - this.failures[0])) / 1000))
          : 0,
      });
    }

    if (url.pathname === '/fail') {
      this.failures.push(now);
      await this.state.storage.put('failures', this.failures);
      const blocked = this.failures.length >= MAX_FAILURES;
      return json({ blocked, failures: this.failures.length });
    }

    if (url.pathname === '/succeed') {
      this.failures = [];
      await this.state.storage.put('failures', this.failures);
      return json({ blocked: false, failures: 0 });
    }

    if (url.pathname === '/reset') {
      this.failures = [];
      await this.state.storage.put('failures', this.failures);
      return json({ ok: true });
    }

    return json({ error: 'unknown throttle route' }, 404);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ---------------------------------------------------------------- client side

function clientKey(request) {
  // CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
  // client; the fallbacks only ever apply in local testing.
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown'
  );
}

function stub(env, request) {
  return env.THROTTLE.get(env.THROTTLE.idFromName(clientKey(request)));
}

/* At Protect (C5) each isolate passes at most 10 sign-in attempts a minute to the throttle object and asks anyone
   beyond that to wait a minute, so a flood at the sign-in form cannot spend the backend's reserve. */
export const PROTECT_SIGNINS_PER_MINUTE = 10;
const CAP = { minute: -1, n: 0 };

export async function throttleCheck(env, request) {
  if (!env.THROTTLE) return { blocked: false, failures: 0, retryAfterSeconds: 0 };
  if (env.BRAKE === 'protect' || env.BRAKE === 'limit') {
    const now = Date.now(), m = Math.floor(now / 60000);
    if (CAP.minute !== m) { CAP.minute = m; CAP.n = 0; }
    CAP.n += 1;
    if (CAP.n > PROTECT_SIGNINS_PER_MINUTE) return { blocked: true, busy: true, failures: 0, retryAfterSeconds: Math.max(1, Math.ceil(((m + 1) * 60000 - now) / 1000)) };
  }
  // The throttle only slows a guesser down. If its object cannot answer (a Cloudflare daily limit spent, say), a
  // sign-in must still work: the password is checked either way.
  try {
    const res = await stub(env, request).fetch('https://throttle/check');
    return await res.json();
  } catch { return { blocked: false, failures: 0, retryAfterSeconds: 0 }; }
}

export async function throttleFail(env, request) {
  if (!env.THROTTLE) return { blocked: false, failures: 0 };
  try {
    const res = await stub(env, request).fetch('https://throttle/fail');
    return await res.json();
  } catch { return { blocked: false, failures: 0 }; }
}

export async function throttleSucceed(env, request) {
  if (!env.THROTTLE) return;
  try { await stub(env, request).fetch('https://throttle/succeed'); } catch { /* nothing to clear */ }
}
