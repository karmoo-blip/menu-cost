/**
 * Menu Cost — Google Apps Script backend.
 * Serves the web app and stores every shop in tabs of this Google Sheet.
 */

const TABS = {
  Shops:       ['shop_id', 'name', 'currency', 'target_pct', 'updated_at', 'updated_by'],
  Ingredients: ['shop_id', 'id', 'name', 'buy_price', 'pack_size', 'unit', 'example'],
  Menus:       ['shop_id', 'id', 'name', 'category', 'sell_price', 'portions', 'use_extras', 'example'],
  MenuItems:   ['shop_id', 'menu_id', 'menu_name', 'ingredient_id', 'ingredient_name', 'qty', 'unit'],
  Extras:      ['shop_id', 'id', 'name', 'type', 'value', 'example'],
};

// Columns stored as plain text, so Sheets never turns "1/2" or a timestamp into a date.
const TEXT_COLUMNS = ['shop_id', 'id', 'name', 'category', 'unit', 'type', 'updated_at', 'updated_by',
  'menu_id', 'menu_name', 'ingredient_id', 'ingredient_name', 'currency'];

function doGet() {
  setup_();
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Menu Cost')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used by Index.html to pull in Style.html and App.html. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Run once from the editor (or it runs on first page load) to create the tabs. */
function setup() {
  setup_();
}

/** Single entry point for the web page. Arguments and result are JSON text. */
function api(action, argsJson) {
  const actions = { whoAmI: whoAmI_, listShops: listShops_, createShop: createShop_, loadShop: loadShop_, saveShop: saveShop_ };
  const fn = actions[action];
  if (!fn) throw new Error('Unknown action: ' + action);
  return JSON.stringify(fn.apply(null, JSON.parse(argsJson || '[]')));
}

/* ---------- sheet helpers ---------- */

function ss_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Spreadsheet not found. Open the Sheet, then Extensions > Apps Script > run "setup".');
  return SpreadsheetApp.openById(id);
}

function setup_() {
  const ss = ss_();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  Object.keys(TABS).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      const header = TABS[name];
      sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      textFormat_(sheet, header, 1, sheet.getMaxRows());
    }
  });
  // Remove the empty starter tab Google adds to new spreadsheets.
  const starter = ss.getSheetByName('Sheet1');
  if (starter && starter.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(starter);
}

function textFormat_(sheet, header, fromRow, numRows) {
  header.forEach(function (h, i) {
    if (TEXT_COLUMNS.indexOf(h) >= 0) sheet.getRange(fromRow, i + 1, numRows, 1).setNumberFormat('@');
  });
}

function cell_(v) {
  if (v instanceof Date) return v.toISOString();
  return v;
}

function readTab_(name) {
  const sheet = ss_().getSheetByName(name);
  const header = TABS[name];
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).getValues();
  return values
    .filter(function (r) { return r.some(function (v) { return v !== '' && v !== null; }); })
    .map(function (r) {
      const o = {};
      header.forEach(function (h, i) { o[h] = cell_(r[i]); });
      return o;
    });
}

// Replace all rows of one shop in a tab, keeping other shops' rows.
function replaceShopRows_(name, shopId, newRows) {
  const sheet = ss_().getSheetByName(name);
  const header = TABS[name];
  const kept = readTab_(name).filter(function (r) { return String(r.shop_id) !== shopId; });
  const rows = kept.concat(newRows).map(function (o) {
    return header.map(function (h) { return o[h] === undefined || o[h] === null ? '' : o[h]; });
  });
  const oldCount = Math.max(sheet.getLastRow() - 1, 0);
  const needed = rows.length + 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  if (rows.length) {
    textFormat_(sheet, header, 2, rows.length);
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
  if (oldCount > rows.length) {
    sheet.getRange(rows.length + 2, 1, oldCount - rows.length, header.length).clearContent();
  }
}

function bool_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}
function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}
function email_() {
  return Session.getActiveUser().getEmail() || 'unknown';
}
function findShop_(shopId) {
  const shop = readTab_('Shops').filter(function (s) { return String(s.shop_id) === shopId; })[0];
  if (!shop) throw new Error('Shop not found. It may have been deleted from the Sheet.');
  return shop;
}
function meta_(shop) {
  return { id: String(shop.shop_id), modifiedTime: String(shop.updated_at), by: String(shop.updated_by || '') };
}

/* ---------- API ---------- */

function whoAmI_() {
  const ss = ss_();
  return { email: email_(), sheetUrl: ss.getUrl(), sheetName: ss.getName() };
}

function listShops_() {
  return readTab_('Shops')
    .map(function (s) {
      return { id: String(s.shop_id), name: String(s.name), currency: String(s.currency), modifiedTime: String(s.updated_at) };
    })
    .sort(function (a, b) { return b.modifiedTime.localeCompare(a.modifiedTime); });
}

