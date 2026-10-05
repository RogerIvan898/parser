import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Collection, FeedItem, GiftBackdrop, Model } from './types.js';

/** Bothost задаёт DATA_DIR=/app/data — это единственный каталог, который живёт между деплоями. */
const dataDirFromEnv = process.env.DATA_DIR?.trim();
export const DATA_DIR = dataDirFromEnv
  ? resolve(dataDirFromEnv)
  : resolve(process.cwd(), 'data');
export const CATALOG_FILE = resolve(DATA_DIR, 'catalog.json');
export const MARKET_FILE = resolve(DATA_DIR, 'market.json');

/** Не дергать API по коллекции/модели чаще чем раз в 24 часа */
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** @deprecated используй COOLDOWN_MS */
export const COLLECTION_COOLDOWN_MS = COOLDOWN_MS;

/** Каталог: имена + ключи превью с API MRKT (cdn.tgmrkt.io) */
export interface CatalogStore {
  version: 2;
  updatedAt: string;
  collections: Record<string, string[]>;
  /** collection name → gifts/collections/…-thumb.webp или sticker key */
  collectionThumbnails: Record<string, string>;
  /** collection → model → gifts/stickers/thumbnails/….webp */
  modelThumbnails: Record<string, Record<string, string>>;
  /** collection → фоны с MRKT POST /gifts/backdrops */
  backdrops: Record<string, CatalogBackdrop[]>;
}

/** Запись фона в catalog.json (поля как в API) */
export type CatalogBackdrop = GiftBackdrop;

/** Снимок коллекции в market.json */
export interface CollectionMarketPoint {
  at: string;
  name: string;
  volume: number;
  floorPriceNanoTons: number | null;
  previousDayFloorPriceNanoTons: number | null;
}

/** Снимок модели в market.json */
export interface ModelMarketPoint {
  at: string;
  cashbackCoef: number | null;
  collectionName: string;
  collectionTitle: string;
  createdAt: string;
  floorPriceNanoTons: number | null;
  modelName: string;
  modelStickerThumbnailKey: string;
  modelTitle: string;
  rarityName: string | null;
  rarityPerMille: number;
  volume: number | null;
}

export interface MarketStore {
  version: 2;
  updatedAt: string;
  collections: Record<string, CollectionMarketPoint[]>;
  models: Record<string, ModelMarketPoint[]>;
}

/** Компактная запись продажи (SQLite history.db) */
export interface StoredFeedGift {
  id: string;
  exportDate: string;
  receivedDate: string;
  giftId: number;
  backdropColorsCenterColor: number;
  backdropColorsEdgeColor: number;
  backdropColorsTextColor: number;
  backdropColorsSymbolColor: number;
  backdropName: string;
  modelName: string;
  modelStickerKey: string;
  modelStickerThumbnailKey: string;
  symbolName: string;
  symbolStickerKey: string;
  symbolStickerThumbnailKey: string;
  name: string;
  number: number;
  collectionName: string;
  salePrice: number;
  salesCount: number;
  isLocked: boolean;
  isLockedForSale: boolean;
  unlockDate: string;
  nextGiveAvailableAt: string;
  premarketStatus: string;
  waitGiftUntil: string | null;
  giftsCollectionId: string | null;
  giftType: string;
  collectionTitle: string;
  modelTitle: string;
  returnLockedUntil: string | null;
  returnLockReason: string | null;
  spaceMonkeysPoints: number | null;
  floorPriceNanoTONsByCollection: number | null;
  floorPriceNanoTONsByBackdropModel: number | null;
  minted: boolean;
}

export interface StoredFeedSale {
  id: string;
  gift: StoredFeedGift;
  amount: number;
  date: string;
}

export function toStoredFeedSale(item: FeedItem): StoredFeedSale {
  const g = item.gift;
  return {
    id: item.id,
    gift: {
      id: g.id,
      exportDate: g.exportDate,
      receivedDate: g.receivedDate,
      giftId: g.giftId,
      backdropColorsCenterColor: g.backdropColorsCenterColor,
      backdropColorsEdgeColor: g.backdropColorsEdgeColor,
      backdropColorsTextColor: g.backdropColorsTextColor,
      backdropColorsSymbolColor: g.backdropColorsSymbolColor,
      backdropName: g.backdropName,
      modelName: g.modelName,
      modelStickerKey: g.modelStickerKey,
      modelStickerThumbnailKey: g.modelStickerThumbnailKey,
      symbolName: g.symbolName,
      symbolStickerKey: g.symbolStickerKey,
      symbolStickerThumbnailKey: g.symbolStickerThumbnailKey,
      name: g.name,
      number: g.number,
      collectionName: g.collectionName,
      salePrice: g.salePrice,
      salesCount: g.salesCount,
      isLocked: g.isLocked,
      isLockedForSale: g.isLockedForSale,
      unlockDate: g.unlockDate,
      nextGiveAvailableAt: g.nextGiveAvailableAt,
      premarketStatus: g.premarketStatus,
      waitGiftUntil: g.waitGiftUntil,
      giftsCollectionId: g.giftsCollectionId,
      giftType: g.giftType,
      collectionTitle: g.collectionTitle,
      modelTitle: g.modelTitle,
      returnLockedUntil: g.returnLockedUntil,
      returnLockReason: g.returnLockReason,
      spaceMonkeysPoints: g.spaceMonkeysPoints,
      floorPriceNanoTONsByCollection: g.floorPriceNanoTONsByCollection,
      floorPriceNanoTONsByBackdropModel: g.floorPriceNanoTONsByBackdropModel,
      minted: g.minted,
    },
    amount: item.amount,
    date: item.date,
  };
}

