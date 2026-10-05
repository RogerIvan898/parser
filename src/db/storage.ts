import type { Collection, FeedItem, Model } from '../types.js';
import { db } from './index.js';

export function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

export function isoToTs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
}

export function upsertCollections(collections: Collection[]): void {
  const stmt = db.prepare(`
    INSERT INTO collections (name, title, updated_at)
    VALUES (@name, @title, @updated_at)
    ON CONFLICT(name) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows: Collection[]) => {
    const ts = nowTs();
    for (const c of rows) {
      stmt.run({ name: c.name, title: c.title, updated_at: ts });
    }
  });
  tx(collections);
}

export function upsertModels(models: Model[]): void {
  const stmt = db.prepare(`
    INSERT INTO models (collection_name, model_name, model_title, updated_at)
    VALUES (@collection_name, @model_name, @model_title, @updated_at)
    ON CONFLICT(collection_name, model_name) DO UPDATE SET
      model_title = excluded.model_title,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows: Model[]) => {
    const ts = nowTs();
    for (const m of rows) {
      stmt.run({
        collection_name: m.collectionName,
        model_name: m.modelName,
        model_title: m.modelTitle,
        updated_at: ts,
      });
    }
  });
  tx(models);
}

export function saveCollectionPrices(
  collectionName: string,
  floorNano: number | null,
  volumeNano: number | null,
  prevDayFloorNano: number | null,
  ts = nowTs(),
): void {
  db.prepare(`
    INSERT INTO collection_prices (
      collection_name, ts, floor_nano, volume_nano, prev_day_floor_nano
    ) VALUES (?, ?, ?, ?, ?)
  `).run(collectionName, ts, floorNano, volumeNano, prevDayFloorNano);
}

export function saveModelPrices(
  collectionName: string,
  modelName: string,
  floorNano: number | null,
  volumeNano: number | null,
  ts = nowTs(),
): void {
  db.prepare(`
    INSERT INTO model_prices (
      collection_name, model_name, ts, floor_nano, volume_nano
    ) VALUES (?, ?, ?, ?, ?)
  `).run(collectionName, modelName, ts, floorNano, volumeNano);

  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO model_prices_daily (collection_name, model_name, day, floor_nano)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(collection_name, model_name, day) DO UPDATE SET
      floor_nano = excluded.floor_nano
  `).run(collectionName, modelName, day, floorNano);
}

export function saveSales(items: FeedItem[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sales (
      id, collection_name, model_name, backdrop_name, amount_nano, ts
    ) VALUES (
      @id, @collection_name, @model_name, @backdrop_name, @amount_nano, @ts
    )
  `);
  let added = 0;
  const tx = db.transaction((rows: FeedItem[]) => {
    for (const item of rows) {
      const g = item.gift;
      const collectionName = g.collectionName || g.title;
      const modelName = g.modelName;
      if (!collectionName || !modelName) continue;
      const info = stmt.run({
        id: item.id,
        collection_name: collectionName,
        model_name: modelName,
        backdrop_name: g.backdropName ?? '',
        amount_nano: item.amount,
        ts: isoToTs(item.date),
      });
      if (info.changes > 0) added++;
    }
  });
  tx(items);
  return added;
}

export interface FallingModelRow {
  collection_name: string;
  model_name: string;
  start_floor_nano: number;
  end_floor_nano: number;
  drop_pct: number;
}

export function topFallingModels(
  days = 7,
  limit = 20,
): FallingModelRow[] {
  return db
    .prepare(
      `
    WITH ranked AS (
      SELECT
        collection_name,
        model_name,
        day,
        floor_nano,
        ROW_NUMBER() OVER (
          PARTITION BY collection_name, model_name ORDER BY day ASC
        ) AS rn_first,
        ROW_NUMBER() OVER (
          PARTITION BY collection_name, model_name ORDER BY day DESC
        ) AS rn_last
      FROM model_prices_daily
      WHERE day >= date('now', '-' || ? || ' days')
    ),
    ends AS (
      SELECT
        collection_name,
        model_name,
        MAX(CASE WHEN rn_first = 1 THEN floor_nano END) AS start_floor,
        MAX(CASE WHEN rn_last = 1 THEN floor_nano END) AS end_floor
      FROM ranked
      GROUP BY collection_name, model_name
    )
    SELECT
      collection_name,
      model_name,
      start_floor AS start_floor_nano,
      end_floor AS end_floor_nano,
      (start_floor - end_floor) * 1.0 / start_floor AS drop_pct
    FROM ends
    WHERE start_floor IS NOT NULL
      AND start_floor > 0
      AND end_floor IS NOT NULL
    ORDER BY drop_pct DESC
    LIMIT ?
  `,
    )
    .all(days, limit) as FallingModelRow[];
}
