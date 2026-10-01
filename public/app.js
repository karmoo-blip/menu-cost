'use strict';

/* ============================================================
   Menu Cost — work out the cost of every menu item.
   Data lives in a Cloudflare D1 database (served by the Worker),
   or in this browser only when opened from localhost for testing.
   ============================================================ */

// True when served by the Cloudflare Worker (data in D1).
// False when opened from a local file server (data in this browser only, for testing).
const ONLINE = !['localhost', '127.0.0.1', ''].includes(location.hostname);
const DATA_VERSION = 1;
const SAVE_DELAY_MS = 1500;

const UNITS = {
  g:   { base: 'g',   factor: 1 },
  kg:  { base: 'g',   factor: 1000 },
  oz:  { base: 'g',   factor: 28.3495 },
  lb:  { base: 'g',   factor: 453.592 },
  ml:  { base: 'ml',  factor: 1 },
  l:   { base: 'ml',  factor: 1000 },
  pcs: { base: 'pcs', factor: 1 },
};
const CURRENCIES = { THB: 'Thai Baht (฿)', GBP: 'British Pound (£)' };

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function num(v) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function money(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: state.data?.currency || 'THB', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits,
  }).format(v);
}
function pct(v) {
  return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—';
}
function fmtNum(v) {
  return Number.isFinite(v) ? String(+v.toFixed(3)) : '';
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function download(filename, text, type = 'text/csv') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/* ---------- data model ---------- */

function emptyShop(name, currency) {
  return {
    version: DATA_VERSION,
    shopName: name,
    currency,
    targetCostPct: 35,
    ingredients: [],
    menus: [],
    extras: [],
  };
}

function normalizeShop(d) {
  d.version = d.version || DATA_VERSION;
  d.ingredients = d.ingredients || [];
  d.menus = d.menus || [];
  d.extras = d.extras || [];
  d.currency = CURRENCIES[d.currency] ? d.currency : 'THB';
  if (!Number.isFinite(d.targetCostPct)) d.targetCostPct = 35;
  return d;
}

function findIngredient(id) {
  return state.data.ingredients.find(i => i.id === id);
}

// Cost of one purchase unit, e.g. price per kg if the pack is in kg.
function costPerPackUnit(ing) {
  return ing.packSize > 0 ? ing.buyPrice / ing.packSize : NaN;
}
// Cost of one base unit (g / ml / pcs).
function costPerBaseUnit(ing) {
  const u = UNITS[ing.unit];
  return u && ing.packSize > 0 ? ing.buyPrice / (ing.packSize * u.factor) : NaN;
}
function recipeLineCost(line) {
  const ing = findIngredient(line.ingredientId);
  const u = UNITS[line.unit];
  if (!ing || !u || UNITS[ing.unit]?.base !== u.base) return NaN;
  return num(line.qty) * u.factor * costPerBaseUnit(ing);
}
function menusUsing(ingredientId) {
  return state.data.menus.filter(m => m.items.some(l => l.ingredientId === ingredientId));
}

function calcMenu(menu) {
  const data = state.data;
  const portions = menu.yield > 0 ? menu.yield : 1;
  let batchCost = 0;
  let problems = 0;
  for (const line of menu.items) {
    const c = recipeLineCost(line);
    if (Number.isFinite(c)) batchCost += c; else problems++;
  }
  const ingredientCost = batchCost / portions;
  const price = num(menu.sellPrice);
  let extrasCost = 0;
  const extrasLines = [];
  if (menu.useExtras !== false) {
    for (const ex of data.extras) {
      const amount = ex.type === 'percent'
        ? (Number.isFinite(price) ? price * ex.value / 100 : 0)
        : ex.value;
      extrasCost += amount;
      extrasLines.push({ name: ex.name, amount, ex });
    }
  }
  const totalCost = ingredientCost + extrasCost;
  const hasPrice = Number.isFinite(price) && price > 0;
  const foodCostPct = hasPrice ? ingredientCost / price : NaN;
  const target = data.targetCostPct / 100;
  let status = 'none';
  if (hasPrice && menu.items.length) {
    status = foodCostPct <= target ? 'ok' : foodCostPct <= target + 0.1 ? 'warn' : 'bad';
  }
  return {
    portions, batchCost, ingredientCost, extrasCost, extrasLines, totalCost,
    foodCostPct,
    totalCostPct: hasPrice ? totalCost / price : NaN,
    profit: hasPrice ? price - totalCost : NaN,
    suggestedPrice: target > 0 ? ingredientCost / target : NaN,
    status, problems,
  };
}

function statusPill(c) {
  if (c.status === 'none') return '<span class="muted">—</span>';
  const label = { ok: 'OK', warn: 'High', bad: 'Too high' }[c.status];
  return `<span class="pill ${c.status}">${pct(c.foodCostPct)} · ${label}</span>`;
}

/* ---------- example data ---------- */

const EXAMPLES = {
  THB: {
    ingredients: [
      ['Coffee beans', 450, 1, 'kg'],
      ['Fresh milk', 95, 2, 'l'],
      ['Sugar syrup', 120, 750, 'ml'],
      ['Matcha powder', 650, 100, 'g'],
      ['Ice', 30, 10, 'kg'],
      ['Plastic cup 16oz', 150, 50, 'pcs'],
      ['Lid + straw', 80, 50, 'pcs'],
      ['Frozen croissant', 400, 20, 'pcs'],
    ],
    menus: [
      ['Iced Latte', 'Coffee', 65, [['Coffee beans', 18, 'g'], ['Fresh milk', 150, 'ml'], ['Sugar syrup', 15, 'ml'], ['Ice', 150, 'g'], ['Plastic cup 16oz', 1, 'pcs'], ['Lid + straw', 1, 'pcs']]],
      ['Hot Americano', 'Coffee', 50, [['Coffee beans', 18, 'g']]],
      ['Iced Matcha Latte', 'Tea', 80, [['Matcha powder', 4, 'g'], ['Fresh milk', 180, 'ml'], ['Sugar syrup', 15, 'ml'], ['Ice', 150, 'g'], ['Plastic cup 16oz', 1, 'pcs'], ['Lid + straw', 1, 'pcs']]],
      ['Butter Croissant', 'Bakery', 55, [['Frozen croissant', 1, 'pcs']]],
    ],
    extras: [['Staff wages', 'percent', 15], ['Gas & electric', 'fixed', 2]],
  },
  GBP: {
    ingredients: [
      ['Coffee beans', 18, 1, 'kg'],
      ['Whole milk', 1.65, 2, 'l'],
      ['Vanilla syrup', 6, 1, 'l'],
      ['Matcha powder', 15, 100, 'g'],
      ['Ice', 2, 5, 'kg'],
      ['Takeaway cup 12oz', 6, 50, 'pcs'],
      ['Lid', 3.5, 50, 'pcs'],
      ['Frozen croissant', 12, 20, 'pcs'],
    ],
    menus: [
      ['Iced Latte', 'Coffee', 3.6, [['Coffee beans', 18, 'g'], ['Whole milk', 200, 'ml'], ['Ice', 120, 'g'], ['Takeaway cup 12oz', 1, 'pcs'], ['Lid', 1, 'pcs']]],
      ['Americano', 'Coffee', 3.0, [['Coffee beans', 18, 'g']]],
      ['Vanilla Matcha Latte', 'Tea', 4.2, [['Matcha powder', 4, 'g'], ['Whole milk', 220, 'ml'], ['Vanilla syrup', 15, 'ml'], ['Takeaway cup 12oz', 1, 'pcs'], ['Lid', 1, 'pcs']]],
      ['Butter Croissant', 'Bakery', 3.2, [['Frozen croissant', 1, 'pcs']]],
    ],
    extras: [['Staff wages', 'percent', 15], ['Gas & electric', 'fixed', 0.1]],
  },
};

function loadExampleData() {
  const d = state.data;
  const ex = EXAMPLES[d.currency];
  const ids = {};
  for (const [name, buyPrice, packSize, unit] of ex.ingredients) {
    let ing = d.ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (!ing) {
      ing = { id: uid('ing'), name, buyPrice, packSize, unit, example: true };
      d.ingredients.push(ing);
    }
    ids[name] = ing;
  }
  for (const [name, category, sellPrice, items] of ex.menus) {
    if (d.menus.some(m => m.name.toLowerCase() === name.toLowerCase())) continue;
    d.menus.push({
      id: uid('menu'), name, category, sellPrice, yield: 1, useExtras: true, example: true,
      items: items
        .filter(([n, , unit]) => UNITS[ids[n].unit].base === UNITS[unit].base)
        .map(([n, qty, unit]) => ({ ingredientId: ids[n].id, qty, unit })),
    });
  }
  for (const [name, type, value] of ex.extras) {
    if (d.extras.some(e => e.name.toLowerCase() === name.toLowerCase())) continue;
    d.extras.push({ id: uid('ex'), name, type, value, example: true });
  }
}

function clearExampleData() {
  const d = state.data;
  d.menus = d.menus.filter(m => !m.example);
  d.extras = d.extras.filter(e => !e.example);
  // Keep example ingredients that your own menus still use.
  d.ingredients = d.ingredients.filter(i => !i.example || menusUsing(i.id).length);
}

function hasExampleData() {
  const d = state.data;
  return d.ingredients.some(i => i.example) || d.menus.some(m => m.example) || d.extras.some(e => e.example);
}

/* ---------- CSV ---------- */

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

function toCSV(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}

const CSV_HEADER = ['name', 'buy_price', 'pack_size', 'unit'];

function templateCSV() {
  const ex = EXAMPLES[state.data.currency].ingredients.slice(0, 3);
  return toCSV([CSV_HEADER, ...ex]);
}

// Returns { adds, updates, errors } without changing data.
function planImport(text) {
  const rows = parseCSV(text);
  const result = { adds: [], updates: [], errors: [] };
  if (!rows.length) { result.errors.push('The file is empty.'); return result; }
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = name => header.indexOf(name);
  const missing = CSV_HEADER.filter(h => col(h) < 0);
  if (missing.length) {
    result.errors.push(`Missing column(s): ${missing.join(', ')}. First row must be: ${CSV_HEADER.join(',')}`);
    return result;
  }
  const seen = new Set();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const name = (r[col('name')] || '').trim();
    const buyPrice = num(r[col('buy_price')]);
    const packSize = num(r[col('pack_size')]);
    const unit = (r[col('unit')] || '').trim().toLowerCase();
    if (!name) return result.errors.push(`Row ${line}: name is empty.`);
    if (!(buyPrice >= 0)) return result.errors.push(`Row ${line} (${name}): buy_price is not a number.`);
    if (!(packSize > 0)) return result.errors.push(`Row ${line} (${name}): pack_size must be more than 0.`);
    if (!UNITS[unit]) return result.errors.push(`Row ${line} (${name}): unit "${unit}" not known. Use ${Object.keys(UNITS).join(', ')}.`);
    const key = name.toLowerCase();
    if (seen.has(key)) return result.errors.push(`Row ${line} (${name}): same name appears twice in the file.`);
    seen.add(key);
    const existing = state.data.ingredients.find(i => i.name.toLowerCase() === key);
    if (existing) {
      if (UNITS[existing.unit].base !== UNITS[unit].base && menusUsing(existing.id).length) {
        return result.errors.push(`Row ${line} (${name}): unit type changes (${existing.unit} → ${unit}) but menus use it. Fix by hand.`);
      }
      result.updates.push({ existing, buyPrice, packSize, unit });
    } else {
      result.adds.push({ name, buyPrice, packSize, unit });
    }
  });
  return result;
}