function createShop_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    setup_();
    const shop = {
      shop_id: newId_('shop'),
      name: data.shopName,
      currency: data.currency,
      target_pct: data.targetCostPct,
      updated_at: new Date().toISOString(),
      updated_by: email_(),
    };
    replaceShopRows_('Shops', shop.shop_id, [shop]);
    return meta_(shop);
  } finally {
    lock.releaseLock();
  }
}

function loadShop_(shopId) {
  const shop = findShop_(shopId);
  const mine = function (r) { return String(r.shop_id) === shopId; };

  const ingredients = readTab_('Ingredients').filter(mine).map(function (r) {
    return {
      id: String(r.id || newId_('ing')), name: String(r.name), buyPrice: Number(r.buy_price),
      packSize: Number(r.pack_size), unit: String(r.unit).trim().toLowerCase(), example: bool_(r.example),
    };
  });
  const ingById = {}, ingByName = {};
  ingredients.forEach(function (i) { ingById[i.id] = i; ingByName[i.name.toLowerCase()] = i; });

  const menus = readTab_('Menus').filter(mine).map(function (r) {
    return {
      id: String(r.id || newId_('menu')), name: String(r.name), category: String(r.category || ''),
      sellPrice: Number(r.sell_price), yield: Number(r.portions) || 1,
      useExtras: r.use_extras === '' ? true : bool_(r.use_extras), example: bool_(r.example), items: [],
    };
  });
  const menuById = {}, menuByName = {};
  menus.forEach(function (m) { menuById[m.id] = m; menuByName[m.name.toLowerCase()] = m; });

  // Rows typed by hand in the Sheet may only have names, so fall back to names.
  readTab_('MenuItems').filter(mine).forEach(function (r) {
    const menu = menuById[String(r.menu_id)] || menuByName[String(r.menu_name).toLowerCase()];
    const ing = ingById[String(r.ingredient_id)] || ingByName[String(r.ingredient_name).toLowerCase()];
    if (!menu || !ing) return;
    menu.items.push({ ingredientId: ing.id, qty: Number(r.qty), unit: String(r.unit).trim().toLowerCase() });
  });

  const extras = readTab_('Extras').filter(mine).map(function (r) {
    return {
      id: String(r.id || newId_('ex')), name: String(r.name),
      type: String(r.type).toLowerCase() === 'percent' ? 'percent' : 'fixed', value: Number(r.value), example: bool_(r.example),
    };
  });

  return {
    data: {
      version: 1, shopName: String(shop.name), currency: String(shop.currency),
      targetCostPct: Number(shop.target_pct) || 35, ingredients: ingredients, menus: menus, extras: extras,
    },
    meta: meta_(shop),
  };
}

function saveShop_(shopId, data, expectedModifiedTime) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const shop = findShop_(shopId);
    if (expectedModifiedTime && String(shop.updated_at) !== expectedModifiedTime) {
      return { conflict: true, by: String(shop.updated_by || ''), modifiedTime: String(shop.updated_at) };
    }
    const ingName = {};
    data.ingredients.forEach(function (i) { ingName[i.id] = i.name; });

    replaceShopRows_('Ingredients', shopId, data.ingredients.map(function (i) {
      return { shop_id: shopId, id: i.id, name: i.name, buy_price: i.buyPrice, pack_size: i.packSize, unit: i.unit, example: i.example ? true : '' };
    }));
    replaceShopRows_('Menus', shopId, data.menus.map(function (m) {
      return { shop_id: shopId, id: m.id, name: m.name, category: m.category || '', sell_price: m.sellPrice,
        portions: m.yield || 1, use_extras: m.useExtras !== false, example: m.example ? true : '' };
    }));
    const items = [];
    data.menus.forEach(function (m) {
      m.items.forEach(function (l) {
        items.push({ shop_id: shopId, menu_id: m.id, menu_name: m.name, ingredient_id: l.ingredientId,
          ingredient_name: ingName[l.ingredientId] || '', qty: l.qty, unit: l.unit });
      });
    });
    replaceShopRows_('MenuItems', shopId, items);
    replaceShopRows_('Extras', shopId, data.extras.map(function (e) {
      return { shop_id: shopId, id: e.id, name: e.name, type: e.type, value: e.value, example: e.example ? true : '' };
    }));

    const updated = {
      shop_id: shopId, name: data.shopName, currency: data.currency, target_pct: data.targetCostPct,
      updated_at: new Date().toISOString(), updated_by: email_(),
    };
    replaceShopRows_('Shops', shopId, [updated]);
    return meta_(updated);
  } finally {
    lock.releaseLock();
  }
}
