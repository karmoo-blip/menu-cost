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
// Built-in units plus the shop's own measurements, e.g. { name: 'shot', amount: 30, unit: 'ml' }.
function unitInfo(name) {
  if (UNITS[name]) return UNITS[name];
  const m = state.data?.measures?.find(x => x.name === name);
  return m && UNITS[m.unit] ? { base: UNITS[m.unit].base, factor: m.amount * UNITS[m.unit].factor, measure: m } : undefined;
}
function unitNames() {
  return [...Object.keys(UNITS), ...(state.data?.measures || []).map(m => m.name)];
}
// Units for "size of each" / a measurement: weight or volume, not pieces.
const SIZE_BASE_UNITS = Object.keys(UNITS).filter(u => UNITS[u].base !== 'pcs');

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
// kind: '' (plain), 'ok' (green tick) or 'bad' (red warning)
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.setAttribute('role', 'status');
  el.textContent = (kind === 'ok' ? '✓ ' : kind === 'bad' ? '⚠️ ' : '') + msg;
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
    targetCostPct: 30,
    laborPct: 45,
    ingredients: [],
    menus: [],
    extras: [],
    measures: [],
  };
}

function normalizeShop(d) {
  d.version = d.version || DATA_VERSION;
  d.ingredients = d.ingredients || [];
  d.menus = d.menus || [];
  d.extras = d.extras || [];
  d.measures = (d.measures || []).filter(m => m && m.name && UNITS[m.unit] && UNITS[m.unit].base !== 'pcs' && m.amount > 0);
  d.currency = CURRENCIES[d.currency] ? d.currency : 'THB';
  if (!Number.isFinite(d.targetCostPct)) d.targetCostPct = 35;
  if (!Number.isFinite(d.laborPct)) d.laborPct = 45;
  for (const m of d.menus) if (!Array.isArray(m.steps)) m.steps = [];
  tidyMenuExtras(d);
  return d;
}

// Each menu keeps a list of extra cost ids it leaves out, so new extras apply to every menu.
// Turns the old all-or-nothing `useExtras: false` into "leave out every extra", and drops ids of deleted extras.
function tidyMenuExtras(d) {
  const ids = new Set(d.extras.map(e => e.id));
  for (const m of d.menus) {
    if (m.useExtras === false) m.excludedExtras = [...ids];
    delete m.useExtras;
    m.excludedExtras = (m.excludedExtras || []).filter(id => ids.has(id));
  }
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
  const u = unitInfo(ing.unit);
  return u && ing.packSize > 0 ? ing.buyPrice / (ing.packSize * u.factor) : NaN;
}
function recipeLineCost(line) {
  const ing = findIngredient(line.ingredientId);
  const u = unitInfo(line.unit);
  if (!ing || !u || unitInfo(ing.unit)?.base !== u.base) return NaN;
  return num(line.qty) * u.factor * costPerBaseUnit(ing);
}
function menusUsing(ingredientId) {
  return state.data.menus.filter(m => m.items.some(l => l.ingredientId === ingredientId));
}

// tryTargetPct / tryLaborPct: targets to try out instead of the shop's saved ones.
function calcMenu(menu, tryTargetPct, tryLaborPct) {
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
  const hasPrice = Number.isFinite(price) && price > 0;
  const foodCostPct = hasPrice ? ingredientCost / price : NaN;
  // Labor & overhead is an estimate from the shop's target. Any extra costs saved by older versions are not counted.
  const laborPct = tryLaborPct >= 0 ? tryLaborPct : data.laborPct;
  const laborCost = hasPrice ? price * laborPct / 100 : NaN;
  const totalCost = ingredientCost + (hasPrice ? laborCost : 0);
  const profit = hasPrice ? price - totalCost : NaN;
  // Price where estimated profit reaches zero. None exists if labor reaches 100%.
  const breakEvenPrice = laborPct < 100 ? ingredientCost / (1 - laborPct / 100) : NaN;
  const targetPct = tryTargetPct > 0 ? tryTargetPct : data.targetCostPct;
  const target = targetPct / 100;
  // Price that makes food cost exactly the target.
  const targetPrice = ingredientCost > 0 ? ingredientCost / target : NaN;
  let status = 'none';
  if (hasPrice && menu.items.length) {
    status = foodCostPct <= target ? 'ok' : foodCostPct <= target + 0.1 ? 'warn' : 'bad';
  }
  return {
    portions, batchCost, ingredientCost, laborPct, laborCost, totalCost,
    foodCostPct,
    totalCostPct: hasPrice ? totalCost / price : NaN,
    profit,
    profitPct: hasPrice ? profit / price : NaN,
    breakEvenPrice,
    targetPct, targetPrice,
    status, problems,
  };
}

function statusPill(c) {
  if (c.status === 'none') return '<span class="muted">—</span>';
  const label = { ok: 'OK', warn: 'High', bad: 'Too high' }[c.status];
  return `<span class="pill ${c.status}">${pct(c.foodCostPct)} · ${label}</span>`;
}

// Food cost bar: fill = food cost %, line = target. The bar runs from 0 to twice the target.
function costMeter(c) {
  if (c.status === 'none') return '';
  const target = c.targetPct / 100;
  const scale = Math.min(target * 2, 1);
  const fill = Math.max(0, Math.min(c.foodCostPct / scale, 1)) * 100;
  const mark = Math.min(target / scale, 1) * 100;
  return `<div class="meter ${c.status}" role="img" aria-label="Food cost ${pct(c.foodCostPct)}, target ${fmtNum(c.targetPct)}%">
    <i style="width:${fill.toFixed(1)}%"></i><span class="meter-target" style="left:${mark.toFixed(1)}%"></span></div>`;
}

// Same pastel colour every time for the same text, e.g. a category name.
const CHIP_TINTS = ['lav', 'sky', 'peach', 'mint', 'butter', 'rose'];
function chipTint(text) {
  let h = 0;
  for (const ch of String(text).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'tint-' + CHIP_TINTS[h % CHIP_TINTS.length];
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
      id: uid('menu'), name, category, sellPrice, yield: 1, example: true,
      items: items
        .filter(([n, , unit]) => unitInfo(ids[n].unit).base === unitInfo(unit).base)
        .map(([n, qty, unit]) => ({ ingredientId: ids[n].id, qty, unit })),
    });
  }
}