function applyImport(plan) {
  for (const u of plan.updates) {
    const ing = u.existing;
    Object.assign(ing, { buyPrice: u.buyPrice, packSize: u.packSize, unit: u.unit });
    delete ing.example;
  }
  for (const a of plan.adds) {
    state.data.ingredients.push({ id: uid('ing'), ...a });
  }
}

function ingredientsCSV() {
  const rows = [...state.data.ingredients].sort(byName).map(i => [i.name, i.buyPrice, i.packSize, i.unit]);
  return toCSV([CSV_HEADER, ...rows]);
}

function menusCSV() {
  const rows = [...state.data.menus].sort(byName).map(m => {
    const c = calcMenu(m);
    const r = v => Number.isFinite(v) ? v.toFixed(2) : '';
    return [m.name, m.category || '', r(num(m.sellPrice)), r(c.ingredientCost), r(c.extrasCost), r(c.totalCost),
      Number.isFinite(c.foodCostPct) ? (c.foodCostPct * 100).toFixed(1) : '', r(c.profit), r(c.suggestedPrice)];
  });
  return toCSV([['menu', 'category', 'sell_price', 'ingredient_cost', 'extras_cost', 'total_cost', 'food_cost_pct', 'profit', 'suggested_price'], ...rows]);
}

/* ---------- storage: this browser only ---------- */

const LocalStore = {
  key: 'menucost_local_shops',
  all() {
    try { return JSON.parse(lsGet(this.key) || '{}'); } catch { return {}; }
  },
  write(all) { lsSet(this.key, JSON.stringify(all)); },
  async listShops() {
    return Object.entries(this.all()).map(([id, s]) => ({
      id, name: s.data.shopName, currency: s.data.currency, modifiedTime: s.modifiedTime, owner: '',
    })).sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  },
  async create(data) {
    const all = this.all();
    const id = uid('shop');
    const modifiedTime = new Date().toISOString();
    all[id] = { data, modifiedTime };
    this.write(all);
    return { id, modifiedTime, by: '' };
  },
  async load(id) {
    const s = this.all()[id];
    if (!s) throw new Error('Shop not found.');
    return { data: s.data, meta: { id, modifiedTime: s.modifiedTime, by: '' } };
  },
  async save(id, data, expectedModifiedTime) {
    const all = this.all();
    if (!all[id]) throw new Error('Shop not found.');
    if (expectedModifiedTime && all[id].modifiedTime !== expectedModifiedTime) {
      throw Object.assign(new Error('conflict'), { conflict: true, by: 'another tab', modifiedTime: all[id].modifiedTime });
    }
    const modifiedTime = new Date().toISOString();
    all[id] = { data, modifiedTime };
    this.write(all);
    return { id, modifiedTime, by: '' };
  },
};

