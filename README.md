# Menu Cost

A small web app for a restaurant or café to work out the cost, food cost % and profit of every menu item.

- Add ingredients (buy price + pack size), build menus from them, see cost per plate.
- Extra costs (wages, gas, rent) as % of sell price or a fixed amount per plate.
- Several shops, each with its own currency (THB or GBP).
- CSV import/export for ingredients, CSV export for menu costs.
- Optional example data (only loaded when you press the button).

It runs on **Cloudflare**: one Worker serves the page and an API, and the data is stored in a **D1** database
(`menu-cost`, one row per shop). Sign-in is one **family password**, stored as a Cloudflare secret, so nothing
secret is in this repo. GitHub only stores the code.

## Files

| File | What |
|------|------|
| `public/index.html`, `public/app.js`, `public/style.css` | The web page |
| `worker/worker.js` | API (`/api/*`): family password sign-in, reads/writes D1 |
| `schema.sql` | D1 tables (`shops`, `login_attempts`) |
| `wrangler.toml` | Worker and D1 settings |

## Setup (one time)

Needs Node.js. Run these in this folder.

1. Log in: `npx wrangler login`
2. Create the database: `npx wrangler d1 create menu-cost` and paste the `database_id` it prints into `wrangler.toml`.
3. Create the tables: `npx wrangler d1 execute menu-cost --remote --file schema.sql`
4. Set the family password (you type it; it is never shown or saved in a file):
   `npx wrangler secret put APP_PASSWORD`. Use something long, e.g. four random words.
5. Deploy: `npx wrangler deploy`. It prints the address, e.g. `https://menu-cost.<you>.workers.dev`.
6. Open the address, enter the password, and create your first shop.

### Family access

Send them the address and the password. Each phone or computer stays signed in for 30 days.

- **Sign out** is on the shop list and in Settings.
- **To remove someone**, set a new password (`npx wrangler secret put APP_PASSWORD`). Every device is signed
  out and needs the new password.
- 5 wrong passwords in 15 minutes from one connection blocks sign-in from it for 15 minutes.

If two people save the same shop at the same time, the app warns and lets you reload the other person's version instead of overwriting it.

### Updating the app later

Edit the files, then `npx wrangler deploy`. The address stays the same.

## Backup

**Settings → Download backup (.json)** saves one shop. D1 also keeps 30 days of history
(Time Travel: `npx wrangler d1 time-travel info menu-cost`).

## Test locally (no Cloudflare)

```sh
cd public && python3 -m http.server 8765
```

<http://localhost:8765/> — test mode, data in this browser only.

## CSV format (ingredients)

```
name,buy_price,pack_size,unit
Coffee beans,450,1,kg
Fresh milk,95,2,l
```

Units: `g, kg, oz, lb, ml, l, pcs`. Importing a name that already exists updates its price and pack size.
