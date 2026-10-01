# Menu Cost

A small web app for a restaurant or café to work out the cost, food cost % and profit of every menu item.

- Add ingredients (buy price + pack size), build menus from them, see cost per plate.
- Extra costs (wages, gas, rent) as % of sell price or a fixed amount per plate.
- Several shops, each with its own currency (THB or GBP).
- CSV import/export for ingredients, CSV export for menu costs.
- Optional example data (only loaded when you press the button).

It runs as a **Google Apps Script web app** attached to a Google Sheet. All data is stored in tabs of that Sheet
(`Shops`, `Ingredients`, `Menus`, `MenuItems`, `Extras`), so Google Drive is the backup. Only people you share the
Sheet with can open the app.

## Files

| File | What |
|------|------|
| `app.js`, `style.css`, `index.html` | The web page (edit these) |
| `apps-script/Code.gs` | Server code: serves the page, reads/writes the Sheet |
| `apps-script/Index.html`, `Style.html`, `App.html` | **Generated** by `node tools/build.mjs` from `index.html`, `style.css`, `app.js` |
| `test/sim.html` | Runs the app against `Code.gs` with a fake Sheet, for testing without Google |

## Setup (one time)

1. Create a new Google Sheet at <https://sheets.new>. Name it **Menu Cost**.
2. In the Sheet: **Extensions → Apps Script**. Name the project **Menu Cost**.
3. Replace everything in `Code.gs` with the contents of `apps-script/Code.gs`. Save.
4. Click **+** next to Files → **HTML** three times, naming them `Index`, `Style` and `App` (no `.html`).
   Replace each one's contents with `apps-script/Index.html`, `apps-script/Style.html` and `apps-script/App.html`. Save.
5. In the toolbar pick the function **setup** and click **Run**. Approve the permissions
   (Google shows "Google hasn't verified this app" → **Advanced** → **Go to Menu Cost (unsafe)** → **Allow** — it is your own script).
   The Sheet now has the 5 tabs.
6. **Deploy → New deployment** → type **Web app**:
   - Execute as: **User accessing the web app**
   - Who has access: **Anyone with Google account**
   - **Deploy**, copy the **Web app URL**. Bookmark it.

Access is controlled by the Sheet's sharing: a person who can't open the Sheet can't use the app.

### Family access

Share the Google Sheet with each family member's Gmail as **Editor**, then send them the Web app URL.
The first time, each person approves the permissions once.

If two people save the same shop at the same time, the app warns and lets you reload the other person's version instead of overwriting it.

### Updating the app later

Edit `app.js` / `style.css`, run `node tools/build.mjs`, paste the changed files from `apps-script/` into the Apps Script editor, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Editing data in the Sheet

You can view or edit the tabs directly. Leave `shop_id` filled in on every row. New rows typed by hand can leave `id` columns empty;
in `MenuItems` you can use `menu_name` and `ingredient_name` instead of the ids. Reload the app after editing the Sheet.

## Test locally (no Google)

```sh
python3 -m http.server 8765
```

- <http://localhost:8765/> — test mode, data in this browser only.
- <http://localhost:8765/test/sim.html> — runs the real `Code.gs` against a fake Sheet.

## CSV format (ingredients)

```
name,buy_price,pack_size,unit
Coffee beans,450,1,kg
Fresh milk,95,2,l
```

Units: `g, kg, oz, lb, ml, l, pcs`. Importing a name that already exists updates its price and pack size.