/* ---------- storage: Cloudflare (Worker + D1) ---------- */

// Calls the Worker API. The sign-in cookie goes along automatically.
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON, e.g. login page after session expired */ }
  if (res.status === 409 && json?.conflict) throw Object.assign(new Error('conflict'), json);
  if (res.status === 401) {
    throw Object.assign(new Error(json?.error || 'You were signed out. Enter the family password again.'), { auth: true });
  }
  if (!res.ok || !json) {
    throw Object.assign(new Error(json?.error || `Server error (${res.status}). Check your internet and try again.`),
      { status: res.status, retryAfter: json?.retryAfter });
  }
  return json;
}

const ApiStore = {
  async login(password) { await api('POST', '/api/login', { password }); },
  async logout() { await api('POST', '/api/logout'); },
  listShops() { return api('GET', '/api/shops'); },
  create(data) { return api('POST', '/api/shops', data); },
  load(id) { return api('GET', `/api/shops/${encodeURIComponent(id)}`); },
  save(id, data, expectedModifiedTime) {
    return api('PUT', `/api/shops/${encodeURIComponent(id)}`, { data, expectedModifiedTime });
  },
};

const store = ONLINE ? ApiStore : LocalStore;

/* ---------- app state & saving ---------- */

const state = {
  screen: 'loading',  // loading | login | shops | app
  loginError: '',
  loginLocked: false,
  shops: [],
  shopId: null,
  meta: null,         // { modifiedTime, by }
  data: null,
  tab: lsGet('menucost_tab') || 'menus',
  search: '',
  saveState: 'saved', // saved | dirty | saving | error
  saveError: '',
};

let saveTimer = null;
let saving = null;
let editCount = 0;

function mutate(fn) {
  fn(state.data);
  editCount++;
  state.saveState = 'dirty';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  render();
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) { await saving; if (state.saveState !== 'dirty') return; }
  if (state.saveState !== 'dirty' && state.saveState !== 'error') return;
  state.saveState = 'saving';
  renderSaveStatus();
  const savedEdit = editCount;
  saving = (async () => {
    try {
      const meta = await store.save(state.shopId, state.data, state.meta?.modifiedTime);
      state.meta = meta;
      // More edits may have happened while saving; save those too.
      state.saveState = editCount === savedEdit ? 'saved' : 'dirty';
      if (state.saveState === 'dirty') saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    } catch (err) {
      state.saveState = 'error';
      state.saveError = err.message;
      if (err.conflict) showConflict(err);
      // Unsaved changes stay in memory and are saved again after signing in.
      if (err.auth) showLogin('You were signed out. Sign in again to save your changes.');
    }
  })();
  await saving;
  saving = null;
  renderSaveStatus();
}

function showConflict(err) {
  openModal({
    title: 'Someone else saved changes',
    body: `<p><b>${esc(err.by || 'Someone')}</b> saved this shop at ${esc(fmtTime(err.modifiedTime))}, after you opened it.</p>
      <p>To avoid losing their work, reload their version. Your last change (from the past few seconds) will be lost, so you may need to redo it.</p>`,
    buttons: [
      { label: 'Keep mine (overwrite theirs)', className: 'danger left', onClick: async () => {
        state.meta = { ...state.meta, modifiedTime: err.modifiedTime };
        state.saveState = 'dirty';
        await saveNow();
      } },
      { label: 'Reload their version', className: 'primary', onClick: () => openShop(state.shopId) },
    ],
  });
}

window.addEventListener('beforeunload', e => {
  if (state.saveState === 'dirty' || state.saveState === 'saving') { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.saveState === 'dirty') saveNow();
});

/* ---------- flows ---------- */

async function start() {
  render();
  try {
    state.shops = await store.listShops();
  } catch (err) {
    if (err.auth) { showLogin(); return; }
    showFatal(`<h2>Could not open Menu Cost</h2><p class="error-text">${esc(err.message)}</p>
      <p class="muted">Check your internet connection, then reload the page.</p>`);
    return;
  }
  await showShopsAndLastShop();
}

async function showShopsAndLastShop() {
  state.screen = 'shops';
  await refreshShops();
  const last = lsGet('menucost_last_shop');
  if (last && state.shops.some(s => s.id === last)) await openShop(last);
}

// Shows a toast, or the sign-in screen when the sign-in has expired.
function showError(err) {
  if (err.auth) showLogin(err.message);
  else toast(err.message);
}

async function refreshShops() {
  try {
    state.shops = await store.listShops();
  } catch (err) {
    if (err.auth) { showLogin(); return; }
    toast(err.message);
  }
  render();
}

/* ---------- sign-in ---------- */

let unlockTimer = null;

function showLogin(message = '') {
  closeModal();
  clearTimeout(unlockTimer);
  state.screen = 'login';
  state.loginError = message;
  state.loginLocked = false;
  render();
}

async function signIn(password) {
  try {
    await store.login(password);
  } catch (err) {
    state.loginLocked = err.status === 429;
    state.loginError = err.message;
    render();
    if (state.loginLocked) {
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => { state.loginLocked = false; state.loginError = ''; render(); }, (err.retryAfter || 900) * 1000);
    } else {
      const input = $('#login-password');
      input.value = password;
      input.focus();
      input.select();
    }
    return;
  }
  state.loginError = '';
  if (state.data && state.shopId) {
    // Signed out in the middle of editing: go back to the shop and save what is pending.
    state.screen = 'app';
    render();
    if (state.saveState === 'error' || state.saveState === 'dirty') { state.saveState = 'dirty'; saveNow(); }
  } else {
    await showShopsAndLastShop();
  }
}

async function signOut() {
  if (state.saveState === 'dirty' || state.saveState === 'saving') await saveNow();
  try { await store.logout(); } catch { /* cookie is cleared server-side; ignore network errors */ }
  state.shops = [];
  state.shopId = null;
  state.data = null;
  state.meta = null;
  showLogin();
}

async function createShop(name, currency) {
  const data = emptyShop(name, currency);
  const meta = await store.create(data);
  await openShop(meta.id);
}

async function openShop(id) {
  closeModal();
  try {
    const { data, meta } = await store.load(id);
    state.data = normalizeShop(data);
    state.meta = meta;
    state.shopId = id;
    state.saveState = 'saved';
    state.screen = 'app';
    state.search = '';
    lsSet('menucost_last_shop', id);
    render();
  } catch (err) {
    showError(err);
  }
}

