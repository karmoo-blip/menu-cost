/**
 * Menu Cost — Cloudflare Worker backend.
 * Page files in public/ are served by Workers static assets; this code only handles /api/*.
 * Sign-in is one family password (Worker secret APP_PASSWORD). A correct password gets a signed
 * cookie valid for 30 days. Changing the password signs every device out.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
const COOKIE = 'mc_session';
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (!env.APP_PASSWORD) throw new HttpError(503, 'The password is not set up yet (wrangler secret put APP_PASSWORD).');
      if (url.pathname === '/api/login' && request.method === 'POST') return await login(request, env);
      if (url.pathname === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, clearCookie());
      if (!(await validSession(request, env))) throw new HttpError(401, 'You were signed out. Enter the family password again.');
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/* ---------- routes ---------- */

async function route(request, env, url) {
  const by = '';  // shared family password, so saves are not tied to a name
  const method = request.method;
  const path = url.pathname;

  if (path === '/api/shops' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, currency, updated_at FROM shops ORDER BY updated_at DESC'
    ).all();
    return json(results.map(r => ({ id: r.id, name: r.name, currency: r.currency, modifiedTime: r.updated_at })));
  }

  if (path === '/api/shops' && method === 'POST') {
    const data = checkShop(await readBody(request));
    const id = 'shop_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO shops (id, name, currency, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, data.shopName, data.currency, JSON.stringify(data), now, by).run();
    return json({ id, modifiedTime: now, by });
  }

  const m = path.match(/^\/api\/shops\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(m[1]).first();
    if (!row) throw new HttpError(404, 'Shop not found.');
    return json({ data: JSON.parse(row.data), meta: { id: row.id, modifiedTime: row.updated_at, by: row.updated_by } });
  }

  if (m && method === 'PUT') {
    const body = await readBody(request);
    const data = checkShop(body?.data);
    const expected = typeof body.expectedModifiedTime === 'string' ? body.expectedModifiedTime : '';
    const now = new Date().toISOString();
    // Only overwrite if nobody else saved since this person loaded the shop.
    const sql = 'UPDATE shops SET name = ?, currency = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ?'
      + (expected ? ' AND updated_at = ?' : '');
    const args = [data.shopName, data.currency, JSON.stringify(data), now, by, m[1]];
    if (expected) args.push(expected);
    const res = await env.DB.prepare(sql).bind(...args).run();
    if (res.meta.changes === 0) {
      const row = await env.DB.prepare('SELECT updated_at, updated_by FROM shops WHERE id = ?').bind(m[1]).first();
      if (!row) throw new HttpError(404, 'Shop not found.');
      return json({ conflict: true, by: row.updated_by, modifiedTime: row.updated_at }, 409);
    }
    return json({ id: m[1], modifiedTime: now, by });
  }

  throw new HttpError(404, 'Not found');
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Shop data is too big.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Bad JSON'); }
}

function checkShop(data) {
  if (!data || typeof data !== 'object'
    || typeof data.shopName !== 'string' || !data.shopName.trim()
    || typeof data.currency !== 'string'
    || !Array.isArray(data.ingredients) || !Array.isArray(data.menus) || !Array.isArray(data.extras)) {
    throw new HttpError(400, 'Shop data is not valid.');
  }
  return data;
}

/* ---------- family password sign-in ---------- */

async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT fails, first_fail FROM login_attempts WHERE ip = ?').bind(ip).first();
  const inWindow = row && now - row.first_fail < LOCK_SECONDS;
  if (inWindow && row.fails >= MAX_FAILS) {
    const retryAfter = LOCK_SECONDS - (now - row.first_fail);
    throw new HttpError(429, `Too many wrong tries from this connection. Wait ${Math.ceil(retryAfter / 60)} minutes, then try again.`, { retryAfter });
  }

  const body = await readBody(request);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!(await sameText(password, env.APP_PASSWORD))) {
    if (inWindow) {
      await env.DB.prepare('UPDATE login_attempts SET fails = fails + 1 WHERE ip = ?').bind(ip).run();
    } else {
      await env.DB.prepare('INSERT OR REPLACE INTO login_attempts (ip, fails, first_fail) VALUES (?, 1, ?)').bind(ip, now).run();
    }
    throw new HttpError(401, 'Wrong password. Check with the family and try again.');
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const expires = now + SESSION_DAYS * 24 * 60 * 60;
  const value = expires + '.' + await sign(String(expires), env.APP_PASSWORD);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  });
}

function clearCookie() {
  return { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` };
}

async function validSession(request, env) {
  const cookies = request.headers.get('Cookie') || '';
  const m = cookies.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=(\\d+)\\.([A-Za-z0-9_-]+)'));
  if (!m) return false;
  if (Number(m[1]) <= Math.floor(Date.now() / 1000)) return false;
  return sameText(m[2], await sign(m[1], env.APP_PASSWORD));
}

// HMAC keyed with the password, so a new password makes every old cookie invalid.
async function sign(text, password) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('menu-cost-session:' + password),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compares in constant time (hashing first makes the lengths equal).
async function sameText(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(async t =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}
