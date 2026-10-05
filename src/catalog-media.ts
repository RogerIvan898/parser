import { existsSync } from 'node:fs';
import { loadMarket, MARKET_FILE } from './store.js';

export interface CatalogMedia {
  collectionThumbnails: Record<string, string>;
  modelThumbnails: Record<string, Record<string, string>>;
}

const empty: CatalogMedia = {
  collectionThumbnails: {},
  modelThumbnails: {},
};

/** Превью коллекций/моделей из последних точек market.json */
export function loadCatalogMedia(): CatalogMedia {
  if (!existsSync(MARKET_FILE)) return empty;

  const market = loadMarket();
  const modelThumbnails: Record<string, Record<string, string>> = {};
  const collectionThumbnails: Record<string, string> = {};

  for (const points of Object.values(market.models)) {
    if (!points.length) continue;
    const p = points[points.length - 1]!;
    const key = p.modelStickerThumbnailKey;
    if (!key) continue;
    const col = p.collectionName;
    const model = p.modelName;
    if (!modelThumbnails[col]) modelThumbnails[col] = {};
    modelThumbnails[col][model] = key;
    if (!collectionThumbnails[col]) collectionThumbnails[col] = key;
  }

  return { collectionThumbnails, modelThumbnails };
}