async function switchShop() {
  if (state.saveState === 'dirty') await saveNow();
  state.screen = 'shops';
  state.shopId = null;
  state.data = null;
  await refreshShops();
}

function showFatal(html) {
  $('#app').innerHTML = `<div class="center-page"><div class="card pad center-card">${html}</div></div>`;
}

/* ---------- rendering ---------- */

function render() {
  const app = $('#app');
  if (state.screen === 'loading') app.innerHTML = '<div class="center-page muted">Loading…</div>';
  else if (state.screen === 'login') app.innerHTML = renderLogin();
  else if (state.screen === 'shops') app.innerHTML = renderShops();
  else app.innerHTML = renderApp();
  bind();
}

function renderLogin() {
  const bad = state.loginError && !state.loginLocked;
  return `<div class="center-page"><div class="card pad center-card">
    <h1>Menu Cost</h1>
    <p class="muted" style="margin:0">Enter the family password.</p>
    <form id="login-form">
      <label class="field"><span>Password</span>
        <input type="password" name="password" id="login-password" autocomplete="current-password" required
          class="${bad ? 'error' : ''}" ${state.loginLocked ? 'disabled' : ''}></label>
      <label class="check"><input type="checkbox" id="login-show"> Show password</label>
      ${state.loginError ? `<p class="login-msg ${state.loginLocked ? 'warn' : 'bad'}">${esc(state.loginError)}</p>` : ''}
      <button class="btn primary" type="submit" ${state.loginLocked ? 'disabled' : ''}>Sign in</button>
    </form>
  </div></div>`;
}

function signedInLine() {
  return `<div class="signed-in"><p class="muted" style="margin:0">Signed in on this device</p>
    <button class="btn link" data-action="sign-out">Sign out</button></div>`;
}

function renderShops() {
  const list = state.shops.length
    ? `<ul class="shop-list">${state.shops.map(s => `
        <li data-action="open-shop" data-id="${esc(s.id)}">
          <div class="grow"><b>${esc(s.name)}</b>
            <div class="muted" style="font-size:.82rem">Last change ${esc(fmtTime(s.modifiedTime))}</div></div>
          <span class="muted">›</span>
        </li>`).join('')}</ul>`
    : `<p class="muted">No shops yet. Create your first one below.</p>`;
  return `<div class="center-page"><div class="card pad center-card">
    <h1>Choose a shop</h1>
    ${ONLINE ? signedInLine() : '<p class="muted" style="margin:0">Test mode: data is saved in this browser only.</p>'}
    ${list}
    <hr class="divider">
    <h2 style="margin-bottom:12px">Create new shop</h2>
    <form id="new-shop-form">
      <label class="field"><span>Shop name</span><input type="text" name="name" required maxlength="80" placeholder="e.g. My Café Bangkok"></label>
      <label class="field"><span>Currency</span><select name="currency">
        ${Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
      </select></label>
      <button class="btn primary" type="submit" style="width:100%">Create shop</button>
    </form>
  </div></div>`;
}

function renderSaveStatusText() {
  switch (state.saveState) {
    case 'saving': return 'Saving…';
    case 'dirty': return 'Unsaved changes';
    case 'error': return `Not saved — <button class="btn link" data-action="retry-save">retry</button>`;
    default: {
      const who = state.meta?.by ? ` by ${esc(state.meta.by)}` : '';
      return `Saved ✓<span class="wide-only">${who} ${esc(fmtTime(state.meta?.modifiedTime))}</span>`;
    }
  }
}
function renderSaveStatus() {
  const el = $('.save-status');
  if (!el) return;
  el.className = 'save-status' + (state.saveState === 'error' ? ' error' : '');
  el.innerHTML = renderSaveStatusText();
  el.title = state.saveState === 'error' ? state.saveError : '';
}

const TABS = [['menus', 'Menus'], ['ingredients', 'Ingredients'], ['extras', 'Extra costs', 'Extras'], ['settings', 'Settings']];

function renderApp() {
  const body = {
    menus: renderMenus, ingredients: renderIngredients, extras: renderExtras, settings: renderSettings,
  }[state.tab]?.() ?? renderMenus();
  return `
    <header class="topbar"><div class="wrap">
      <span class="brand">☕<span class="wide-only"> Menu Cost</span></span>
      <span class="shop-name" title="${esc(state.data.shopName)}">${esc(state.data.shopName)}</span>
      <button class="btn small switch-btn" data-action="switch-shop">Switch<span class="wide-only"> shop</span></button>
      <span class="spacer"></span>
      <span class="save-status">${renderSaveStatusText()}</span>
    </div>
    <div class="wrap"><nav class="tabs">
      ${TABS.map(([k, v, short]) => `<button class="tab ${state.tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}">${short
        ? `<span class="wide-only">${v}</span><span class="phone-only">${short}</span>` : v}</button>`).join('')}
    </nav></div></header>
    <main><div class="wrap">${body}</div></main>`;
}

function matches(text) {
  return !state.search || text.toLowerCase().includes(state.search.toLowerCase());
}

function searchBox(placeholder) {
  return `<input type="search" id="search" placeholder="${esc(placeholder)}" value="${esc(state.search)}">`;
}

function exampleEmptyState(title, text, addAction, addLabel, extraButtons = '') {
  return `<div class="card empty">
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    <div class="toolbar">
      <button class="btn primary" data-action="${addAction}">${esc(addLabel)}</button>
      <button class="btn" data-action="load-examples">Load example data</button>
      ${extraButtons}
    </div>
  </div>`;
}

/* Menus tab */

