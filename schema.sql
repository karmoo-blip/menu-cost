-- Menu Cost: one row per shop. `data` holds the whole shop (ingredients, menus, extras) as JSON.
CREATE TABLE IF NOT EXISTS shops (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- Wrong-password counter per connection (5 wrong tries locks it for 15 minutes).
CREATE TABLE IF NOT EXISTS login_attempts (
  ip         TEXT PRIMARY KEY,
  fails      INTEGER NOT NULL,
  first_fail INTEGER NOT NULL
);
