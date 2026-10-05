/**
 * Ручная синхронизация mrkt.db из market.json и history.db
 * npm run sync-db
 */
import 'dotenv/config';
import {
  countCollectionPriceRows,
  importMarketFileIfExists,
} from './db/market-sync.js';
import {
  countMrktSales,
  importSalesFromHistoryDb,
} from './db/history-import.js';

const pricesBefore = countCollectionPriceRows();
const salesBefore = countMrktSales();

const market =
  pricesBefore === 0 ? importMarketFileIfExists() : null;
const salesAdded = importSalesFromHistoryDb();

console.log('=== sync mrkt.db ===');
console.log(
  `collection_prices: было ${pricesBefore}, стало ${countCollectionPriceRows()}` +
    (market
      ? ` (+${market.collectionPoints} col / +${market.modelPoints} model из json)`
      : ' (market.json нет)'),
);
console.log(
  `sales: было ${salesBefore}, стало ${countMrktSales()} (+${salesAdded} из history.db)`,
);