function renderMenus() {
  const d = state.data;
  if (!d.menus.length) {
    if (!d.ingredients.length) {
      return exampleEmptyState('No menus yet', 'Start by adding your ingredients, then build each menu from them. Or load example data to try it first.', 'go-ingredients', 'Add ingredients first');
    }
    return exampleEmptyState('No menus yet', 'Add your first menu item and choose how much of each ingredient one plate uses.', 'add-menu', '+ Add menu');
  }
  const menus = [...d.menus].sort(byName).filter(m => matches(m.name + ' ' + (m.category || '')));
  const calcs = d.menus.map(calcMenu).filter(c => c.status !== 'none');
  const avg = calcs.length ? calcs.reduce((s, c) => s + c.foodCostPct, 0) / calcs.length : NaN;
  const high = calcs.filter(c => c.status !== 'ok').length;
  return `
    <div class="stats">
      <div class="card stat"><div class="label">Menus</div><div class="value">${d.menus.length}</div></div>
      <div class="card stat"><div class="label">Average food cost</div><div class="value">${pct(avg)}</div></div>
      <div class="card stat"><div class="label">Target food cost</div><div class="value">${d.targetCostPct}%</div></div>
      <div class="card stat"><div class="label">Above target</div><div class="value" style="color:${high ? 'var(--bad)' : 'var(--ok)'}">${high}</div></div>
    </div>
    <div class="toolbar">
      ${searchBox('Search menus…')}
      <button class="btn primary" data-action="add-menu">+ Add menu</button>
      <button class="btn" data-action="export-menus">Export CSV</button>
    </div>
    <div class="card table-wrap"><table class="rtable menus-table">
      <thead><tr><th>Menu</th><th class="num">Cost / plate</th><th class="num">Extras</th><th class="num">Sell price</th><th>Food cost</th><th class="num">Profit / plate</th><th class="num">Suggested price</th></tr></thead>
      <tbody>${menus.map(m => {
        const c = calcMenu(m);
        return `<tr class="clickable" data-action="edit-menu" data-id="${esc(m.id)}">
          <td class="c-name"><b>${esc(m.name)}</b>${m.category ? `<span class="tag">${esc(m.category)}</span>` : ''}${m.example ? '<span class="tag">example</span>' : ''}${c.problems ? '<span class="pill bad check-pill">check</span>' : ''}</td>
          <td class="num c-cost" data-label="Cost">${money(c.ingredientCost)}</td>
          <td class="num muted c-extras" data-label="Extras">${c.extrasCost ? money(c.extrasCost) : '—'}</td>
          <td class="num c-sell" data-label="Sell">${money(num(m.sellPrice))}</td>
          <td class="c-pill">${statusPill(c)}</td>
          <td class="num c-profit" data-label="Profit" style="${c.profit < 0 ? 'color:var(--bad)' : ''}">${money(c.profit)}</td>
          <td class="num muted c-suggested" data-label="Suggested">${money(c.suggestedPrice)}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="7" class="muted no-match">No menus match "${esc(state.search)}".</td></tr>`}</tbody>
    </table></div>
    <p class="muted" style="font-size:.85rem">Food cost = ingredients ÷ sell price. Profit = sell price − ingredients − extra costs. Suggested price hits your ${d.targetCostPct}% target.</p>`;
}

/* Ingredients tab */

function renderIngredients() {
  const d = state.data;
  const tools = `
      <button class="btn wide-only" data-action="import-csv">Import CSV</button>
      <button class="btn wide-only" data-action="template-csv">Download CSV template</button>`;
  if (!d.ingredients.length) {
    return exampleEmptyState('No ingredients yet', 'Add what you buy: the price you pay and the pack size. You can also import a CSV file from Excel or Google Sheets.', 'add-ingredient', '+ Add ingredient', tools);
  }
  const list = [...d.ingredients].sort(byName).filter(i => matches(i.name));
  return `
    <div class="toolbar">
      ${searchBox('Search ingredients…')}
      <button class="btn primary" data-action="add-ingredient">+ Add ingredient</button>
      ${tools}
      <button class="btn wide-only" data-action="export-ingredients">Export CSV</button>
      <button class="btn phone-only" data-action="csv-menu">CSV ▾</button>
    </div>
    <div class="card table-wrap"><table class="rtable ingredients-table">
      <thead><tr><th>Ingredient</th><th class="num">Buy price</th><th class="num">Pack size</th><th class="num">Cost per unit</th><th class="num">Used in</th></tr></thead>
      <tbody>${list.map(i => {
        const used = menusUsing(i.id).length;
        return `<tr class="clickable" data-action="edit-ingredient" data-id="${esc(i.id)}">
          <td class="c-name"><b>${esc(i.name)}</b>${i.example ? '<span class="tag">example</span>' : ''}</td>
          <td class="num c-buy" data-label="Buy price">${money(i.buyPrice)}</td>
          <td class="num c-pack" data-label="Pack">${fmtNum(i.packSize)} ${esc(i.unit)}</td>
          <td class="num c-unit" data-label="Per unit">${money(costPerPackUnit(i), 4)} / ${esc(i.unit)}</td>
          <td class="num muted c-used">${used ? `<span class="phone-only">Used in </span>${used}${used === 1 ? ' menu' : ' menus'}` : '<span class="wide-only">—</span><span class="phone-only">Not used yet</span>'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="5" class="muted no-match">No ingredients match "${esc(state.search)}".</td></tr>`}</tbody>
    </table></div>`;
}

/* Extras tab */

function renderExtras() {
  const d = state.data;
  const intro = `<p class="muted">Extra costs like staff wages, gas, electric or rent. They are added to every menu (you can turn them off for one menu in its editor).
    Use <b>% of sell price</b> for costs that grow with sales, or <b>fixed per plate</b> for a set amount.</p>`;
  if (!d.extras.length) {
    return intro + `<div class="card empty"><h3>No extra costs yet</h3><p>Without extras, profit only takes away ingredients and packaging.</p>
      <div class="toolbar"><button class="btn primary" data-action="add-extra">+ Add extra cost</button></div></div>`;
  }
  return intro + `
    <div class="toolbar"><button class="btn primary" data-action="add-extra">+ Add extra cost</button></div>
    <div class="card table-wrap"><table class="rtable extras-table">
      <thead><tr><th>Name</th><th>Type</th><th class="num">Amount</th></tr></thead>
      <tbody>${d.extras.map(e => `<tr class="clickable" data-action="edit-extra" data-id="${esc(e.id)}">
        <td class="c-name"><b>${esc(e.name)}</b>${e.example ? '<span class="tag">example</span>' : ''}</td>
        <td class="c-type">${e.type === 'percent' ? '% of sell price' : 'Fixed per plate'}</td>
        <td class="num c-amount">${e.type === 'percent' ? fmtNum(e.value) + '%' : money(e.value)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

/* Settings tab */

function renderSettings() {
  const d = state.data;
  return `<div class="card pad" style="max-width:560px">
    <form id="settings-form">
      <label class="field"><span>Shop name</span><input type="text" name="shopName" value="${esc(d.shopName)}" maxlength="80" required></label>
      <label class="field"><span>Currency</span><select name="currency">
        ${Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}" ${d.currency === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select></label>
      <p class="hint">Changing currency only changes the symbol. Prices are not converted.</p>
      <label class="field"><span>Target food cost %</span><input type="number" name="targetCostPct" value="${d.targetCostPct}" min="1" max="100" step="0.5" required></label>
      <p class="hint">Cafés often aim for 25–35%. Menus above this show as “High”.</p>
      <button class="btn primary" type="submit">Save settings</button>
    </form>
    <hr class="divider">
    <h3 style="margin-bottom:8px">Example data</h3>
    <div class="toolbar">
      <button class="btn" data-action="load-examples">Load example data</button>
      <button class="btn danger" data-action="clear-examples" ${hasExampleData() ? '' : 'disabled'}>Clear example data</button>
    </div>
    <hr class="divider">
    <h3 style="margin-bottom:8px">Backup</h3>
    <p class="muted" style="margin-top:0">${ONLINE
      ? 'Saved automatically in your Cloudflare database. To let family use the app, send them the link and the family password.'
      : 'Test mode: saved in this browser only. Download a backup file to keep a copy.'}</p>
    <div class="toolbar"><button class="btn" data-action="download-backup">Download backup (.json)</button></div>
    ${ONLINE ? `<hr class="divider">${signedInLine()}` : ''}
  </div>`;
}

/* ---------- modals ---------- */

function openModal({ title, body, buttons = [], wide = false, onOpen }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn link" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${buttons.length ? `<div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.className || ''}" data-btn="${i}" ${b.submit ? 'type="submit"' : ''}>${esc(b.label)}</button>`).join('')}</div>` : ''}
  </div></div>`;
  const modal = $('.modal', root);
  document.body.classList.add('modal-open');
  $('[data-close]', root).onclick = closeModal;
  $('.modal-backdrop', root).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
  buttons.forEach((b, i) => {
    $(`[data-btn="${i}"]`, root).onclick = async () => {
      const keepOpen = await b.onClick?.(modal);
      if (keepOpen !== true) closeModal();
    };
  });
  onOpen?.(modal);
  // On touch screens, focusing would pop up the keyboard and hide the form.
  const first = $('input, select', modal);
  if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  return modal;
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  document.body.classList.remove('modal-open');
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal();
});

function confirmModal(title, text, label, onYes) {
  openModal({
    title,
    body: `<p>${text}</p>`,
    buttons: [{ label: 'Cancel' }, { label, className: 'primary', onClick: onYes }],
  });
}

function unitOptions(selected, base) {
  return Object.keys(UNITS)
    .filter(u => !base || UNITS[u].base === base)
    .map(u => `<option value="${u}" ${u === selected ? 'selected' : ''}>${u}</option>`).join('');
}

function ingredientModal(ing) {
  const isNew = !ing;
  ing = ing || { name: '', buyPrice: '', packSize: '', unit: 'g' };
  const used = isNew ? [] : menusUsing(ing.id);
  const lockBase = used.length ? UNITS[ing.unit].base : null;
  openModal({
    title: isNew ? 'Add ingredient' : 'Edit ingredient',
    body: `<form id="ing-form">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(ing.name)}" maxlength="80" required></label>
      <div class="row">
        <label class="field"><span>Buy price (${esc(state.data.currency)})</span><input type="number" name="buyPrice" value="${esc(ing.buyPrice)}" min="0" step="any" required></label>
        <label class="field"><span>Pack size</span><input type="number" name="packSize" value="${esc(ing.packSize)}" min="0" step="any" required></label>
        <label class="field"><span>Unit</span><select name="unit">${unitOptions(ing.unit, lockBase)}</select></label>
      </div>
      <p class="hint">Example: a 2 l bottle of milk for 95 → price 95, pack size 2, unit l.</p>
      <p class="muted" id="ing-preview"></p>
      ${used.length ? `<p class="muted" style="font-size:.85rem">Used in: ${used.map(m => esc(m.name)).join(', ')}</p>` : ''}
      <p class="error-text" id="ing-error"></p>
    </form>`,
    buttons: [
      ...(isNew ? [] : [{ label: 'Delete', className: 'danger left', onClick: () => {
        if (used.length) { $('#ing-error').textContent = `Can't delete: used in ${used.length} menu(s). Remove it from those menus first.`; return true; }
        mutate(d => { d.ingredients = d.ingredients.filter(i => i.id !== ing.id); });
      } }]),
      { label: 'Cancel' },
      { label: 'Save', className: 'primary', onClick: () => {
        const f = $('#ing-form');
        if (!f.reportValidity()) return true;
        const v = Object.fromEntries(new FormData(f));
        const name = v.name.trim();
        const buyPrice = num(v.buyPrice), packSize = num(v.packSize);
        if (!(packSize > 0)) { $('#ing-error').textContent = 'Pack size must be more than 0.'; return true; }
        if (state.data.ingredients.some(i => i.id !== ing.id && i.name.toLowerCase() === name.toLowerCase())) {
          $('#ing-error').textContent = 'An ingredient with this name already exists.'; return true;
        }
        mutate(d => {
          if (isNew) d.ingredients.push({ id: uid('ing'), name, buyPrice, packSize, unit: v.unit });
          else {
            const target = d.ingredients.find(i => i.id === ing.id);
            Object.assign(target, { name, buyPrice, packSize, unit: v.unit });
            delete target.example;
          }
        });
      } },
    ],
    onOpen: modal => {
      const f = $('#ing-form', modal);
      const update = () => {
        const v = Object.fromEntries(new FormData(f));
        const c = num(v.buyPrice) / num(v.packSize);
        $('#ing-preview', modal).textContent = Number.isFinite(c) && num(v.packSize) > 0 ? `= ${money(c, 4)} per ${v.unit}` : '';
      };
      f.addEventListener('input', update);
      f.addEventListener('submit', e => { e.preventDefault(); $('.modal-foot .primary').click(); });
      update();
    },
  });
}

