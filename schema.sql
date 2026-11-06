-- Menu Cost: one row per shop. `data` holds the whole shop (ingredients, menus, extras) as JSON.
CREATE TABLE IF NOT EXISTS shops (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- New shops and photo uploads per connection, to stop storage being filled up.
CREATE TABLE IF NOT EXISTS usage_limits (
  ip       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  count    INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (ip, kind)
);
