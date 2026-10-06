import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FeedItem } from './types.js';
import { NANO } from './types.js';
import { DATA_DIR } from './store.js';

export const HISTORY_DB_FILE = resolve(DATA_DIR, 'history.db');

const DB_VERSION = 4;
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
  backdrop_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  collection_name TEXT NOT NULL
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sales_collection_model
  ON sales(collection_name, model_name);
`;

function columnNames(database: Database.Database, table: string): string[] {
  const exists = database
    .prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) as { x: number } | undefined;
  if (!exists) return [];
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

/** Старая history.db копировала весь подарок. Оставляем поля, которые читает импорт в mrkt.db. */
function slimHistorySales(database: Database.Database): void {
  if (
    columnNames(database, 'sales').length === 0 &&
    columnNames(database, 'sales_slim').length > 0
  ) {
    database.exec('ALTER TABLE sales_slim RENAME TO sales');
    database.exec(CREATE_INDEXES);
  }

  const cols = columnNames(database, 'sales');
  const fat =
    cols.includes('model_sticker_key') ||
    cols.includes('gift_id') ||
    cols.includes('symbol_name') ||
    cols.includes('sale_price');
  if (!fat) return;

  const amountSql = cols.includes('sale_price')
    ? 'CASE WHEN amount > 0 THEN amount ELSE sale_price END'
    : 'amount';
  console.log('[history] сжимаю sales: убираю неиспользуемые поля подарка');
  const slim = database.transaction(() => {
    database.exec('DROP TABLE IF EXISTS sales_slim');
    database.exec(`
      CREATE TABLE sales_slim (
        id TEXT PRIMARY KEY NOT NULL,
        amount REAL NOT NULL,
        date TEXT NOT NULL,
        backdrop_name TEXT NOT NULL,
        model_name TEXT NOT NULL,
        collection_name TEXT NOT NULL
      )
    `);
    database.exec(`
      INSERT INTO sales_slim (
        id, amount, date, backdrop_name, model_name, collection_name
      )
      SELECT
        id,
        ${amountSql},
        date,
        backdrop_name,
        model_name,
        collection_name
      FROM sales
    `);
    database.exec('DROP TABLE sales');
    database.exec('ALTER TABLE sales_slim RENAME TO sales');
    database.exec(CREATE_INDEXES);
  });
  slim();
}

function initSchema(database: Database.Database): void {
  slimHistorySales(database);
  database.exec(CREATE_SALES);
  database.exec(CREATE_INDEXES);
  database.pragma(`user_version = ${DB_VERSION}`);
  const freePages = database.pragma('freelist_count', { simple: true }) as number;
  if (freePages >= 1000) {
    database.pragma('cache_size = -8000');
    console.log(`[history] vacuum history.db: свободно ${freePages} страниц`);
    database.exec('VACUUM');
    console.log('[history] sales сжата');
  }
}

export function insertFeedPage(
  database: Database.Database,
  items: FeedItem[],
): { added: number; known: number } {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO sales (
      id, amount, date, backdrop_name, model_name, collection_name
    ) VALUES (
      @id, @amount, @date, @backdrop_name, @model_name, @collection_name
    )
  `);

  const runBatch = database.transaction(
    (
      batch: {
        id: string;
        amount: number;
        date: string;
        backdrop_name: string;
        model_name: string;
        collection_name: string;
      }[],
    ) => {
      let added = 0;
      let known = 0;
      for (const sale of batch) {
        const info = insert.run(sale);
        if (info.changes > 0) added++;
        else known++;
      }
      return { added, known };
    },
  );

  const batch = [];
  for (const item of items) {
    const collectionName = item.gift.collectionName || item.gift.title;
    const modelName = item.gift.modelName;
    if (!collectionName || !modelName) continue;
    const amount = nanoToTonRounded(item.amount);
    if (amount == null) continue;
    batch.push({
      id: item.id,
      amount,
      date: item.date,
      backdrop_name: item.gift.backdropName ?? '',
      model_name: modelName,
      collection_name: collectionName,
    });
  }

  return runBatch(batch);
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

export function countSales(database: Database.Database): number {
  const row = database.prepare('SELECT COUNT(*) AS c FROM sales').get() as {
    c: number;
  };
  return row.c;
}