export function modelKey(collectionName: string, modelName: string): string {
  return `${collectionName}::${modelName}`;
}

function emptyCatalog(): CatalogStore {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    collections: {},
    collectionThumbnails: {},
    modelThumbnails: {},
    backdrops: {},
  };
}

function normalizeCatalog(raw: CatalogStore): CatalogStore {
  const catalog = { ...emptyCatalog(), ...raw };
  catalog.collections = raw.collections ?? {};
  catalog.collectionThumbnails = raw.collectionThumbnails ?? {};
  catalog.modelThumbnails = raw.modelThumbnails ?? {};
  catalog.backdrops = raw.backdrops ?? {};
  catalog.version = 2;
  return catalog;
}

function emptyMarket(): MarketStore {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    collections: {},
    models: {},
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadCatalog(): CatalogStore {
  if (!existsSync(CATALOG_FILE)) return emptyCatalog();
  try {
    const raw = JSON.parse(readFileSync(CATALOG_FILE, 'utf-8')) as CatalogStore;
    return normalizeCatalog(raw);
  } catch {
    return emptyCatalog();
  }
}

export function saveCatalog(store: CatalogStore): void {
  pruneCatalogStore(store);
  store.updatedAt = new Date().toISOString();
  writeJson(CATALOG_FILE, store);
}

export function loadMarket(): MarketStore {
  if (!existsSync(MARKET_FILE)) return emptyMarket();
  try {
    const data = JSON.parse(readFileSync(MARKET_FILE, 'utf-8')) as MarketStore;
    if (data.version !== 2) return emptyMarket();
    return data;
  } catch {
    return emptyMarket();
  }
}

export function saveMarket(store: MarketStore): void {
  store.updatedAt = new Date().toISOString();
  writeJson(MARKET_FILE, store);
}

export function ensureCatalogCollection(
  catalog: CatalogStore,
  collectionName: string,
): boolean {
  if (catalog.collections[collectionName]) return false;
  catalog.collections[collectionName] = [];
  return true;
}

/** Превью коллекции из GET /gifts/collections */
export function syncCollectionThumbnails(
  catalog: CatalogStore,
  col: Collection,
): void {
  ensureCatalogCollection(catalog, col.name);
  const key =
    col.thumbnailImageKey?.trim() ||
    col.modelStickerThumbnailKey?.trim() ||
    '';
  if (key) catalog.collectionThumbnails[col.name] = key;
}

/** Превью моделей из GET /gifts/models */
export function isJunkCatalogKey(name: string): boolean {
  return name.length === 0 || /^\d+$/.test(name);
}

/** Убрать числовые мусорные ключи коллекций */
export function pruneCatalogStore(catalog: CatalogStore): void {
  for (const key of Object.keys(catalog.collections)) {
    if (!isJunkCatalogKey(key)) continue;
    delete catalog.collections[key];
    delete catalog.collectionThumbnails[key];
    delete catalog.modelThumbnails[key];
    delete catalog.backdrops[key];
  }
}

/** Восстановить списки моделей и превью из market.json (последняя точка по каждой паре) */
export function hydrateCatalogFromMarket(
  catalog: CatalogStore,
  market: MarketStore,
): { modelsAdded: number; thumbsFilled: number } {
  let modelsAdded = 0;
  let thumbsFilled = 0;

  for (const points of Object.values(market.models)) {
    if (!points.length) continue;
    const last = points[points.length - 1]!;
    const col = last.collectionName;
    const model = last.modelName;
    if (isJunkCatalogKey(col) || isJunkCatalogKey(model)) continue;

    ensureCatalogCollection(catalog, col);
    const list = catalog.collections[col];
    if (!list.includes(model)) {
      list.push(model);
      modelsAdded++;
    }

    const key = last.modelStickerThumbnailKey?.trim();
    if (key) {
      if (!catalog.modelThumbnails[col]) catalog.modelThumbnails[col] = {};
      if (!catalog.modelThumbnails[col][model]) thumbsFilled++;
      catalog.modelThumbnails[col][model] = key;
    }
  }

  for (const col of Object.keys(catalog.collections)) {
    catalog.collections[col].sort();
  }

  return { modelsAdded, thumbsFilled };
}

export function syncCollectionBackdrops(
  catalog: CatalogStore,
  collectionName: string,
  items: GiftBackdrop[],
): void {
  if (!catalog.backdrops) catalog.backdrops = {};
  const sorted = [...items].sort((a, b) =>
    a.backdropName.localeCompare(b.backdropName, 'ru'),
  );
  catalog.backdrops[collectionName] = sorted;
}

export function syncModelThumbnails(
  catalog: CatalogStore,
  collectionName: string,
  models: Model[],
): void {
  if (!catalog.modelThumbnails[collectionName]) {
    catalog.modelThumbnails[collectionName] = {};
  }
  const map = catalog.modelThumbnails[collectionName];
  for (const m of models) {
    const key = m.modelStickerThumbnailKey?.trim();
    if (key) map[m.modelName] = key;
  }
}

export function addCatalogModels(
  catalog: CatalogStore,
  collectionName: string,
  modelNames: string[],
): number {
  if (!catalog.collections[collectionName]) {
    catalog.collections[collectionName] = [];
  }
  const list = catalog.collections[collectionName];
  let added = 0;
  for (const name of modelNames) {
    if (/^\d+$/.test(name)) continue;
    if (list.includes(name)) continue;
    list.push(name);
    added++;
  }
  return added;
}

/** Имена коллекций из каталога (без мусорных числовых ключей) */
export function listCatalogCollections(catalog: CatalogStore): string[] {
  return Object.keys(catalog.collections)
    .filter((n) => !isJunkCatalogKey(n))
    .sort();
}

/** Пары коллекция + модель для обхода feed (порядок: коллекции A→Z, модели A→Z) */
export function listCatalogModelTasks(
  catalog: CatalogStore,
): { collectionName: string; modelName: string }[] {
  const out: { collectionName: string; modelName: string }[] = [];
  for (const collectionName of listCatalogCollections(catalog)) {
    const models = catalog.collections[collectionName] ?? [];
    for (const modelName of [...models].sort()) {
      if (/^\d+$/.test(modelName)) continue;
      out.push({ collectionName, modelName });
    }
  }
  return out;
}

export function toCollectionMarketPoint(
  col: Collection,
  at: string,
): CollectionMarketPoint {
  return {
    at,
    name: col.name,
    volume: col.volume,
    floorPriceNanoTons: col.floorPriceNanoTons,
    previousDayFloorPriceNanoTons: col.previousDayFloorPriceNanoTons,
  };
}

export function toModelMarketPoint(model: Model, at: string): ModelMarketPoint {
  return {
    at,
    cashbackCoef: model.cashbackCoef,
    collectionName: model.collectionName,
    collectionTitle: model.collectionTitle,
    createdAt: model.createdAt,
    floorPriceNanoTons: model.floorPriceNanoTons,
    modelName: model.modelName,
    modelStickerThumbnailKey: model.modelStickerThumbnailKey,
    modelTitle: model.modelTitle,
    rarityName: model.rarityName,
    rarityPerMille: model.rarityPerMille,
    volume: model.volume,
  };
}

export function getLastCollectionParsedAt(
  market: MarketStore,
  collectionName: string,
): string | null {
  const history = market.collections[collectionName];
  if (!history?.length) return null;
  return history[history.length - 1].at;
}

export function isCollectionOnCooldown(
  market: MarketStore,
  collectionName: string,
): boolean {
  const lastAt = getLastCollectionParsedAt(market, collectionName);
  if (!lastAt) return false;
  const elapsed = Date.now() - new Date(lastAt).getTime();
  return elapsed < COOLDOWN_MS;
}

export function appendCollectionMarketPoint(
  market: MarketStore,
  col: Collection,
  at: string = new Date().toISOString(),
): void {
  const list = market.collections[col.name] ?? [];
  list.push(toCollectionMarketPoint(col, at));
  market.collections[col.name] = list;
}

export function appendModelMarketPoint(
  market: MarketStore,
  model: Model,
  at: string = new Date().toISOString(),
): void {
  const key = modelKey(model.collectionName, model.modelName);
  const list = market.models[key] ?? [];
  list.push(toModelMarketPoint(model, at));
  market.models[key] = list;
}

export function iterCatalogModels(
  catalog: CatalogStore,
): { collectionName: string; modelName: string }[] {
  const out: { collectionName: string; modelName: string }[] = [];
  const collections = Object.keys(catalog.collections).sort();
  for (const collectionName of collections) {
    const models = [...catalog.collections[collectionName]].sort();
    for (const modelName of models) {
      out.push({ collectionName, modelName });
    }
  }
  return out;
}
