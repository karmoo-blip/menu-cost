# Menu Cost

A small web app for a restaurant or café to work out the cost, food cost % and profit of every menu item.

- Add ingredients (buy price + pack size), build menus from them, see cost per plate.
- Extra costs (wages, gas, rent) as % of sell price or a fixed amount per plate.
- Several shops, each with its own currency (THB or GBP).
- CSV import/export for ingredients, CSV export for menu costs.
- Optional example data (only loaded when you press the button).
- Data is saved as one JSON file per shop in **your own Google Drive**. The website itself holds no data.

Plain HTML + JavaScript, no build step. Hosted on GitHub Pages.

## Privacy

The code on GitHub is public, but it contains no shop data and no secrets. All prices and recipes live in your Google Drive. The app uses the `drive.file` permission, so it can only see files it created or files you pick — not the rest of your Drive.

## Setup

### 1. Google Cloud (one time, free)

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "Menu Cost").
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Picker API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **External**. App name: Menu Cost. Add your email.
   - Scopes: add `.../auth/drive.file`.
   - **Audience → Test users**: add your Gmail and each family member's Gmail (up to 100).
   - Leave the app in **Testing**. Each person will see an "unverified app" warning once — click *Continue*.
4. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   - Authorized JavaScript origins: `https://<your-github-username>.github.io` and `http://localhost:8765` (for testing).
   - Copy the **Client ID**.
5. **Credentials → Create credentials → API key**. Restrict it: *Application restrictions → Websites* → `https://<your-github-username>.github.io/*`, *API restrictions → Google Picker API*.
6. Project number: **IAM & Admin → Settings → Project number**.
7. Put the three values in `config.js`.

### 2. GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<your-github-username>.github.io/<repo-name>/`.

### 3. Family access

1. Open the app, create a shop.
2. In Google Drive, find `MenuCost - <shop name>.json` and **Share** it with family (Editor).
3. Family members open the app, sign in, press **Open a shop shared with me**, pick the file once.

If two people save at the same time, the app warns and lets you reload the other person's version instead of overwriting it.

## Run locally

```sh
python3 -m http.server 8765
```

Open <http://localhost:8765>. With `GOOGLE_CLIENT_ID` empty in `config.js`, the app runs in "this browser only" mode (no sign-in, data in browser storage) — handy for trying it out.

## CSV format (ingredients)

```
name,buy_price,pack_size,unit
Coffee beans,450,1,kg
Fresh milk,95,2,l
```

Units: `g, kg, oz, lb, ml, l, pcs`. Importing a name that already exists updates its price and pack size.
