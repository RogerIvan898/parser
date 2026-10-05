PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS collections (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  collection_name TEXT NOT NULL REFERENCES collections(name),
  model_name TEXT NOT NULL,
  model_title TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection_name, model_name)
);

CREATE TABLE IF NOT EXISTS collection_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_name TEXT NOT NULL REFERENCES collections(name),
  ts INTEGER NOT NULL,
  floor_nano INTEGER,
  volume_nano INTEGER,
  prev_day_floor_nano INTEGER
);

CREATE INDEX IF NOT EXISTS idx_collection_prices_coll_ts
  ON collection_prices(collection_name, ts DESC);

CREATE TABLE IF NOT EXISTS model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  floor_nano INTEGER,
  volume_nano INTEGER,
  FOREIGN KEY (collection_name, model_name)
    REFERENCES models(collection_name, model_name)
);

CREATE INDEX IF NOT EXISTS idx_model_prices_lookup
  ON model_prices(collection_name, model_name, ts DESC);

CREATE TABLE IF NOT EXISTS model_prices_daily (
  collection_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  day TEXT NOT NULL,
  floor_nano INTEGER,
  PRIMARY KEY (collection_name, model_name, day)
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  collection_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  backdrop_name TEXT NOT NULL DEFAULT '',
  symbol_name TEXT NOT NULL DEFAULT '',
  gift_number INTEGER NOT NULL,
  amount_nano INTEGER NOT NULL,
  date TEXT NOT NULL,
  ts INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_coll_model_ts
  ON sales(collection_name, model_name, ts);
CREATE INDEX IF NOT EXISTS idx_sales_coll_model_backdrop_ts
  ON sales(collection_name, model_name, backdrop_name, ts);
CREATE INDEX IF NOT EXISTS idx_sales_collection_ts
  ON sales(collection_name, ts);