function clearExampleData() {
  const d = state.data;
  d.menus = d.menus.filter(m => !m.example);
  d.extras = d.extras.filter(e => !e.example);
  tidyMenuExtras(d);
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
    // Match units ignoring case, e.g. "Shot" → your "shot" measurement.
    const rawUnit = (r[col('unit')] || '').trim().toLowerCase();
    const unit = unitNames().find(u => u.toLowerCase() === rawUnit) || rawUnit;
    if (!name) return result.errors.push(`Row ${line}: name is empty.`);
    if (!(buyPrice >= 0)) return result.errors.push(`Row ${line} (${name}): buy_price is not a number.`);
    if (!(packSize > 0)) return result.errors.push(`Row ${line} (${name}): pack_size must be more than 0.`);
    if (!unitInfo(unit)) return result.errors.push(`Row ${line} (${name}): unit "${unit}" not known. Use ${unitNames().join(', ')}.`);
    const key = name.toLowerCase();
    if (seen.has(key)) return result.errors.push(`Row ${line} (${name}): same name appears twice in the file.`);
    seen.add(key);
    const existing = state.data.ingredients.find(i => i.name.toLowerCase() === key);
    if (existing) {
      if (unitInfo(existing.unit).base !== unitInfo(unit).base && menusUsing(existing.id).length) {
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

/* ---------- recipe cards (print / Save as PDF) ---------- */

// Drops empty steps and trims text before saving or printing.
function cleanSteps(steps) {
  return (steps || [])
    .map(s => ({ text: (s.text || '').trim(), ...(s.photo ? { photo: s.photo } : {}) }))
    .filter(s => s.text || s.photo);
}

function recipeCardHTML(menu) {
  const d = state.data;
  const portions = menu.yield > 1 ? menu.yield : 1;
  const lines = (menu.items || [])
    .map(l => ({ ing: findIngredient(l.ingredientId), qty: num(l.qty), unit: l.unit }))
    .filter(l => l.ing && l.qty > 0);
  const steps = menu.steps || [];
  return `<article class="recipe-card">
    <div class="rc-shop">${esc(d.shopName)}</div>
    <h1>${esc(menu.name)}</h1>
    <div class="rc-meta">${menu.category ? esc(menu.category) + ' · ' : ''}Makes ${portions} ${portions === 1 ? 'portion' : 'portions'}</div>
    <h2>Ingredients</h2>
    ${lines.length ? `<table>${lines.map(l => `<tr><td>${esc(l.ing.name)}</td><td class="rc-amt">${fmtNum(l.qty)} ${esc(l.unit)}</td></tr>`).join('')}</table>`
      : '<p class="rc-empty">No ingredients yet.</p>'}
    <h2>How to make</h2>
    ${steps.length ? `<ol>${steps.map(s => `<li>${esc(s.text)}${s.photo ? `<img src="${esc(photoSrc(s.photo))}" alt="">` : ''}</li>`).join('')}</ol>`
      : '<p class="rc-empty">No steps yet.</p>'}
  </article>`;
}

// Fills a print-only area with the cards, waits for photos, then opens the print screen ("Save as PDF").
async function printRecipeCards(menus) {
  if (!menus.length) { toast('No menus to print.'); return; }
  let root = $('#print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.appendChild(root);
  }
  root.innerHTML = menus.map(recipeCardHTML).join('');
  const imgs = $$('img', root);
  if (imgs.length) {
    toast('Preparing recipe cards…');
    const loaded = Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    await Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]);
  }
  // The page title becomes the suggested PDF file name.
  const oldTitle = document.title;
  document.title = menus.length === 1 ? `${menus[0].name} - recipe card` : `${state.data.shopName} - recipe cards`;
  const done = () => { root.innerHTML = ''; document.title = oldTitle; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

function menusCSV() {
  const rows = [...state.data.menus].sort(byName).map(m => {
    const c = calcMenu(m);
    const r = v => Number.isFinite(v) ? v.toFixed(2) : '';
    return [m.name, m.category || '', r(num(m.sellPrice)), r(c.ingredientCost), r(c.laborCost), r(c.totalCost),
      Number.isFinite(c.foodCostPct) ? (c.foodCostPct * 100).toFixed(1) : '', r(c.profit),
      Number.isFinite(c.profitPct) ? (c.profitPct * 100).toFixed(1) : '', r(c.breakEvenPrice)];
  });
  return toCSV([['menu', 'category', 'sell_price', 'ingredient_cost', 'labor_estimate', 'total_cost', 'food_cost_pct', 'profit', 'profit_pct', 'break_even_price'], ...rows]);
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

/* ---------- step photos ---------- */

// Online: photos go to R2 through the Worker and a step keeps the key.
// Test mode: no R2, so a smaller photo is kept in the step itself as a data: URL.
const PHOTO_MAX_PX = ONLINE ? 1200 : 600;
const PHOTO_QUALITY = ONLINE ? 0.8 : 0.7;

function photoSrc(photo) {
  if (!photo) return '';
  return photo.startsWith('data:') ? photo : `/api/photos/${encodeURIComponent(photo)}`;
}

// Shrinks a photo from the phone or computer to a JPEG no wider/taller than PHOTO_MAX_PX.
async function shrinkPhoto(file) {
  let img;
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('This file is not a photo the browser can open.'));
        el.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }
  const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not read this photo.')), 'image/jpeg', PHOTO_QUALITY));
}

// Returns what to store in the step: an R2 key (online) or a data: URL (test mode).
async function uploadStepPhoto(file) {
  const blob = await shrinkPhoto(file);
  if (!ONLINE) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read this photo.'));
      r.readAsDataURL(blob);
    });
  }
  let res;
  try {
    res = await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
  } catch {
    throw new Error('Upload failed. Check your internet and try again.');
  }
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !body?.key) throw new Error(body?.error || `Upload failed (${res.status}). Try again.`);
  return body.key;
}

/* ---------- app state & saving ---------- */

const state = {
  screen: 'loading',  // loading | login | shops | app
  loginError: '',
  loginLocked: false,
  shops: [],
  shopId: null,
  meta: null,         // { modifiedTime, by }
  data: null,
  tab: lsGet('menucost_tab') || 'home',
  search: '',
  category: '',       // menu category filter on the Menus tab ('' = all)
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
  else toast(err.message, 'bad');
}

async function refreshShops() {
  try {
    state.shops = await store.listShops();
  } catch (err) {
    if (err.auth) { showLogin(); return; }
    toast(err.message, 'bad');
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
    state.category = '';
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
  if (state.screen === 'loading') app.innerHTML = '<div class="center-page"><div class="loading"><span class="hero-logo">☕</span><p class="muted">Loading…</p></div></div>';
  else if (state.screen === 'login') app.innerHTML = renderLogin();
  else if (state.screen === 'shops') app.innerHTML = renderShops();
  else app.innerHTML = renderApp();
  bind();
}

function renderLogin() {
  const bad = state.loginError && !state.loginLocked;
  return `<div class="center-page"><div class="card pad center-card">
    <div class="hero"><span class="hero-logo">☕</span>
      <h1>Menu Cost</h1>
      <p class="muted">Know what every menu really costs. Enter the family password to start.</p></div>
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
          <span class="shop-avatar ${chipTint(s.name)}">${esc([...s.name.trim()][0] || '☕')}</span>
          <div class="grow"><b>${esc(s.name)}</b>
            <div class="muted" style="font-size:.82rem">Last change ${esc(fmtTime(s.modifiedTime))}</div></div>
          <span class="muted">›</span>
        </li>`).join('')}</ul>`
    : `<p class="muted">No shops yet. Create your first one below.</p>`;
  return `<div class="center-page"><div class="card pad center-card">
    <div class="hero"><span class="hero-logo">☕</span><h1>Choose a shop</h1></div>
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
    case 'saving': return '<span class="save-text">Saving…</span>';
    case 'dirty': return '<span class="save-text">Unsaved changes</span>';
    case 'error': return '<span class="save-text">Not saved</span>';
    default: {
      const who = state.meta?.by ? ` by ${esc(state.meta.by)}` : '';
      return `<span class="save-text">Saved<span class="wide-only">${who} ${esc(fmtTime(state.meta?.modifiedTime))}</span></span>`;
    }
  }
}
function renderSaveBanner() {
  if (state.saveState !== 'error') return '';
  return `<div class="save-banner" role="alert"><span>⚠️ Your changes are not saved yet. ${esc(state.saveError || 'Check your internet.')}</span>
    <button class="btn small" data-action="retry-save">Retry</button></div>`;
}
function renderSaveStatus() {
  const el = $('.save-status');
  if (!el) return;
  el.className = `save-status ${state.saveState}`;
  el.innerHTML = '<span class="dot" aria-hidden="true"></span>' + renderSaveStatusText();
  el.title = state.saveState === 'error' ? state.saveError : '';
  const banner = $('#save-banner');
  if (banner) banner.innerHTML = renderSaveBanner();
}

// [key, label, short label for phones, icon]
const TABS = [
  ['home', 'Home', 'Home', '🏠'],
  ['menus', 'Menus', 'Menus', '🥤'],
  ['ingredients', 'Ingredients', 'Ingredients', '🧺'],
  ['settings', 'Settings', 'Settings', '⚙️'],
];

function renderApp() {
  const renderers = {
    home: renderHome, menus: renderMenus, ingredients: renderIngredients, settings: renderSettings,
  };
  const body = (renderers[state.tab] || renderHome)();
  const tab = renderers[state.tab] ? state.tab : 'home';
  const tabButton = ([k, label, short, icon], cls) =>
    `<button class="${cls} ${tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}>
      <span class="tab-ico" aria-hidden="true">${icon}</span><span>${cls === 'tab' ? label : short}</span></button>`;
  return `
    <header class="topbar"><div class="wrap">
      <span class="logo" aria-hidden="true">☕</span>
      <div class="shop-block">
        <span class="shop-name" title="${esc(state.data.shopName)}">${esc(state.data.shopName)}</span>
        <button class="btn link switch-btn" data-action="switch-shop">Switch shop</button>
      </div>
      <nav class="tabs wide-only" aria-label="Sections">${TABS.map(t => tabButton(t, 'tab')).join('')}</nav>
      <span class="save-status ${state.saveState}" title="${state.saveState === 'error' ? esc(state.saveError) : ''}"><span class="dot" aria-hidden="true"></span>${renderSaveStatusText()}</span>
    </div></header>
    <main><div class="wrap">
      <div id="save-banner">${renderSaveBanner()}</div>
      ${body}
    </div></main>
    <nav class="bottom-nav phone-only" aria-label="Sections">${TABS.map(t => tabButton(t, 'bnav')).join('')}</nav>`;
}

function matches(text) {
  return !state.search || text.toLowerCase().includes(state.search.toLowerCase());
}

function searchBox(placeholder) {
  return `<input type="search" id="search" placeholder="${esc(placeholder)}" value="${esc(state.search)}">`;
}

