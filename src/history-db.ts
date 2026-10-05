import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FeedItem } from './types.js';
import { NANO } from './types.js';
import { DATA_DIR, toStoredFeedSale, type StoredFeedSale } from './store.js';

export const HISTORY_DB_FILE = resolve(DATA_DIR, 'history.db');

const DB_VERSION = 3;
/** Знаков после запятой для цен в TON */
const TON_DECIMALS = 4;

let db: Database.Database | null = null;

function nanoToTonRounded(nano: number | null): number | null {
  if (nano == null) return null;
  const ton = nano / NANO;
  const k = 10 ** TON_DECIMALS;
  return Math.round(ton * k) / k;
}

const CREATE_SALES = `
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  gift_id TEXT NOT NULL,
  export_date TEXT NOT NULL,
  received_date TEXT NOT NULL,
  gift_id_num INTEGER NOT NULL,
  backdrop_colors_center_color INTEGER NOT NULL,
  backdrop_colors_edge_color INTEGER NOT NULL,
  backdrop_colors_text_color INTEGER NOT NULL,
  backdrop_colors_symbol_color INTEGER NOT NULL,
  backdrop_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_sticker_key TEXT NOT NULL,
  model_sticker_thumbnail_key TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_sticker_key TEXT NOT NULL,
  symbol_sticker_thumbnail_key TEXT NOT NULL,
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  collection_name TEXT NOT NULL,
  sale_price REAL NOT NULL,
  sales_count INTEGER NOT NULL,
  is_locked INTEGER NOT NULL,
  is_locked_for_sale INTEGER NOT NULL,
  unlock_date TEXT NOT NULL,
  next_give_available_at TEXT NOT NULL,
  premarket_status TEXT NOT NULL,
  wait_gift_until TEXT,
  gifts_collection_id TEXT,
  gift_type TEXT NOT NULL,
  collection_title TEXT NOT NULL,
  model_title TEXT NOT NULL,
  return_locked_until TEXT,
  return_lock_reason TEXT,
  space_monkeys_points INTEGER,
  floor_by_collection REAL,
  floor_by_backdrop_model REAL,
  minted INTEGER NOT NULL
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sales_collection_model
  ON sales(collection_name, model_name);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
`;

function initSchema(database: Database.Database): void {
  const ver = database.pragma('user_version', { simple: true }) as number;
  if (ver < DB_VERSION) {
    database.exec('DROP TABLE IF EXISTS sales');
    database.exec(CREATE_SALES);
    database.exec(CREATE_INDEXES);
    database.pragma(`user_version = ${DB_VERSION}`);
    return;
  }
  database.exec(CREATE_SALES);
  database.exec(CREATE_INDEXES);
}

function saleToRow(s: StoredFeedSale) {
  const g = s.gift;
  return {
    id: s.id,
    amount: nanoToTonRounded(s.amount)!,
    date: s.date,
    gift_id: g.id,
    export_date: g.exportDate,
    received_date: g.receivedDate,
    gift_id_num: g.giftId,
    backdrop_colors_center_color: g.backdropColorsCenterColor,
    backdrop_colors_edge_color: g.backdropColorsEdgeColor,
    backdrop_colors_text_color: g.backdropColorsTextColor,
    backdrop_colors_symbol_color: g.backdropColorsSymbolColor,
    backdrop_name: g.backdropName,
    model_name: g.modelName,
    model_sticker_key: g.modelStickerKey,
    model_sticker_thumbnail_key: g.modelStickerThumbnailKey,
    symbol_name: g.symbolName,
    symbol_sticker_key: g.symbolStickerKey,
    symbol_sticker_thumbnail_key: g.symbolStickerThumbnailKey,
    name: g.name,
    number: g.number,
    collection_name: g.collectionName,
    sale_price: nanoToTonRounded(g.salePrice)!,
    sales_count: g.salesCount,
    is_locked: g.isLocked ? 1 : 0,
    is_locked_for_sale: g.isLockedForSale ? 1 : 0,
    unlock_date: g.unlockDate,
    next_give_available_at: g.nextGiveAvailableAt,
    premarket_status: g.premarketStatus,
    wait_gift_until: g.waitGiftUntil,
    gifts_collection_id: g.giftsCollectionId,
    gift_type: g.giftType,
    collection_title: g.collectionTitle,
    model_title: g.modelTitle,
    return_locked_until: g.returnLockedUntil,
    return_lock_reason: g.returnLockReason,
    space_monkeys_points: g.spaceMonkeysPoints,
    floor_by_collection: nanoToTonRounded(g.floorPriceNanoTONsByCollection),
    floor_by_backdrop_model: nanoToTonRounded(
      g.floorPriceNanoTONsByBackdropModel,
    ),
    minted: g.minted ? 1 : 0,
  };
}

export function openHistoryDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(HISTORY_DB_FILE), { recursive: true });
  db = new Database(HISTORY_DB_FILE);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

export function closeHistoryDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function insertFeedPage(
  database: Database.Database,
  items: FeedItem[],
): number {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO sales (
      id, amount, date,
      gift_id, export_date, received_date, gift_id_num,
      backdrop_colors_center_color, backdrop_colors_edge_color,
      backdrop_colors_text_color, backdrop_colors_symbol_color,
      backdrop_name, model_name, model_sticker_key, model_sticker_thumbnail_key,
      symbol_name, symbol_sticker_key, symbol_sticker_thumbnail_key,
      name, number, collection_name, sale_price, sales_count,
      is_locked, is_locked_for_sale, unlock_date, next_give_available_at,
      premarket_status, wait_gift_until, gifts_collection_id, gift_type,
      collection_title, model_title, return_locked_until, return_lock_reason,
      space_monkeys_points, floor_by_collection,
      floor_by_backdrop_model, minted
    ) VALUES (
      @id, @amount, @date,
      @gift_id, @export_date, @received_date, @gift_id_num,
      @backdrop_colors_center_color, @backdrop_colors_edge_color,
      @backdrop_colors_text_color, @backdrop_colors_symbol_color,
      @backdrop_name, @model_name, @model_sticker_key, @model_sticker_thumbnail_key,
      @symbol_name, @symbol_sticker_key, @symbol_sticker_thumbnail_key,
      @name, @number, @collection_name, @sale_price, @sales_count,
      @is_locked, @is_locked_for_sale, @unlock_date, @next_give_available_at,
      @premarket_status, @wait_gift_until, @gifts_collection_id, @gift_type,
      @collection_title, @model_title, @return_locked_until, @return_lock_reason,
      @space_monkeys_points, @floor_by_collection,
      @floor_by_backdrop_model, @minted
    )
  `);

  const runBatch = database.transaction((batch: StoredFeedSale[]) => {
    let added = 0;
    for (const sale of batch) {
      const row = saleToRow(sale);
      const info = insert.run(row);
      if (info.changes > 0) added++;
    }
    return added;
  });

  const batch: StoredFeedSale[] = [];
  for (const item of items) {
    const collectionName = item.gift.collectionName || item.gift.title;
    const modelName = item.gift.modelName;
    if (!collectionName || !modelName) continue;
    batch.push(toStoredFeedSale(item));
  }

  return runBatch(batch);
}

export function countSales(database: Database.Database): number {
  const row = database.prepare('SELECT COUNT(*) AS c FROM sales').get() as {
    c: number;
  };
  return row.c;
}
