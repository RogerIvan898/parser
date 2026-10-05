/**
 * Заполнить catalog.json моделями и превью из market.json без API
 * npm run catalog:hydrate
 */
import {
  loadCatalog,
  loadMarket,
  saveCatalog,
  hydrateCatalogFromMarket,
  listCatalogCollections,
} from './store.js';

const catalog = loadCatalog();
const market = loadMarket();
const before = listCatalogCollections(catalog).reduce(
  (n, c) => n + (catalog.collections[c]?.length ?? 0),
  0,
);
const h = hydrateCatalogFromMarket(catalog, market);
saveCatalog(catalog);
const after = listCatalogCollections(catalog).reduce(
  (n, c) => n + (catalog.collections[c]?.length ?? 0),
  0,
);

console.log('=== catalog hydrate from market.json ===');
console.log(`моделей в списках: ${before} → ${after}`);
console.log(`+${h.modelsAdded} имён, превью заполнено: ${h.thumbsFilled}`);