function exampleEmptyState(emoji, title, text, addAction, addLabel, extraButtons = '') {
  return `<div class="card empty">
    <span class="empty-emoji" aria-hidden="true">${emoji}</span>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    <div class="toolbar">
      <button class="btn primary" data-action="${addAction}">${esc(addLabel)}</button>
      <button class="btn" data-action="load-examples">Try with example data</button>
      ${extraButtons}
    </div>
  </div>`;
}

/* Home tab */

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? ['Good morning', '☀️'] : h < 18 ? ['Good afternoon', '🌤️'] : ['Good evening', '🌙'];
}

function renderHome() {
  const d = state.data;
  const [hello, sun] = greeting();
  const head = `<div class="hello"><h1>${hello}, ${esc(d.shopName)} ${sun}</h1>`;

  if (!d.menus.length) {
    const steps = [
      [d.ingredients.length > 0, 'Add ingredients', d.ingredients.length ? `${d.ingredients.length} added` : 'What you buy, its price and pack size', 'add-ingredient', '+ Ingredient'],
      [false, 'Build your first menu', 'Pick ingredients and how much one plate uses', 'add-menu', '+ Menu'],
    ];
    return `${head}<p class="muted">Two small steps and you will see what every menu really costs.</p></div>
      <ol class="onboard">${steps.map(([done, title, sub, action, label], i) => `
        <li class="${done ? 'done' : ''}">
          <span class="onboard-no" aria-hidden="true">${done ? '✓' : i + 1}</span>
          <div class="grow"><b>${title}</b><small>${esc(sub)}</small></div>
          ${done ? '<span class="pill ok">Done</span>' : `<button class="btn small ${i === steps.findIndex(s => !s[0]) ? 'primary' : ''}" data-action="${action}">${label}</button>`}
        </li>`).join('')}</ol>
      <div class="toolbar"><button class="btn" data-action="load-examples">Try with example data</button></div>`;
  }

  const all = d.menus.map(m => ({ m, c: calcMenu(m) }));
  const priced = all.filter(x => x.c.status !== 'none');
  const avg = priced.length ? priced.reduce((s, x) => s + x.c.foodCostPct, 0) / priced.length : NaN;
  const attention = all
    .filter(x => x.c.problems || x.c.status === 'warn' || x.c.status === 'bad')
    .sort((a, b) => (b.c.foodCostPct || 0) - (a.c.foodCostPct || 0));
  const high = priced.filter(x => x.c.status !== 'ok').length;
  const best = all.filter(x => Number.isFinite(x.c.profit)).sort((a, b) => b.c.profit - a.c.profit).slice(0, 3);
  const why = x => x.c.problems ? `${x.c.problems} ingredient line(s) incomplete`
    : x.c.status === 'bad' ? 'Food cost well above target' : 'A little above target';

  return `${head}<p class="muted">${d.menus.length} menu${d.menus.length === 1 ? '' : 's'}${high ? `, ${high} above your ${d.targetCostPct}% food cost target.` : '. All within your food cost target 🎉'}</p></div>
    <div class="stats">
      <div class="stat tint-lav"><span class="stat-ico" aria-hidden="true">🥤</span><div class="label">Menus</div><div class="value">${d.menus.length}</div></div>
      <div class="stat tint-sky"><span class="stat-ico" aria-hidden="true">📊</span><div class="label">Average food cost</div><div class="value">${pct(avg)}</div></div>
      <div class="stat tint-peach"><span class="stat-ico" aria-hidden="true">🎯</span><div class="label">Target food cost</div><div class="value">${d.targetCostPct}%</div></div>
      <div class="stat ${high ? 'tint-rose' : 'tint-mint'}"><span class="stat-ico" aria-hidden="true">${high ? '⚠️' : '✅'}</span><div class="label">Above target</div><div class="value">${high}</div></div>
    </div>
    <div class="home-grid">
      <section class="card pad">
        <h2>👀 Needs attention</h2>
        ${attention.length ? `<ul class="list">${attention.slice(0, 5).map(x => `
          <li data-action="edit-menu" data-id="${esc(x.m.id)}"><div class="grow"><b>${esc(x.m.name)}</b><small>${why(x)}</small></div>
            ${x.c.problems ? '<span class="pill bad">Check</span>' : statusPill(x.c)}</li>`).join('')}</ul>
          ${attention.length > 5 ? `<button class="btn link" data-action="tab" data-tab="menus">See all ${attention.length} on Menus ›</button>` : ''}`
          : '<p class="muted list-empty">Nothing to fix. Every menu is within target 🎉</p>'}
      </section>
      <section class="card pad">
        <h2>🏆 Best earners per plate</h2>
        ${best.length ? `<ul class="list">${best.map((x, i) => `
          <li data-action="edit-menu" data-id="${esc(x.m.id)}"><span class="rank" aria-label="Number ${i + 1}">${i + 1}</span>
            <div class="grow"><b>${esc(x.m.name)}</b><small>${pct(x.c.profitPct)} est. profit</small></div>
            <b class="money ${x.c.profit < 0 ? 'neg' : ''}">${money(x.c.profit)}</b></li>`).join('')}</ul>`
          : '<p class="muted list-empty">Add sell prices to see profit.</p>'}
      </section>
    </div>
    <div class="toolbar">
      <button class="btn primary" data-action="add-menu">+ Add menu</button>
      <button class="btn" data-action="add-ingredient">+ Add ingredient</button>
      <button class="btn" data-action="print-all-cards">📄 All recipe cards</button>
    </div>`;
}

/* Menus tab */

function menuCard(m) {
  const c = calcMenu(m);
  return `<button class="menu-card" data-action="edit-menu" data-id="${esc(m.id)}">
    <div class="mc-top">
      <b class="mc-name">${esc(m.name)}</b>
      <div class="mc-tags">${m.category ? `<span class="chip ${chipTint(m.category)}">${esc(m.category)}</span>` : ''}${m.example ? '<span class="chip">example</span>' : ''}${c.problems ? '<span class="pill bad">Check</span>' : ''}</div>
    </div>
    <div class="mc-meter">${costMeter(c)}${statusPill(c)}</div>
    <div class="mc-nums">
      <div><span>Sell</span><b>${money(num(m.sellPrice))}</b></div>
      <div><span>Cost</span><b>${money(c.ingredientCost)}</b></div>
      <div class="mc-profit ${c.profit < 0 ? 'neg' : ''}"><span>Est. profit</span><b>${money(c.profit)}</b></div>
    </div>
    <div class="mc-foot muted">Break-even ${money(c.breakEvenPrice)}</div>
  </button>`;
}

function renderMenus() {
  const d = state.data;
  if (!d.menus.length) {
    if (!d.ingredients.length) {
      return exampleEmptyState('🧺', 'No menus yet', 'Start by adding your ingredients, then build each menu from them. Or try it first with example data.', 'go-ingredients', 'Add ingredients first');
    }
    return exampleEmptyState('🥤', 'No menus yet', 'Add your first menu item and choose how much of each ingredient one plate uses.', 'add-menu', '+ Add menu');
  }
  const counts = {};
  for (const m of d.menus) if (m.category) counts[m.category] = (counts[m.category] || 0) + 1;
  const cats = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const cat = cats.includes(state.category) ? state.category : '';
  const menus = [...d.menus].sort(byName)
    .filter(m => !cat || m.category === cat)
    .filter(m => matches(m.name + ' ' + (m.category || '')));
  return `
    <div class="toolbar">
      ${searchBox('Search menus…')}
      <button class="btn primary" data-action="add-menu">+ Add menu</button>
      <button class="btn wide-only" data-action="export-menus">Export CSV</button>
      <button class="btn wide-only" data-action="print-all-cards">📄 Recipe cards</button>
      <button class="btn phone-only" data-action="menus-more">More ▾</button>
    </div>
    ${cats.length ? `<div class="filters" role="group" aria-label="Filter by category">
      <button class="filter ${cat ? '' : 'on'}" data-action="category" data-cat="" aria-pressed="${!cat}">All · ${d.menus.length}</button>
      ${cats.map(k => `<button class="filter ${cat === k ? 'on' : ''}" data-action="category" data-cat="${esc(k)}" aria-pressed="${cat === k}">${esc(k)} · ${counts[k]}</button>`).join('')}
    </div>` : ''}
    ${menus.length ? `<div class="menu-grid">${menus.map(menuCard).join('')}</div>`
      : `<div class="card empty"><span class="empty-emoji" aria-hidden="true">🔍</span><p>No menus match${state.search ? ` "${esc(state.search)}"` : ''}${cat ? ` in ${esc(cat)}` : ''}.</p></div>`}
    <p class="footnote muted">The bar shows food cost; the dark line is your ${d.targetCostPct}% target. Food cost = ingredients ÷ sell price. Est. profit = sell price − ingredients − your ${fmtNum(d.laborPct)}% labor &amp; overhead target. Break-even = price where est. profit reaches zero.</p>`;
}

