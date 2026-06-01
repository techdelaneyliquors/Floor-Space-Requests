
PRAGMA foreign_keys = ON;

-- SVG items (myBox, myBox1..myBox106)
CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY
);


CREATE TABLE IF NOT EXISTS item_month_status (
  map_id TEXT NOT NULL,   
  item_id TEXT NOT NULL,
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (map_id, item_id, month),
  FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
);


-- Multi-user competing requests

CREATE TABLE IF NOT EXISTS item_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id TEXT NOT NULL,   -- ✅ NEW
  item_id TEXT NOT NULL,
  month TEXT NOT NULL,
  user TEXT NOT NULL,
  brand TEXT NOT NULL,
  products TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','reserved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
);


-- Seed the SVG IDs
INSERT OR IGNORE INTO items(item_id) VALUES ('FloorSpace');

WITH RECURSIVE nums(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM nums WHERE n < 108
)
INSERT OR IGNORE INTO items(item_id)
SELECT 'FloorSpace' || n FROM nums;



