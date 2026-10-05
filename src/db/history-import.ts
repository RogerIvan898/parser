import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { NANO } from '../types.js';
import { HISTORY_DB_FILE } from '../history-db.js';
import { db } from './index.js';
import { isoToTs } from './storage.js';

const insertMrktSale = db.prepare(`
  INSERT OR IGNORE INTO sales (
    id, collection_name, model_name, backdrop_name, amount_nano, ts
  ) VALUES (
    @id, @collection_name, @model_name, @backdrop_name, @amount_nano, @ts
  )
`);

interface HistorySaleRow {
  id: string;
  collection_name: string;
  model_name: string;
  backdrop_name: string;
  amount: number;
  date: string;
}

/** history.db (TON) → mrkt.db sales (nano). Читает и старую широкую таблицу, и сжатую. */
export function importSalesFromHistoryDb(): number {
  if (!existsSync(HISTORY_DB_FILE)) return 0;

  const hist = new Database(HISTORY_DB_FILE, { readonly: true });
  const cols = new Set(
    (hist.prepare('PRAGMA table_info(sales)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const amountSql = cols.has('sale_price')
    ? 'CASE WHEN amount > 0 THEN amount ELSE sale_price END'
    : 'amount';
  const rows = hist
    .prepare(
      `
    SELECT
      id,
      collection_name,
      model_name,
      backdrop_name,
      ${amountSql} AS amount,
      date
    FROM sales
  `,
    )
    .all() as HistorySaleRow[];
  hist.close();

  let added = 0;
  const tx = db.transaction((batch: HistorySaleRow[]) => {
    for (const r of batch) {
      const info = insertMrktSale.run({
        id: r.id,
        collection_name: r.collection_name,
        model_name: r.model_name,
        backdrop_name: r.backdrop_name ?? '',
        amount_nano: Math.round(r.amount * NANO),
        ts: isoToTs(r.date),
      });
      if (info.changes > 0) added++;
    }
  });
  tx(rows);
  return added;
}

export function countMrktSales(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM sales').get() as { c: number };
  return row.c;
}
