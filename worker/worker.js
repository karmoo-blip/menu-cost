/**
 * Menu Cost — Cloudflare Worker backend.
 * Page files in public/ are served by Workers static assets; this code only handles /api/*.
 * There is no sign-in: anyone with the address can read and change shop data.
 * New shops and photo uploads are limited per connection so storage cannot be filled up.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LIMIT_WINDOW_SECONDS = 60 * 60;
const MAX_NEW_SHOPS_PER_HOUR = 20;
const MAX_PHOTOS_PER_HOUR = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
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
  const by = '';  // no sign-in, so saves are not tied to a name
  const method = request.method;
  const path = url.pathname;

  if (path === '/api/shops' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, currency, updated_at FROM shops ORDER BY updated_at DESC'
    ).all();
    return json(results.map(r => ({ id: r.id, name: r.name, currency: r.currency, modifiedTime: r.updated_at })));
  }

  if (path === '/api/shops' && method === 'POST') {
    await checkLimit(request, env, 'shop', MAX_NEW_SHOPS_PER_HOUR);
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

  if (path === '/api/photos' && method === 'POST') {
    await checkLimit(request, env, 'photo', MAX_PHOTOS_PER_HOUR);
    return await uploadPhoto(request, env);
  }
  const p = path.match(/^\/api\/photos\/(p_[a-f0-9]{32}\.(?:jpg|png|webp))$/);
  if (p && method === 'GET') return await getPhoto(env, p[1]);

  throw new HttpError(404, 'Not found');
}

/* ---------- step photos (R2) ---------- */

const MAX_PHOTO_BYTES = 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function photoBucket(env) {
  if (!env.PHOTOS) throw new HttpError(503, 'Photo storage is not set up yet (R2 bucket menu-cost-photos).');
  return env.PHOTOS;
}

// Body is the raw image (the app shrinks it first). Returns the key to store in the menu step.
async function uploadPhoto(request, env) {
  const bucket = photoBucket(env);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  const ext = PHOTO_TYPES[type];
  if (!ext) throw new HttpError(415, 'Only JPEG, PNG or WebP photos can be uploaded.');
  if (Number(request.headers.get('Content-Length') || 0) > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo is too big (max 1 MB).');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, 'Photo is empty.');
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo is too big (max 1 MB).');
  const key = `p_${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  return json({ key });
}

async function getPhoto(env, key) {
  const obj = await photoBucket(env).get(key);
  if (!obj) throw new HttpError(404, 'Photo not found.');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      // Keys are never reused, so the browser can keep a photo. "private": not kept by shared caches.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
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

/* ---------- limits ---------- */

// Counts one use per connection and refuses it once the hourly limit is reached.
async function checkLimit(request, env, kind, max) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO usage_limits (ip, kind, count, first_at) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (ip, kind) DO UPDATE SET
       count = CASE WHEN ?3 - first_at >= ?4 THEN 1 ELSE count + 1 END,
       first_at = CASE WHEN ?3 - first_at >= ?4 THEN ?3 ELSE first_at END
     RETURNING count`
  ).bind(ip, kind, now, LIMIT_WINDOW_SECONDS).first();
  if (row.count > max) throw new HttpError(429, 'Too many new items from this connection. Wait an hour, then try again.');
}