function extraModal(ex) {
  const isNew = !ex;
  ex = ex || { name: '', type: 'percent', value: '' };
  openModal({
    title: isNew ? 'Add extra cost' : 'Edit extra cost',
    body: `<form id="extra-form">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(ex.name)}" maxlength="60" placeholder="e.g. Staff wages, Rent, Gas" required></label>
      <div class="row">
        <label class="field"><span>Type</span><select name="type">
          <option value="percent" ${ex.type === 'percent' ? 'selected' : ''}>% of sell price</option>
          <option value="fixed" ${ex.type === 'fixed' ? 'selected' : ''}>Fixed per plate (${esc(state.data.currency)})</option>
        </select></label>
        <label class="field"><span>Amount</span><input type="number" name="value" value="${esc(ex.value)}" min="0" step="any" required></label>
      </div>
      <p class="hint">Tip: monthly wages ÷ monthly sales = % of sell price. Monthly gas ÷ plates sold = fixed per plate.</p>
    </form>`,
    buttons: [
      ...(isNew ? [] : [{ label: 'Delete', className: 'danger left', onClick: () => mutate(d => { d.extras = d.extras.filter(e => e.id !== ex.id); }) }]),
      { label: 'Cancel' },
      { label: 'Save', className: 'primary', onClick: () => {
        const f = $('#extra-form');
        if (!f.reportValidity()) return true;
        const v = Object.fromEntries(new FormData(f));
        mutate(d => {
          const fields = { name: v.name.trim(), type: v.type, value: num(v.value) };
          if (isNew) d.extras.push({ id: uid('ex'), ...fields });
          else {
            const target = d.extras.find(e => e.id === ex.id);
            Object.assign(target, fields);
            delete target.example;
          }
        });
      } },
    ],
    onOpen: modal => $('#extra-form', modal).addEventListener('submit', e => { e.preventDefault(); $('.modal-foot .primary').click(); }),
  });
}

