import { existsSync } from 'node:fs';
import type { Collection, Model } from '../types.js';
import {
  loadMarket,
  MARKET_FILE,
  type CollectionMarketPoint,
  type MarketStore,
  type ModelMarketPoint,
} from '../store.js';
import { db } from './index.js';
import {
  isoToTs,
  saveCollectionPrices,
  saveModelPrices,
  upsertCollections,
  upsertModels,
} from './storage.js';

function stubCollection(name: string, title = name): Collection {
  return {
    name,
    title,
    modelStickerThumbnailKey: '',
    originalImageKey: '',
    thumbnailImageKey: '',
    createdAt: '',
    floorPriceNanoTons: null,
    floorPriceForGamesNanoTons: null,
    previousDayFloorPriceNanoTons: null,
    volume: 0,
    isNew: false,
    isNewDate: '',
    cashbackCoef: null,
    spiceConvertPrice: 0,
    spaceMonkeyPoints: null,
    disabledCraftFrom: false,
    craftable: false,
    isHidden: false,
    tgCraftable: false,
  };
}

function modelPointToStub(m: ModelMarketPoint): Model {
  return {
    collectionName: m.collectionName,
    collectionTitle: m.collectionTitle,
    modelName: m.modelName,
    modelTitle: m.modelTitle,
    modelStickerThumbnailKey: m.modelStickerThumbnailKey,
    createdAt: m.createdAt,
    rarityPerMille: m.rarityPerMille,
    rarityName: m.rarityName,
    volume: m.volume,
    floorPriceNanoTons: m.floorPriceNanoTons,
    cashbackCoef: m.cashbackCoef,
  };
}

/** Снимок одной коллекции после parse → mrkt.db */
export function syncCollectionSnapshot(col: Collection, atIso: string): void {
  upsertCollections([col]);
  saveCollectionPrices(
    col.name,
    col.floorPriceNanoTons,
    col.volume,
    col.previousDayFloorPriceNanoTons,
    isoToTs(atIso),
  );
}

/** Снимки моделей одной коллекции после parse → mrkt.db */
export function syncModelSnapshots(models: Model[], atIso: string): void {
  if (models.length === 0) return;
  upsertModels(models);
  const ts = isoToTs(atIso);
  for (const m of models) {
    saveModelPrices(
      m.collectionName,
      m.modelName,
      m.floorPriceNanoTons,
      m.volume,
      ts,
    );
  }
}

function insertCollectionPoint(p: CollectionMarketPoint): void {
  upsertCollections([stubCollection(p.name)]);
  saveCollectionPrices(
    p.name,
    p.floorPriceNanoTons,
    p.volume,
    p.previousDayFloorPriceNanoTons,
    isoToTs(p.at),
  );
}

function insertModelPoint(p: ModelMarketPoint): void {
  upsertModels([modelPointToStub(p)]);
  saveModelPrices(
    p.collectionName,
    p.modelName,
    p.floorPriceNanoTons,
    p.volume,
    isoToTs(p.at),
  );
}

export interface MarketImportStats {
  collectionPoints: number;
  modelPoints: number;
}

/** Залить весь market.json в mrkt.db (идемпотентно по INSERT, дубли ts возможны) */
export function importMarketJsonToDb(market: MarketStore): MarketImportStats {
  let collectionPoints = 0;
  let modelPoints = 0;

  const tx = db.transaction(() => {
    for (const points of Object.values(market.collections)) {
      for (const p of points) {
        insertCollectionPoint(p);
        collectionPoints++;
      }
    }
    for (const points of Object.values(market.models)) {
      for (const p of points) {
        insertModelPoint(p);
        modelPoints++;
      }
    }
  });
  tx();

  return { collectionPoints, modelPoints };
}

export function importMarketFileIfExists(): MarketImportStats | null {
  if (!existsSync(MARKET_FILE)) return null;
  return importMarketJsonToDb(loadMarket());
}

export function countCollectionPriceRows(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM collection_prices').get() as {
    c: number;
  };
  return row.c;
}

/** Точки floor из market.json (если parse ещё не залил SQLite) */
export function collectionPriceHistoryFromMarketFile(
  collectionName: string,
  sinceTs: number,
): { ts: number; floor_nano: number | null }[] {
  if (!existsSync(MARKET_FILE)) return [];
  const market = loadMarket();
  const points = market.collections[collectionName] ?? [];
  return points
    .filter((p) => isoToTs(p.at) >= sinceTs)
    .map((p) => ({
      ts: isoToTs(p.at),
      floor_nano: p.floorPriceNanoTons,
    }))
    .sort((a, b) => a.ts - b.ts);
}

export function modelPriceHistoryFromMarketFile(
  collectionName: string,
  modelName: string,
  sinceTs: number,
): { ts: number; floor_nano: number | null }[] {
  if (!existsSync(MARKET_FILE)) return [];
  const market = loadMarket();
  const key = `${collectionName}::${modelName}`;
  const points = market.models[key] ?? [];
  return points
    .filter((p) => isoToTs(p.at) >= sinceTs)
    .map((p) => ({
      ts: isoToTs(p.at),
      floor_nano: p.floorPriceNanoTons,
    }))
    .sort((a, b) => a.ts - b.ts);
}