/* Ingredients tab */

function renderIngredients() {
  const d = state.data;
  const tools = `
      <button class="btn wide-only" data-action="import-csv">Import CSV</button>
      <button class="btn wide-only" data-action="template-csv">Download CSV template</button>`;
  if (!d.ingredients.length) {
    return exampleEmptyState('🧺', 'No ingredients yet', 'Add what you buy: the price you pay and the pack size. You can also import a CSV file from Excel or Google Sheets.', 'add-ingredient', '+ Add ingredient', tools);
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
          <td class="c-name"><b>${esc(i.name)}</b>${i.example ? '<span class="chip">example</span>' : ''}</td>
          <td class="num c-buy" data-label="Buy price">${money(i.buyPrice)}</td>
          <td class="num c-pack" data-label="Pack"><span class="unit-pill">${fmtNum(i.packSize)} ${esc(i.unit)}</span></td>
          <td class="num c-unit" data-label="Per unit">${money(costPerPackUnit(i), 4)} / ${esc(i.unit)}</td>
          <td class="num muted c-used">${used ? `<span class="phone-only">Used in </span>${used}${used === 1 ? ' menu' : ' menus'}` : '<span class="wide-only">—</span><span class="phone-only">Not used yet</span>'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="5" class="muted no-match">No ingredients match "${esc(state.search)}".</td></tr>`}</tbody>
    </table></div>`;
}

/* Settings tab */

// Where a measurement is used: menu lines and ingredients bought in it.
function measureUse(name) {
  const d = state.data;
  return {
    menus: d.menus.filter(m => m.items.some(l => l.unit === name)),
    ingredients: d.ingredients.filter(i => i.unit === name),
  };
}

function renderMeasures() {
  const list = state.data.measures;
  const body = list.length
    ? `<ul class="measure-list">${[...list].sort((a, b) => a.name.localeCompare(b.name)).map(m => {
        const u = measureUse(m.name);
        const n = u.menus.length;
        const used = n ? `${n} menu${n === 1 ? '' : 's'}` : u.ingredients.length ? `${u.ingredients.length} ingredient${u.ingredients.length === 1 ? '' : 's'}` : 'Not used';
        const vol = UNITS[m.unit].base === 'ml';
        return `<li data-action="edit-measure" data-name="${esc(m.name)}">
          <span class="m-name">${esc(m.name)}</span>
          <span class="m-eq">= ${fmtNum(m.amount)} ${esc(m.unit)} <span class="chip ${vol ? 'tint-sky' : 'tint-peach'}">${vol ? 'volume' : 'weight'}</span></span>
          <span class="m-used">${used}</span></li>`;
      }).join('')}</ul>`
    : `<div class="measure-empty"><span class="empty-emoji small" aria-hidden="true">🥄</span>
        <b>No measurements of your own yet</b><span class="muted">For example: shot = 30 ml, scoop = 12 g, pump = 10 ml.</span></div>`;
  return `<section class="card pad">
      <h2>📏 Measurements</h2>
      <p class="muted">Add the measures you use behind the counter. They show up in every unit list.</p>
      ${body}
      <div class="toolbar"><button class="btn primary" data-action="add-measure">+ Add measurement</button></div>
      <p class="hint" style="margin:12px 0 0">Built in: ${Object.keys(UNITS).join(', ')}</p>
    </section>`;
}

function renderSettings() {
  const d = state.data;
  return `<div class="settings">
    <section class="card pad">
      <h2>🏪 Shop</h2>
      <form id="settings-form">
        <label class="field"><span>Shop name</span><input type="text" name="shopName" value="${esc(d.shopName)}" maxlength="80" required></label>
        <label class="field"><span>Currency</span><select name="currency">
          ${Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}" ${d.currency === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select></label>
        <p class="hint">Changing currency only changes the symbol. Prices are not converted.</p>
        <label class="field"><span>Target food cost %</span><input type="number" name="targetCostPct" value="${d.targetCostPct}" min="1" max="100" step="0.5" required></label>
        <p class="hint">Cafés often aim for 25–35%. Menus above this show as “High”.</p>
        <label class="field"><span>Target labor &amp; overhead %</span><input type="number" name="laborPct" value="${d.laborPct}" min="0" max="100" step="0.5" required></label>
        <p class="hint">Wages, rent, gas and everything else that is not ingredients. Used for est. profit on every menu. Net profit target is what is left: 100% − food cost − labor &amp; overhead.</p>
        <button class="btn primary" type="submit">Save settings</button>
      </form>
    </section>
    ${renderMeasures()}
    <section class="card pad">
      <h2>🧪 Example data</h2>
      <div class="toolbar">
        <button class="btn" data-action="load-examples">Load example data</button>
        <button class="btn danger" data-action="clear-examples" ${hasExampleData() ? '' : 'disabled'}>Clear example data</button>
      </div>
    </section>
    <section class="card pad">
      <h2>💾 Backup</h2>
      <p class="muted">${ONLINE
        ? 'Saved automatically in your Cloudflare database. To let family use the app, send them the link and the family password.'
        : 'Test mode: saved in this browser only. Download a backup file to keep a copy.'}</p>
      <div class="toolbar"><button class="btn" data-action="download-backup">Download backup (.json)</button></div>
      ${ONLINE ? `<hr class="divider">${signedInLine()}` : ''}
    </section>
  </div>`;
}

/* ---------- modals ---------- */

let modalOnClose = null;
function openModal({ title, body, buttons = [], wide = false, onOpen, onClose }) {
  const root = $('#modal-root');
  modalOnClose = onClose || null;
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn link" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${buttons.length ? `<div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.className || ''}" data-btn="${i}" ${b.submit ? 'type="submit"' : ''}>${esc(b.label)}</button>`).join('')}</div>` : ''}
  </div></div>`;
  const modal = $('.modal', root);
  lockPage();
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
  const after = modalOnClose;
  modalOnClose = null;
  $('#modal-root').innerHTML = '';
  unlockPage();
  after?.();
}

/* Phones show a pop-up as a normal full page (see style.css), so the iPhone keyboard
   scrolls it natively and taps land on the field shown. Remember the list position. */
let lockedY = null;
function lockPage() {
  if (lockedY !== null) return; // already open (e.g. Delete → confirm)
  lockedY = window.scrollY;
  document.body.classList.add('modal-open');
  if (matchMedia('(max-width: 720px)').matches) window.scrollTo(0, 0); // phone: start at the top of the editor
}
function unlockPage() {
  if (lockedY === null) return;
  document.body.classList.remove('modal-open');
  window.scrollTo(0, lockedY); // back to where you were in the list
  lockedY = null;
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

function unitOptions(selected, base, { noPieces = false } = {}) {
  const fits = u => (!base || unitInfo(u).base === base) && !(noPieces && unitInfo(u).base === 'pcs');
  const opt = (u, text = u) => `<option value="${esc(u)}" ${u === selected ? 'selected' : ''}>${esc(text)}</option>`;
  const builtIn = Object.keys(UNITS).filter(fits).map(u => opt(u)).join('');
  const own = (state.data?.measures || []).filter(m => fits(m.name))
    .map(m => opt(m.name, `${m.name} (${fmtNum(m.amount)} ${m.unit})`)).join('');
  return builtIn + (own ? `<optgroup label="Your measurements">${own}</optgroup>` : '');
}

// Units for "size of each" in the pack size calculator: weight or volume, not pieces.

// Menu lines that use an ingredient by the piece become an amount of `unit`: 1 pcs → `each` unit.
function convertPieceLines(items, ingredientId, each, unit) {
  for (const line of items) {
    if (line.ingredientId === ingredientId && unitInfo(line.unit)?.base === 'pcs') {
      const q = num(line.qty);
      line.qty = Number.isFinite(q) ? +(q * unitInfo(line.unit).factor * each).toFixed(3) : line.qty;
      line.unit = unit;
    }
  }
}

// opts.openCalc: open the calculator straight away. opts.onDone(conversion): called when the pop-up closes.
function ingredientModal(ing, opts = {}) {
  const isNew = !ing;
  ing = ing || { name: '', buyPrice: '', packSize: '', unit: 'g' };
  const used = isNew ? [] : menusUsing(ing.id);
  const oldBase = unitInfo(ing.unit)?.base;
  let lockBase = used.length ? oldBase : null;
  let conversion = null; // { each, unit } once "Use this" switches a by-the-piece ingredient to weight/volume
  let saved = false;
  const calc = { open: !!opts.openCalc, count: '1', each: '', unit: oldBase === 'g' ? 'g' : 'ml', applied: '' };

  const calcHTML = () => {
    if (!calc.open) return `<button type="button" class="calc-toggle" data-calc="open">🧮 Work out pack size</button>`;
    const count = num(calc.count), each = num(calc.each);
    const total = count * each;
    const ok = count > 0 && each > 0;
    const newBase = unitInfo(calc.unit).base;
    const price = num($('#ing-form [name=buyPrice]')?.value ?? ing.buyPrice);
    const perUnit = ok && price >= 0 ? price / total : NaN;
    let notice = '';
    if (used.length && oldBase !== 'pcs' && newBase !== oldBase) {
      notice = `<div class="notice bad">${esc(ing.name)} is used in menus in ${oldBase === 'g' ? 'weight (g)' : 'volume (ml)'}. Choose a ${oldBase === 'g' ? 'weight' : 'volume'} unit for the size.</div>`;
    } else if (used.length && oldBase === 'pcs') {
      const names = used.map(m => m.name);
      notice = `<div class="notice warn">⚠️ <b>${used.length} menu${used.length === 1 ? '' : 's'}</b> ${used.length === 1 ? 'uses' : 'use'} ${esc(ing.name)} in pcs (${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? '…' : ''}).
        They'll switch to ${esc(calc.unit)} when you save: <b>1 pcs → ${ok ? fmtNum(each) : '?'} ${esc(calc.unit)}</b>. Their cost stays the same; then change the amount to what you really use.</div>`;
    }
    const blocked = notice.includes('notice bad');
    return `<div class="calc">
      <div class="calc-title">🧮 Work out pack size <button type="button" data-calc="close" aria-label="Close calculator">✕</button></div>
      <div class="calc-grid">
        <label class="field"><span>How many did you buy?</span><input type="number" data-calc-field="count" value="${esc(calc.count)}" min="0" step="any"></label>
        <span class="calc-times" aria-hidden="true">×</span>
        <label class="field"><span>Size of each</span><input type="number" data-calc-field="each" value="${esc(calc.each)}" min="0" step="any" placeholder="e.g. 250" class="${calc.each !== '' && !(each > 0) ? 'error' : ''}"></label>
        <label class="field calc-unit"><span>Unit</span><select data-calc-field="unit">${unitOptions(calc.unit, null, { noPieces: true })}</select></label>
      </div>
      ${notice}
      ${calc.applied ? `<div class="notice ok">✓ ${esc(calc.applied)}</div>` : ''}
      ${ok ? `<div class="calc-result"><div class="calc-sum">${fmtNum(count)} × ${fmtNum(each)} ${esc(calc.unit)} = ${fmtNum(total)} ${esc(calc.unit)}
          ${Number.isFinite(perUnit) ? `<small>${money(price)} ÷ ${fmtNum(total)} ${esc(calc.unit)} = ${money(perUnit, 4)} per ${esc(calc.unit)}</small>` : ''}</div>
          <button type="button" class="btn primary small" data-calc="use" ${blocked ? 'disabled' : ''}>Use this</button></div>`
        : '<div class="calc-result empty">Enter how many and the size of each to see the pack size.</div>'}
    </div>`;
  };

  openModal({
    title: isNew ? 'Add ingredient' : 'Edit ingredient',
    onClose: () => opts.onDone?.(saved ? conversion : null),
    body: `<form id="ing-form">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(ing.name)}" maxlength="80" required></label>
      <div class="row">
        <label class="field"><span>Buy price (${esc(state.data.currency)})</span><input type="number" name="buyPrice" value="${esc(ing.buyPrice)}" min="0" step="any" required></label>
        <label class="field"><span>Pack size</span><input type="number" name="packSize" value="${esc(ing.packSize)}" min="0" step="any" required></label>
        <label class="field"><span>Unit</span><select name="unit">${unitOptions(ing.unit, lockBase)}</select></label>
      </div>
      <div id="calc-slot"></div>
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
        const newBase = unitInfo(v.unit).base;
        const convert = used.length && newBase !== oldBase ? conversion : null;
        if (used.length && newBase !== oldBase && !(convert && unitInfo(convert.unit).base === newBase)) {
          $('#ing-error').textContent = 'This ingredient is used in menus, so its unit type can only change with the calculator.'; return true;
        }
        mutate(d => {
          if (isNew) d.ingredients.push({ id: uid('ing'), name, buyPrice, packSize, unit: v.unit });
          else {
            const target = d.ingredients.find(i => i.id === ing.id);
            Object.assign(target, { name, buyPrice, packSize, unit: v.unit });
            delete target.example;
            if (convert) for (const m of d.menus) convertPieceLines(m.items, ing.id, convert.each, convert.unit);
          }
        });
        saved = true;
        conversion = convert;
        if (convert) toast(`${used.length} menu${used.length === 1 ? '' : 's'} switched to ${convert.unit}`, 'ok');
      } },
    ],
    onOpen: modal => {
      const f = $('#ing-form', modal);
      const slot = $('#calc-slot', modal);
      const update = () => {
        const v = Object.fromEntries(new FormData(f));
        const c = num(v.buyPrice) / num(v.packSize);
        $('#ing-preview', modal).textContent = Number.isFinite(c) && num(v.packSize) > 0 ? `= ${money(c, 4)} per ${v.unit}` : '';
      };
      const drawCalc = () => { slot.innerHTML = calcHTML(); };
      // Redraw the result without losing focus in the box being typed in.
      const refreshCalc = () => {
        const active = document.activeElement?.dataset?.calcField;
        const pos = document.activeElement?.selectionStart;
        drawCalc();
        if (active) {
          const el = $(`[data-calc-field="${active}"]`, slot);
          el.focus();
          try { if (pos != null) el.setSelectionRange(pos, pos); } catch { /* number inputs have no selection */ }
        }
      };
      f.addEventListener('input', e => {
        const field = e.target.dataset.calcField;
        if (field) { calc[field] = e.target.value; calc.applied = ''; refreshCalc(); return; }
        update();
        if (calc.open && e.target.name === 'buyPrice') refreshCalc();
      });
      slot.addEventListener('click', e => {
        const act = e.target.closest('[data-calc]')?.dataset.calc;
        if (act === 'open') { calc.open = true; drawCalc(); $('[data-calc-field="each"]', slot)?.focus(); }
        else if (act === 'close') { calc.open = false; drawCalc(); }
        else if (act === 'use') {
          const count = num(calc.count), each = num(calc.each);
          if (!(count > 0 && each > 0)) return;
          const total = +(count * each).toFixed(3);
          const newBase = unitInfo(calc.unit).base;
          if (used.length) {
            lockBase = newBase;
            conversion = oldBase === 'pcs' ? { each, unit: calc.unit } : null;
          }
          const unitSel = f.unit;
          unitSel.innerHTML = unitOptions(calc.unit, lockBase);
          unitSel.value = calc.unit;
          f.packSize.value = total;
          const price = num(f.buyPrice.value);
          calc.applied = `Pack size set to ${fmtNum(total)} ${calc.unit}${price >= 0 ? ` · ${money(price / total, 4)} per ${calc.unit}` : ''}`;
          update();
          drawCalc();
        }
      });
      f.addEventListener('submit', e => { e.preventDefault(); $('.modal-foot .primary').click(); });
      drawCalc();
      update();
    },
  });
}

function measureModal(m) {
  const isNew = !m;
  m = m || { name: '', amount: '', unit: 'ml' };
  const oldName = m.name; // m is the saved object, so keep the name before it changes
  const use = isNew ? { menus: [], ingredients: [] } : measureUse(m.name);
  const inUse = use.menus.length + use.ingredients.length > 0;
  const lockBase = inUse ? UNITS[m.unit].base : null;
  const unitList = SIZE_BASE_UNITS.filter(u => !lockBase || UNITS[u].base === lockBase)
    .map(u => `<option value="${u}" ${u === m.unit ? 'selected' : ''}>${u}</option>`).join('');
  const usedNames = [...use.menus.map(x => x.name), ...use.ingredients.map(x => x.name)];

  openModal({
    title: isNew ? 'Add measurement' : 'Edit measurement',
    body: `<form id="measure-form">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(m.name)}" maxlength="20" required placeholder="e.g. shot"></label>
      <div class="eq-row">
        <span class="eq-one" id="eq-one">1 ${esc(m.name || '…')} =</span>
        <label class="field"><span>Amount</span><input type="number" name="amount" value="${esc(m.amount)}" min="0" step="any" required></label>
        <label class="field"><span>Unit</span><select name="unit">${unitList}</select></label>
      </div>
      <p class="hint" style="margin-top:8px">${inUse
        ? `Changing the amount updates the cost of everything that uses ${esc(m.name)}. ${lockBase === 'ml' ? 'Volume' : 'Weight'} stays ${lockBase === 'ml' ? 'volume' : 'weight'} while it's in use.`
        : "Use a short name you'd say out loud: shot, scoop, pump, tbsp."}</p>
      <div class="measure-preview" id="measure-preview"></div>
      <p class="error-text" id="measure-error"></p>
    </form>`,
    buttons: [
      ...(isNew ? [] : [{ label: 'Delete', className: 'danger left', onClick: () => {
        if (inUse) {
          $('#measure-error').textContent = `Can't delete: ${m.name} is used in ${usedNames.slice(0, 4).join(', ')}${usedNames.length > 4 ? '…' : ''}. Change those first.`;
          return true;
        }
        mutate(d => { d.measures = d.measures.filter(x => x.name !== oldName); });
        toast('Measurement deleted', 'ok');
      } }]),
      { label: 'Cancel' },
      { label: 'Save', className: 'primary', onClick: () => {
        const f = $('#measure-form');
        if (!f.reportValidity()) return true;
        const v = Object.fromEntries(new FormData(f));
        const name = v.name.trim();
        const amount = num(v.amount);
        const err = t => { $('#measure-error').textContent = t; f.name.classList.toggle('error', true); return true; };
        if (!name) return err('Enter a name.');
        if (Object.keys(UNITS).some(u => u.toLowerCase() === name.toLowerCase())) return err(`“${name}” is already a unit. Pick another name.`);
        if (state.data.measures.some(x => x.name !== oldName && x.name.toLowerCase() === name.toLowerCase())) return err(`You already have a measurement called “${name}”.`);
        if (!(amount > 0)) { $('#measure-error').textContent = 'Amount must be more than 0.'; return true; }
        mutate(d => {
          const fields = { name, amount, unit: v.unit };
          if (isNew) { d.measures.push(fields); return; }
          Object.assign(d.measures.find(x => x.name === oldName), fields);
          if (name !== oldName) {
            // Renamed: update everything that used the old name.
            for (const i of d.ingredients) if (i.unit === oldName) i.unit = name;
            for (const menu of d.menus) for (const l of menu.items) if (l.unit === oldName) l.unit = name;
          }
        });
        toast(isNew ? `Added ${name}` : 'Measurement saved', 'ok');
      } },
    ],
    onOpen: modal => {
      const f = $('#measure-form', modal);
      const update = () => {
        const name = f.name.value.trim() || '…';
        const amount = num(f.amount.value);
        const unit = f.unit.value;
        $('#eq-one', modal).textContent = `1 ${name} =`;
        const sample = [...state.data.ingredients].sort(byName).find(i => unitInfo(i.unit)?.base === UNITS[unit].base);
        let text = '';
        if (amount > 0) {
          const two = 2 * amount;
          text = `2 ${name} = ${fmtNum(two)} ${unit}`;
          if (sample) text += ` · of ${sample.name}: ${money(two * UNITS[unit].factor * costPerBaseUnit(sample))}`;
        }
        const box = $('#measure-preview', modal);
        box.textContent = text;
        box.hidden = !text;
      };
      f.addEventListener('input', () => { f.name.classList.remove('error'); $('#measure-error', modal).textContent = ''; update(); });
      f.addEventListener('submit', e => { e.preventDefault(); $('.modal-foot .primary').click(); });
      update();
    },
  });
}