function menuModal(menu) {
  const d = state.data;
  if (!d.ingredients.length) {
    confirmModal('Add ingredients first', 'A menu is built from your ingredients. Add some ingredients first.', 'Go to ingredients', () => setTab('ingredients'));
    return;
  }
  const isNew = !menu;
  // Edit a copy so Cancel throws changes away.
  const draft = structuredClone(menu || { id: uid('menu'), name: '', category: '', sellPrice: '', yield: 1, useExtras: true, items: [] });
  if (!draft.items.length) draft.items.push({ ingredientId: '', qty: '', unit: 'g' });
  const ingredients = [...d.ingredients].sort(byName);
  const categories = [...new Set(d.menus.map(m => m.category).filter(Boolean))].sort();
  let readForm = () => {};

  const lineRow = (line, idx) => {
    const ing = findIngredient(line.ingredientId);
    const base = ing ? UNITS[ing.unit].base : null;
    return `<tr data-idx="${idx}">
      <td class="ing"><select data-field="ingredientId">
        <option value="">Choose…</option>
        ${ingredients.map(i => `<option value="${esc(i.id)}" ${i.id === line.ingredientId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
      </select></td>
      <td class="qty"><input type="number" data-field="qty" value="${esc(line.qty)}" min="0" step="any" placeholder="0"></td>
      <td class="unit"><select data-field="unit">${unitOptions(line.unit, base)}</select></td>
      <td class="num line-cost">${money(recipeLineCost(line))}</td>
      <td class="rm"><button class="btn link" type="button" data-remove="${idx}" aria-label="Remove">✕</button></td>
    </tr>`;
  };

  const summaryHTML = () => {
    const c = calcMenu(draft);
    const portions = c.portions > 1 ? `<dt>Whole batch (${c.portions} portions)</dt><dd>${money(c.batchCost)}</dd>` : '';
    return `<dl>
      ${portions}
      <dt>Ingredients per plate</dt><dd>${money(c.ingredientCost)}</dd>
      ${c.extrasLines.map(l => `<dt>${esc(l.name)}${l.ex.type === 'percent' ? ` (${fmtNum(l.ex.value)}%)` : ''}</dt><dd>${money(l.amount)}</dd>`).join('')}
      <dt class="total">Total cost per plate</dt><dd class="total">${money(c.totalCost)}</dd>
      <hr>
      <dt>Sell price</dt><dd>${money(num(draft.sellPrice))}</dd>
      <dt>Food cost %</dt><dd>${statusPill(c)}</dd>
      <dt class="total">Profit per plate</dt><dd class="total" style="${c.profit < 0 ? 'color:var(--bad)' : ''}">${money(c.profit)}</dd>
      <dt>Suggested price at ${d.targetCostPct}%</dt><dd>${money(c.suggestedPrice)}</dd>
    </dl>
    ${c.problems ? `<p class="error-text" style="margin:8px 0 0">${c.problems} ingredient line(s) are incomplete and not counted.</p>` : ''}`;
  };

  openModal({
    title: isNew ? 'Add menu' : 'Edit menu',
    wide: true,
    body: `<form id="menu-form">
      <div class="row">
        <label class="field" style="flex:2"><span>Menu name</span><input type="text" name="name" value="${esc(draft.name)}" maxlength="80" required></label>
        <label class="field"><span>Category (optional)</span><input type="text" name="category" value="${esc(draft.category || '')}" list="cat-list" maxlength="40"></label>
      </div>
      <datalist id="cat-list">${categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="row">
        <label class="field"><span>Sell price (${esc(d.currency)})</span><input type="number" name="sellPrice" value="${esc(draft.sellPrice)}" min="0" step="any" required></label>
        <label class="field"><span>Recipe makes (portions)</span><input type="number" name="yield" value="${esc(draft.yield)}" min="1" step="1" required></label>
      </div>
      <p class="hint">Most drinks make 1. For a cake cut into 12 slices, enter the whole cake's ingredients and 12 portions.</p>
      <h3 style="margin:6px 0 8px">Ingredients used</h3>
      <div class="table-wrap"><table class="recipe-table">
        <thead><tr><th>Ingredient</th><th>Amount</th><th>Unit</th><th class="num">Cost</th><th></th></tr></thead>
        <tbody id="lines"></tbody>
      </table></div>
      <button class="btn small" type="button" id="add-line" style="margin-top:8px">+ Add ingredient</button>
      ${d.extras.length ? `<label class="check"><input type="checkbox" name="useExtras" ${draft.useExtras !== false ? 'checked' : ''}> Include extra costs (${d.extras.map(e => esc(e.name)).join(', ')})</label>` : ''}
      <div class="summary" id="summary"></div>
      <p class="error-text" id="menu-error"></p>
    </form>`,
    buttons: [
      ...(isNew ? [] : [{ label: 'Delete menu', className: 'danger left', onClick: () => {
        confirmModal('Delete menu?', `Delete <b>${esc(menu.name)}</b>? This cannot be undone.`, 'Delete', () => mutate(dd => { dd.menus = dd.menus.filter(m => m.id !== menu.id); }));
        return true;
      } }]),
      ...(isNew ? [] : [{ label: 'Duplicate', onClick: () => {
        const copy = structuredClone(menu);
        copy.id = uid('menu'); copy.name = menu.name + ' (copy)'; delete copy.example;
        mutate(dd => dd.menus.push(copy));
        setTimeout(() => menuModal(state.data.menus.find(m => m.id === copy.id)), 0);
      } }]),
      { label: 'Cancel' },
      { label: 'Save', className: 'primary', onClick: () => {
        const f = $('#menu-form');
        if (!f.reportValidity()) return true;
        readForm();
        draft.name = draft.name.trim();
        if (d.menus.some(m => m.id !== draft.id && m.name.toLowerCase() === draft.name.toLowerCase())) {
          $('#menu-error').textContent = 'A menu with this name already exists.'; return true;
        }
        draft.items = draft.items.filter(l => l.ingredientId && num(l.qty) > 0);
        draft.items.forEach(l => { l.qty = num(l.qty); });
        draft.sellPrice = num(draft.sellPrice);
        delete draft.example;
        mutate(dd => {
          const i = dd.menus.findIndex(m => m.id === draft.id);
          if (i >= 0) dd.menus[i] = draft; else dd.menus.push(draft);
        });
      } },
    ],
    onOpen: modal => {
      const f = $('#menu-form', modal);
      const linesEl = $('#lines', modal);
      const drawLines = () => { linesEl.innerHTML = draft.items.map(lineRow).join(''); };
      const drawSummary = () => {
        $('#summary', modal).innerHTML = summaryHTML();
        $$('#lines tr', modal).forEach(tr => {
          $('.line-cost', tr).textContent = money(recipeLineCost(draft.items[+tr.dataset.idx]));
        });
      };
      readForm = () => {
        draft.name = f.name.value;
        draft.category = f.category.value.trim();
        draft.sellPrice = f.sellPrice.value;
        draft.yield = Math.max(1, Math.round(num(f.yield.value)) || 1);
        if (f.useExtras) draft.useExtras = f.useExtras.checked;
      };
      f.addEventListener('input', e => {
        const tr = e.target.closest('tr[data-idx]');
        if (tr) {
          const line = draft.items[+tr.dataset.idx];
          const field = e.target.dataset.field;
          line[field] = e.target.value;
          if (field === 'ingredientId') {
            // Switch the unit to one that fits the chosen ingredient.
            const ing = findIngredient(line.ingredientId);
            if (ing && UNITS[line.unit].base !== UNITS[ing.unit].base) line.unit = UNITS[ing.unit].base;
            drawLines();
          }
        } else readForm();
        drawSummary();
      });
      f.addEventListener('change', e => { if (e.target.name === 'useExtras') { readForm(); drawSummary(); } });
      f.addEventListener('submit', e => { e.preventDefault(); $('.modal-foot .primary').click(); });
      linesEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-remove]');
        if (!btn) return;
        draft.items.splice(+btn.dataset.remove, 1);
        if (!draft.items.length) draft.items.push({ ingredientId: '', qty: '', unit: 'g' });
        drawLines(); drawSummary();
      });
      $('#add-line', modal).onclick = () => {
        draft.items.push({ ingredientId: '', qty: '', unit: 'g' });
        drawLines(); drawSummary();
        $(`#lines tr:last-child select`, modal).focus();
      };
      drawLines(); drawSummary();
    },
  });
}

