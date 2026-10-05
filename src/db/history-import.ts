import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { NANO } from '../types.js';
import { HISTORY_DB_FILE } from '../history-db.js';
import { db } from './index.js';
import { isoToTs } from './storage.js';

const insertMrktSale = db.prepare(`
  INSERT OR IGNORE INTO sales (
    id, collection_name, model_name, backdrop_name, symbol_name,
    gift_number, amount_nano, date, ts, raw_json
  ) VALUES (
    @id, @collection_name, @model_name, @backdrop_name, @symbol_name,
    @gift_number, @amount_nano, @date, @ts, @raw_json
  )
`);

interface HistorySaleRow {
  id: string;
  collection_name: string;
  model_name: string;
  backdrop_name: string;
  symbol_name: string;
  number: number;
  amount: number;
  sale_price: number;
  date: string;
  received_date: string;
}

/** history.db (TON) → mrkt.db sales (nano) */
export function importSalesFromHistoryDb(): number {
  if (!existsSync(HISTORY_DB_FILE)) return 0;

  const hist = new Database(HISTORY_DB_FILE, { readonly: true });
  const rows = hist
    .prepare(
      `
    SELECT
      id, collection_name, model_name, backdrop_name, symbol_name,
      number, amount, sale_price, date, received_date
    FROM sales
  `,
    )
    .all() as HistorySaleRow[];
  hist.close();

  let added = 0;
  const tx = db.transaction((batch: HistorySaleRow[]) => {
    for (const r of batch) {
      const amountNano = Math.round(
        (r.amount > 0 ? r.amount : r.sale_price) * NANO,
      );
      const raw_json = JSON.stringify({
        gift: { receivedDate: r.received_date },
      });
      const info = insertMrktSale.run({
        id: r.id,
        collection_name: r.collection_name,
        model_name: r.model_name,
        backdrop_name: r.backdrop_name,
        symbol_name: r.symbol_name,
        gift_number: r.number,
        amount_nano: amountNano,
        date: r.date,
        ts: isoToTs(r.date),
        raw_json,
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