// draftIn: reopen with unsaved edits (e.g. after fixing an ingredient's size from a menu line).
function menuModal(menu, draftIn = null) {
  const d = state.data;
  if (!d.ingredients.length) {
    confirmModal('Add ingredients first', 'A menu is built from your ingredients. Add some ingredients first.', 'Go to ingredients', () => setTab('ingredients'));
    return;
  }
  const isNew = !menu;
  // Edit a copy so Cancel throws changes away.
  const draft = draftIn || structuredClone(menu || { id: uid('menu'), name: '', category: '', sellPrice: '', yield: 1, items: [], steps: [] });
  draft.steps = draft.steps || [];
  // Upload progress per step, kept out of the saved data.
  const stepState = new WeakMap();
  const uploading = () => draft.steps.some(s => stepState.get(s)?.uploading);
  if (!draft.items.length) draft.items.push({ ingredientId: '', qty: '', unit: 'g' });
  const ingredients = [...d.ingredients].sort(byName);
  const categories = [...new Set(d.menus.map(m => m.category).filter(Boolean))].sort();
  let readForm = () => {};

  const lineRow = (line, idx) => {
    const ing = findIngredient(line.ingredientId);
    const base = ing ? unitInfo(ing.unit).base : null;
    return `<tr data-idx="${idx}">
      <td class="ing"><select data-field="ingredientId">
        <option value="">Choose…</option>
        ${ingredients.map(i => `<option value="${esc(i.id)}" ${i.id === line.ingredientId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
      </select></td>
      <td class="qty"><input type="number" data-field="qty" value="${esc(line.qty)}" min="0" step="any" placeholder="0"></td>
      <td class="unit"><select data-field="unit">${unitOptions(line.unit, base)}</select></td>
      <td class="num line-cost">${money(recipeLineCost(line))}</td>
      <td class="rm"><button class="btn link" type="button" data-remove="${idx}" aria-label="Remove">✕</button></td>
    </tr>${base === 'pcs' ? `<tr class="line-hint"><td colspan="5">${esc(ing.name)} is bought by the piece.
      <button type="button" class="btn link" data-set-size="${esc(ing.id)}">Set its size</button> to use ml or g.</td></tr>` : ''}`;
  };

  const stepRow = (step, idx) => {
    const st = stepState.get(step) || {};
    const last = idx === draft.steps.length - 1;
    let photo;
    if (st.uploading) photo = '<div class="step-thumb loading">Uploading…</div>';
    else if (step.photo) photo = `<div class="step-thumb"><button type="button" class="thumb-btn" data-step-act="photo" aria-label="Change photo"><img src="${esc(photoSrc(step.photo))}" alt="Step ${idx + 1} photo"></button>
      <button type="button" class="thumb-x" data-step-act="rm-photo" aria-label="Remove photo">✕</button></div>`;
    else photo = '<button type="button" class="btn small" data-step-act="photo">Add photo</button>';
    return `<li class="step" data-step="${idx}">
      <span class="step-no">${idx + 1}</span>
      <textarea data-step-text rows="2" maxlength="500" placeholder="What to do in this step">${esc(step.text || '')}</textarea>
      <div class="step-tools">
        <button type="button" class="btn link" data-step-act="up" aria-label="Move step up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn link" data-step-act="down" aria-label="Move step down" ${last ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn link" data-step-act="del" aria-label="Delete step">✕</button>
      </div>
      <div class="step-photo">${photo}${st.error ? `<span class="error-text">${esc(st.error)}</span>` : ''}</div>
    </li>`;
  };

  // Targets typed in the price planner are a try-out: they are not saved with the menu.
  const plan = { food: d.targetCostPct, labor: d.laborPct, startPrice: num(draft.sellPrice) || 0 };

  const planHTML = `<section class="plan" aria-label="Price planner">
      <h3 class="ed-h">🧮 Price planner</h3>
      <p class="muted" id="plan-empty" hidden>Add ingredients to see suggested prices.</p>
      <div class="plan-body" id="plan-body" hidden>
        <div class="plan-group">
          <h4>Targets</h4>
          <div class="plan-targets">
            <label class="field"><span>Food cost %</span><input type="number" data-plan="food" value="${plan.food}" step="any" inputmode="decimal"></label>
            <label class="field"><span>Labor &amp; overhead %</span><input type="number" data-plan="labor" value="${plan.labor}" step="any" inputmode="decimal"></label>
            <div class="field"><span>Net profit %</span><div class="plan-value" id="plan-profit"></div></div>
          </div>
          <p class="error-text" id="plan-error" hidden>Food cost and labor add up to more than 100%. Lower one of them.</p>
          <p class="plan-note muted">Try-out only. To keep new targets, change them in Settings.</p>
          <button class="btn link plan-reset" type="button" id="plan-reset">Reset to saved targets</button>
        </div>
        <div class="plan-group">
          <h4><label for="plan-slider">Try a price: <span id="plan-price"></span></label></h4>
          <input type="range" id="plan-slider">
          <div class="plan-range"><span id="plan-min"></span><span id="plan-max"></span></div>
        </div>
        <div class="plan-group">
          <h4>Quick prices</h4>
          <div class="plan-presets" id="plan-presets"></div>
        </div>
        <div class="plan-group">
          <h4>Where the price goes</h4>
          <div class="plan-legend" id="plan-legend"></div>
          <div class="plan-bar-row"><span>Target</span><div id="plan-bar-target"></div></div>
          <div class="plan-bar-row"><span>At this price</span><div id="plan-bar-actual"></div></div>
          <div id="plan-loss"></div>
          <div class="table-wrap"><table class="plan-table" id="plan-table"></table></div>
        </div>
      </div>
    </section>`;

  const summaryHTML = () => {
    const c = calcMenu(draft, plan.food, plan.labor);
    const portions = c.portions > 1 ? `<dt>Whole batch (${c.portions} portions)</dt><dd>${money(c.batchCost)}</dd>` : '';
    const neg = c.profit < 0 ? 'neg' : '';
    return `<div class="sum-head">
        <span class="sum-label">Est. profit per plate</span>
        <span class="big-profit ${neg}">${money(c.profit)}</span>
        ${Number.isFinite(c.profitPct) ? `<span class="pill ${c.profitPct < 0 ? 'bad' : 'ok'}">${pct(c.profitPct)} of price</span>` : ''}
      </div>
      ${c.status === 'none' ? '' : `<div>${costMeter(c)}<div class="meter-cap"><span>Food cost ${pct(c.foodCostPct)}</span><span>Target ${fmtNum(c.targetPct)}%</span></div></div>`}
      <dl>
      ${portions}
      <dt>Ingredients per plate</dt><dd>${money(c.ingredientCost)}</dd>
      ${c.laborCost >= 0 ? `<dt>Labor &amp; overhead (${fmtNum(c.laborPct)}%)</dt><dd>${money(c.laborCost)}</dd>` : ''}
      <dt class="total">Total cost per plate</dt><dd class="total">${money(c.totalCost)}</dd>
      <hr>
      <dt>Sell price</dt><dd>${money(num(draft.sellPrice))}</dd>
      <dt>Food cost %</dt><dd>${statusPill(c)}</dd>
      ${Number.isFinite(c.targetPrice) ? `<dt>Price for ${fmtNum(c.targetPct)}% food cost</dt><dd>${money(c.targetPrice)}</dd>` : ''}
      <dt>Break-even price</dt><dd>${money(c.breakEvenPrice)}</dd>
    </dl>
    ${c.problems ? `<p class="error-text" style="margin:8px 0 0">${c.problems} ingredient line(s) are incomplete and not counted.</p>` : ''}`;
  };

  openModal({
    title: isNew ? 'Add menu' : 'Edit menu',
    wide: true,
    body: `<form id="menu-form" class="editor">
      <div class="editor-main">
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
      <h3 class="ed-h">🧺 Ingredients used</h3>
      <div class="table-wrap"><table class="recipe-table">
        <thead><tr><th>Ingredient</th><th>Amount</th><th>Unit</th><th class="num">Cost</th><th></th></tr></thead>
        <tbody id="lines"></tbody>
      </table></div>
      <button class="btn small" type="button" id="add-line" style="margin-top:8px">+ Add ingredient</button>
      ${planHTML}
      <section class="editor-steps">
        <h3 class="ed-h">👩‍🍳 How to make</h3>
        <ol class="steps" id="steps"></ol>
        <button class="btn small" type="button" id="add-step">+ Add step</button>
        <p class="hint" style="margin-top:6px">One action per step. A photo is optional. Steps show on the recipe card.</p>
      </section>
      <input type="file" id="step-photo-input" accept="image/*" hidden>
      </div>
      <aside class="summary" id="summary" aria-live="polite"></aside>
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
      { label: 'Recipe card (PDF)', onClick: () => {
        readForm();
        printRecipeCards([{ ...draft, name: draft.name.trim() || 'Untitled menu', steps: cleanSteps(draft.steps) }]);
        return true;
      } },
      { label: 'Cancel' },
      { label: 'Save', className: 'primary', onClick: () => {
        const f = $('#menu-form');
        if (!f.reportValidity()) return true;
        if (uploading()) { $('#menu-error').textContent = 'Wait for the photos to finish uploading.'; return true; }
        readForm();
        draft.steps = cleanSteps(draft.steps);
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
      const planSlider = $('#plan-slider', modal);
      // Only fills in parts of the planner, so the slider and target inputs keep working while in use.
      const drawPlan = () => {
        const c = calcMenu(draft, plan.food, plan.labor);
        const ing = c.ingredientCost;
        const ready = ing > 0;
        $('#plan-empty', modal).hidden = ready;
        $('#plan-body', modal).hidden = !ready;
        if (!ready) return;

        const price = num(draft.sellPrice);
        const hasPrice = price > 0;
        const top = 2 * Math.max(plan.startPrice, 5 * ing);
        const step = top <= 50 ? 0.05 : top <= 500 ? 0.5 : 1;
        const lo = +(Math.floor(ing / step) * step).toFixed(2);
        const hi = +(Math.ceil(top / step) * step).toFixed(2);
        if (+planSlider.max !== hi || +planSlider.min !== lo || +planSlider.step !== step) {
          planSlider.min = lo; planSlider.max = hi; planSlider.step = step;
          $('#plan-min', modal).textContent = money(lo);
          $('#plan-max', modal).textContent = money(hi);
        }
        if (+planSlider.value !== price) planSlider.value = hasPrice ? price : lo;
        $('#plan-price', modal).textContent = money(hasPrice ? price : NaN);

        const presets = [[3.33, 30], [4, 25], [5, 20]].map(([times, foodPct]) => {
          const value = +(ing * times).toFixed(2);
          return `<button class="plan-preset" type="button" data-plan-price="${value}" aria-pressed="false"><strong>${times}×</strong><span class="plan-preset-price">${money(value)}</span><span class="plan-preset-pct">${foodPct}% food cost</span></button>`;
        }).join('');
        const presetsEl = $('#plan-presets', modal);
        if (presetsEl.dataset.html !== presets) { presetsEl.innerHTML = presets; presetsEl.dataset.html = presets; }
        $$('[data-plan-price]', presetsEl).forEach(b => b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.planPrice - price) < 0.005)));

        const food = c.targetPct;
        const labor = c.laborPct;
        const targetProfit = 100 - food - labor;
        const over = targetProfit < 0;
        $('#plan-error', modal).hidden = !over;
        $('#plan-profit', modal).textContent = over ? '—' : fmtNum(targetProfit) + '%';

        const laborAmount = c.laborCost;
        const planProfit = c.profit;
        const laborName = 'Labor &amp; overhead';
        const seg = (kind, name, size, text) => size > 0 ? `<div class="plan-seg" style="flex:${size.toFixed(2)} 1 0;background:var(--chart-${kind})" title="${name}: ${text}"></div>` : '';
        const shareOf = v => `${money(v)} (${pct(v / price)})`;

        $('#plan-legend', modal).innerHTML = [['food', 'Food'], ['labor', laborName], ['profit', 'Profit']]
          .map(([kind, name]) => `<span><i class="plan-swatch" style="background:var(--chart-${kind})"></i>${name}</span>`).join('');
        $('#plan-bar-target', modal).innerHTML = over ? '<span class="plan-bar-none">Fix targets to see this bar</span>'
          : `<div class="plan-bar">${seg('food', 'Food', food, fmtNum(food) + '%')}${seg('labor', laborName, labor, fmtNum(labor) + '%')}${seg('profit', 'Profit', targetProfit, fmtNum(targetProfit) + '%')}</div>`;
        $('#plan-bar-actual', modal).innerHTML = !hasPrice ? '<span class="plan-bar-none">Choose a price to see this bar</span>'
          : `<div class="plan-bar">${seg('food', 'Food', ing, shareOf(ing))}${seg('labor', laborName, laborAmount, shareOf(laborAmount))}${seg('profit', 'Profit', planProfit, shareOf(planProfit))}</div>`;
        $('#plan-loss', modal).innerHTML = planProfit < 0 ? `<span class="pill bad">⚠️ Loss ${money(-planProfit)} per plate</span>` : '';

        const row = (name, target, amount) => `<tr><td>${name}</td><td>${target}</td><td>${money(amount)}</td><td>${hasPrice ? pct(amount / price) : '—'}</td></tr>`;
        $('#plan-table', modal).innerHTML = `<thead><tr><th>Part</th><th>Target</th><th>At this price</th><th>Share</th></tr></thead><tbody>
          ${row('Food', fmtNum(food) + '%', hasPrice ? ing : NaN)}
          ${row(laborName, fmtNum(labor) + '%', laborAmount)}
          ${row('Profit', over ? '—' : fmtNum(targetProfit) + '%', planProfit)}</tbody>`;

      };
      const drawSummary = () => {
        $('#summary', modal).innerHTML = summaryHTML();
        drawPlan();
        $$('#lines tr[data-idx]', modal).forEach(tr => {
          $('.line-cost', tr).textContent = money(recipeLineCost(draft.items[+tr.dataset.idx]));
        });
      };
      readForm = () => {
        draft.name = f.name.value;
        draft.category = f.category.value.trim();
        draft.sellPrice = f.sellPrice.value;
        draft.yield = Math.max(1, Math.round(num(f.yield.value)) || 1);
      };
      const setSellPrice = value => {
        f.sellPrice.value = String(+(+value).toFixed(2));
        readForm();
        drawSummary();
      };
      f.addEventListener('click', e => {
        const preset = e.target.closest('[data-plan-price]');
        if (preset) { setSellPrice(preset.dataset.planPrice); return; }
        if (e.target.id === 'plan-reset') {
          plan.food = d.targetCostPct;
          plan.labor = d.laborPct;
          $('[data-plan="food"]', f).value = plan.food;
          $('[data-plan="labor"]', f).value = plan.labor;
          drawSummary();
        }
      });
      f.addEventListener('input', e => {
        if (e.target === planSlider) { setSellPrice(e.target.value); return; }
        if (e.target.dataset.plan) { plan[e.target.dataset.plan] = num(e.target.value); drawSummary(); return; }
        if (e.target === f.sellPrice) plan.startPrice = num(e.target.value) || 0;
        const tr = e.target.closest('tr[data-idx]');
        if (tr) {
          const line = draft.items[+tr.dataset.idx];
          const field = e.target.dataset.field;
          line[field] = e.target.value;
          if (field === 'ingredientId') {
            // Switch the unit to one that fits the chosen ingredient.
            const ing = findIngredient(line.ingredientId);
            if (ing && unitInfo(line.unit).base !== unitInfo(ing.unit).base) line.unit = unitInfo(ing.unit).base;
            drawLines();
          }
        } else readForm();
        drawSummary();
      });
      f.addEventListener('submit', e => { e.preventDefault(); $('.modal-foot .primary').click(); });
      linesEl.addEventListener('click', e => {
        const sizeBtn = e.target.closest('[data-set-size]');
        if (sizeBtn) {
          // Fix the ingredient's size, then come back to this menu with the edits kept.
          if (uploading()) { $('#menu-error').textContent = 'Wait for the photos to finish uploading.'; return; }
          readForm();
          const id = sizeBtn.dataset.setSize;
          ingredientModal(findIngredient(id), { openCalc: true, onDone: conv => {
            if (conv) convertPieceLines(draft.items, id, conv.each, conv.unit);
            menuModal(menu, draft);
          } });
          return;
        }
        const btn = e.target.closest('[data-remove]');
        if (!btn) return;
        draft.items.splice(+btn.dataset.remove, 1);
        if (!draft.items.length) draft.items.push({ ingredientId: '', qty: '', unit: 'g' });
        drawLines(); drawSummary();
      });
      // How to make: step list with optional photo per step.
      const stepsEl = $('#steps', modal);
      const fileInput = $('#step-photo-input', modal);
      let photoTarget = null;
      const drawSteps = () => { stepsEl.innerHTML = draft.steps.map(stepRow).join(''); };
      stepsEl.addEventListener('input', e => {
        if (!e.target.matches('[data-step-text]')) return;
        e.stopPropagation(); // step text does not change costs
        draft.steps[+e.target.closest('[data-step]').dataset.step].text = e.target.value;
      });
      stepsEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-step-act]');
        if (!btn) return;
        const i = +btn.closest('[data-step]').dataset.step;
        const act = btn.dataset.stepAct;
        const s = draft.steps;
        if (act === 'up' && i > 0) [s[i - 1], s[i]] = [s[i], s[i - 1]];
        else if (act === 'down' && i < s.length - 1) [s[i + 1], s[i]] = [s[i], s[i + 1]];
        else if (act === 'del') s.splice(i, 1);
        else if (act === 'rm-photo') delete s[i].photo;
        else if (act === 'photo') { photoTarget = s[i]; fileInput.value = ''; fileInput.click(); return; }
        drawSteps();
      });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        const step = photoTarget;
        photoTarget = null;
        if (!file || !step) return;
        stepState.set(step, { uploading: true });
        $('#menu-error', modal).textContent = '';
        drawSteps();
        try {
          step.photo = await uploadStepPhoto(file);
          stepState.delete(step);
        } catch (err) {
          stepState.set(step, { error: err.message });
        }
        if (stepsEl.isConnected) drawSteps();
      });
      $('#add-step', modal).onclick = () => {
        draft.steps.push({ text: '' });
        drawSteps();
        $('#steps li:last-child textarea', modal).focus();
      };
      drawSteps();

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
      <p class="hint" style="margin:0 0 12px">Units: ${unitNames().join(', ')}. If an ingredient name already exists, its price and pack size are updated.</p>
      <input type="file" id="csv-file" accept=".csv,text/csv">
      <div id="import-preview" style="margin-top:14px"></div>`,
    buttons: [
      { label: 'Cancel' },
      { label: 'Import', className: 'primary', onClick: modal => {
        const plan = modal._plan;
        if (!plan || !(plan.adds.length + plan.updates.length)) return true;
        mutate(() => applyImport(plan));
        toast(`Imported: ${plan.adds.length} new, ${plan.updates.length} updated`, 'ok');
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
  state.category = '';
  window.scrollTo(0, 0);
  lsSet('menucost_tab', tab);
  render();
}

const ACTIONS = {
  'open-shop': el => openShop(el.dataset.id),
  'switch-shop': switchShop,
  'sign-out': signOut,
  'tab': el => setTab(el.dataset.tab),
  'category': el => { state.category = el.dataset.cat; render(); },
  'menus-more': () => openModal({
    title: 'Menus',
    body: `<div class="sheet-actions">
      <button class="btn" data-sheet="print-all-cards">📄 All recipe cards (PDF)</button>
      <button class="btn" data-sheet="export-menus">Export CSV</button>
    </div>`,
    onOpen: modal => $$('[data-sheet]', modal).forEach(b => {
      b.onclick = () => { closeModal(); ACTIONS[b.dataset.sheet](); };
    }),
  }),
  'retry-save': () => { state.saveState = 'dirty'; saveNow(); },
  'go-ingredients': () => setTab('ingredients'),
  'add-menu': () => menuModal(null),
  'edit-menu': el => menuModal(state.data.menus.find(m => m.id === el.dataset.id)),
  'add-ingredient': () => ingredientModal(null),
  'edit-ingredient': el => ingredientModal(state.data.ingredients.find(i => i.id === el.dataset.id)),
  'add-measure': () => measureModal(null),
  'edit-measure': el => measureModal(state.data.measures.find(m => m.name === el.dataset.name)),
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
  'print-all-cards': () => printRecipeCards([...state.data.menus].sort(byName)),
  'download-backup': () => download(`${state.data.shopName} - backup.json`, JSON.stringify(state.data, null, 2), 'application/json'),
  'load-examples': () => confirmModal('Load example data?',
    `Adds sample ${esc(state.data.currency)} ingredients and menus, marked “example”. You can remove them any time in Settings → Clear example data.`,
    'Load examples', () => { mutate(loadExampleData); toast('Example data loaded', 'ok'); }),
  'clear-examples': () => confirmModal('Clear example data?',
    'Removes all items marked “example”. Example ingredients still used by your own menus are kept.',
    'Clear', () => { mutate(clearExampleData); toast('Example data cleared', 'ok'); }),
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
        toast('A shop with this name already exists.', 'bad'); return;
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
      if (!(target > 0 && target <= 100)) { toast('Target must be between 1 and 100.', 'bad'); return; }
      const labor = num(v.laborPct);
      if (!(labor >= 0 && labor <= 100)) { toast('Labor target must be between 0 and 100.', 'bad'); return; }
      if (target + labor > 100) { toast('Food cost and labor add up to more than 100%. Lower one of them.', 'bad'); return; }
      mutate(d => { d.shopName = v.shopName.trim() || d.shopName; d.currency = v.currency; d.targetCostPct = target; d.laborPct = labor; });
      toast('Settings saved', 'ok');
    };
  }
}

start();