function importModal() {
  openModal({
    title: 'Import ingredients from CSV',
    body: `<p>Columns needed (first row): <code>${CSV_HEADER.join(',')}</code></p>
      <p class="hint" style="margin:0 0 12px">Units: ${Object.keys(UNITS).join(', ')}. If an ingredient name already exists, its price and pack size are updated.</p>
      <input type="file" id="csv-file" accept=".csv,text/csv">
      <div id="import-preview" style="margin-top:14px"></div>`,
    buttons: [
      { label: 'Cancel' },
      { label: 'Import', className: 'primary', onClick: modal => {
        const plan = modal._plan;
        if (!plan || !(plan.adds.length + plan.updates.length)) return true;
        mutate(() => applyImport(plan));
        toast(`Imported: ${plan.adds.length} new, ${plan.updates.length} updated`);
      } },
    ],
    onOpen: modal => {
      const importBtn = $('.modal-foot .primary', modal);
      importBtn.disabled = true;
      $('#csv-file', modal).addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const plan = planImport(await file.text());
        modal._plan = plan;
        importBtn.disabled = !(plan.adds.length + plan.updates.length);
        $('#import-preview', modal).innerHTML = `
          <p><b>${plan.adds.length}</b> new · <b>${plan.updates.length}</b> updated · <b>${plan.errors.length}</b> problem(s)</p>
          ${plan.errors.length ? `<ul class="error-text">${plan.errors.slice(0, 20).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
            ${plan.errors.length > 20 ? `<p class="muted">…and ${plan.errors.length - 20} more</p>` : ''}
            <p class="muted">Rows with problems are skipped.</p>` : ''}`;
      });
    },
  });
}

/* ---------- events ---------- */

function setTab(tab) {
  state.tab = tab;
  state.search = '';
  lsSet('menucost_tab', tab);
  render();
}

const ACTIONS = {
  'open-shop': el => openShop(el.dataset.id),
  'switch-shop': switchShop,
  'sign-out': signOut,
  'tab': el => setTab(el.dataset.tab),
  'retry-save': () => { state.saveState = 'dirty'; saveNow(); },
  'go-ingredients': () => setTab('ingredients'),
  'add-menu': () => menuModal(null),
  'edit-menu': el => menuModal(state.data.menus.find(m => m.id === el.dataset.id)),
  'add-ingredient': () => ingredientModal(null),
  'edit-ingredient': el => ingredientModal(state.data.ingredients.find(i => i.id === el.dataset.id)),
  'add-extra': () => extraModal(null),
  'edit-extra': el => extraModal(state.data.extras.find(e => e.id === el.dataset.id)),
  'import-csv': importModal,
  'csv-menu': () => openModal({
    title: 'CSV',
    body: `<div class="sheet-actions">
      <button class="btn" data-sheet="import-csv">Import CSV</button>
      <button class="btn" data-sheet="template-csv">Download CSV template</button>
      <button class="btn" data-sheet="export-ingredients">Export CSV</button>
    </div>`,
    onOpen: modal => $$('[data-sheet]', modal).forEach(b => {
      b.onclick = () => { closeModal(); ACTIONS[b.dataset.sheet](); };
    }),
  }),
  'template-csv': () => download('ingredients-template.csv', templateCSV()),
  'export-ingredients': () => download(`${state.data.shopName} - ingredients.csv`, ingredientsCSV()),
  'export-menus': () => download(`${state.data.shopName} - menu costs.csv`, menusCSV()),
  'download-backup': () => download(`${state.data.shopName} - backup.json`, JSON.stringify(state.data, null, 2), 'application/json'),
  'load-examples': () => confirmModal('Load example data?',
    `Adds sample ${esc(state.data.currency)} ingredients, menus and extra costs, marked “example”. You can remove them any time in Settings → Clear example data.`,
    'Load examples', () => { mutate(loadExampleData); toast('Example data loaded'); }),
  'clear-examples': () => confirmModal('Clear example data?',
    'Removes all items marked “example”. Example ingredients still used by your own menus are kept.',
    'Clear', () => { mutate(clearExampleData); toast('Example data cleared'); }),
};

function bind() {
  const app = $('#app');
  app.onclick = e => {
    const el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
  };
  const search = $('#search');
  if (search) {
    search.oninput = () => {
      state.search = search.value;
      const pos = search.selectionStart;
      render();
      const s = $('#search');
      s.focus(); s.setSelectionRange(pos, pos);
    };
  }
  const login = $('#login-form');
  if (login) {
    const input = $('#login-password');
    if (!state.loginLocked) input.focus();
    $('#login-show').onchange = e => { input.type = e.target.checked ? 'text' : 'password'; };
    login.onsubmit = async e => {
      e.preventDefault();
      if (!input.value) return;
      $('button[type=submit]', login).disabled = true;
      await signIn(input.value);
    };
  }
  const newShop = $('#new-shop-form');
  if (newShop) {
    newShop.onsubmit = async e => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(newShop));
      const name = v.name.trim();
      if (!name) return;
      if (state.shops.some(s => s.name.toLowerCase() === name.toLowerCase())) {
        toast('A shop with this name already exists.'); return;
      }
      $('button[type=submit]', newShop).disabled = true;
      try { await createShop(name, v.currency); }
      catch (err) { showError(err); const b = $('button[type=submit]', newShop); if (b) b.disabled = false; }
    };
  }
  const settings = $('#settings-form');
  if (settings) {
    settings.onsubmit = e => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(settings));
      const target = num(v.targetCostPct);
      if (!(target > 0 && target <= 100)) { toast('Target must be between 1 and 100.'); return; }
      mutate(d => { d.shopName = v.shopName.trim() || d.shopName; d.currency = v.currency; d.targetCostPct = target; });
      toast('Settings saved');
    };
  }
}

start();
