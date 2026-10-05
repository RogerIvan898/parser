import {
  initClient,
  fetchBalanceWithRetry,
  fetchCollectionsWithRetry,
  fetchModelsWithRetry,
  fetchSalingWithRetry,
  fetchFeedWithRetry,
  fetchAllFeed,
  makeDefaultSalingRequest,
  makeDefaultFeedRequest,
  rarestModel,
  priciestModel,
  sortByVolume,
  onlyNew,
  floorDropped,
  averagePrice,
  cheapestSale,
  priciestSale,
  groupByDay,
} from './client.js';
import { parseInitData } from './auth.js';
import { nanoToTon, formatTon } from './types.js';

async function main() {
  // ============================================================
  // 0. Аутентификация
  // ============================================================
  console.log('=== Аутентификация ===');

  // Если в .env есть TG_INIT_DATA — покажем, что внутри
  const initData = process.env.TG_INIT_DATA?.trim();
  if (initData) {
    const parsed = parseInitData(initData);
    console.log(`query_id:  ${parsed.queryId}`);
    console.log(`auth_date: ${parsed.authDate}`);
    console.log(`user:      ${parsed.user?.username} (id=${parsed.user?.id})`);
    console.log(`hash:      ${parsed.hash?.slice(0, 16)}...`);
  } else {
    console.log(
      'TG_INIT_DATA не задан — токен из config/auth.json или вход через Telegram',
    );
  }

  await initClient();
  console.log('[main] клиент инициализирован\n');

  // ============================================================
  // 1. Баланс
  // ============================================================
  console.log('=== Баланс ===');
  const bal = await fetchBalanceWithRetry();
  console.log(`soft:        ${bal.soft}`);
  console.log(`hard:        ${bal.hard} nanoTON = ${nanoToTon(bal.hard)} TON`);
  console.log(`totalHard:   ${bal.totalHard} nanoTON = ${nanoToTon(bal.totalHard)} TON`);
  console.log(`hardLocked:  ${bal.hardLocked} nanoTON = ${nanoToTon(bal.hardLocked)} TON`);
  console.log(`stars:       ${bal.stars}`);
  console.log(`spices:      ${bal.spices}`);
  console.log(`bonus:       ${bal.bonus}`);
  console.log(`nanoUSDs:    ${bal.nanoUSDs} (locked: ${bal.nanoUSDsLocked})`);
  console.log(`luckyBuyCards: ${bal.luckyBuyCards}`);
  console.log(`stackingPoints: ${bal.stackingPoints}`);
  console.log(`giftStakingPoints: ${bal.giftStakingPoints}`);
  console.log(`friendsCount: ${bal.friendsCount}`);

  // ============================================================
  // 2. Коллекции
  // ============================================================
  console.log('\n=== Коллекции ===');
  const collections = await fetchCollectionsWithRetry();
  console.log(`Всего коллекций: ${collections.length}`);

  const top10 = sortByVolume(collections).slice(0, 10);
  console.log('\nТоп-10 по объёму:');
  for (const c of top10) {
    const floor =
      c.floorPriceNanoTons != null
        ? `${formatTon(c.floorPriceNanoTons, 3)} TON`
        : '—';
    console.log(
      `  ${c.title.padEnd(20)} floor=${floor.padEnd(14)} volume=${formatTon(c.volume, 2)} TON`,
    );
  }

  const newOnes = onlyNew(collections);
  console.log(`\nНовых коллекций: ${newOnes.length}`);

  const dropped = floorDropped(collections);
  console.log(`Коллекций с просадкой floor за день: ${dropped.length}`);

  // ============================================================
  // 3. Модели конкретной коллекции
  // ============================================================
  console.log('\n=== Модели "Signet Ring" ===');
  const models = await fetchModelsWithRetry(['Signet Ring']);
  console.log(`Моделей: ${models.length}`);

  const rarest = rarestModel(models);
  const priciest = priciestModel(models);
  if (rarest) {
    console.log(
      `Самая редкая: ${rarest.modelTitle} (rarity=${rarest.rarityPerMille}‰)`,
    );
  }
  if (priciest && priciest.floorPriceNanoTons != null) {
    console.log(
      `Самая дорогая по floor: ${priciest.modelTitle} (${formatTon(priciest.floorPriceNanoTons, 2)} TON)`,
    );
  }

  console.log('\nТоп-10 самых редких моделей:');
  const byRarity = [...models].sort(
    (a, b) => a.rarityPerMille - b.rarityPerMille,
  );
  for (const m of byRarity.slice(0, 10)) {
    const floor =
      m.floorPriceNanoTons != null
        ? `${formatTon(m.floorPriceNanoTons, 2)} TON`
        : '—';
    console.log(
      `  ${m.modelTitle.padEnd(16)} rarity=${String(m.rarityPerMille).padStart(3)}‰  floor=${floor}`,
    );
  }

  // ============================================================
  // 4. Saling: лоты на продажу
  // ============================================================
  console.log('\n=== Лоты на маркете (первые 20) ===');
  const salingBody = makeDefaultSalingRequest({ count: 20 });
  const saling = await fetchSalingWithRetry(salingBody);
  console.log(`Всего на маркете: ${saling.total}, получено: ${saling.gifts.length}`);

  for (const g of saling.gifts.slice(0, 5)) {
    console.log(
      `  ${g.collectionTitle} / ${g.modelTitle} ` +
        `(#${g.number}) — ${formatTon(g.salePrice, 2)} TON`,
    );
  }

  // ============================================================
  // 5. Feed: история продаж конкретной модели
  // ============================================================
  console.log('\n=== Feed: Signet Ring / Skibidi ===');

  const feedBody = makeDefaultFeedRequest({
    count: 20,
    collectionNames: ['Signet Ring'],
    modelNames: ['Skibidi'],
    type: ['Sale'],
  });

  const feed = await fetchFeedWithRetry(feedBody);
  console.log(`Страница 1: ${feed.items.length} событий, cursor=${feed.cursor}`);

  for (const it of feed.items.slice(0, 5)) {
    console.log(
      `  ${it.date}  ${it.type}  #${it.gift.number}  ` +
        `backdrop=${it.gift.backdropName}  ` +
        `amount=${formatTon(it.amount, 2)} TON`,
    );
  }

  // ============================================================
  // 6. Feed: обход по курсору
  // ============================================================
  console.log('\n=== Собираем всю историю Signet Ring / Skibidi ===');
  const allSales = await fetchAllFeed('Signet Ring', 'Skibidi', {
    types: ['Sale'],
    maxPages: 10,
    delayMs: 300,
    onPage: (page, count, cursor) =>
      console.log(`  [page ${page}] ${count} событий, cursor=${cursor ?? 'null'}`),
  });

  console.log(`Всего собрано: ${allSales.length}`);

  if (allSales.length > 0) {
    const avg30 = averagePrice(allSales, 30);
    const cheapest = cheapestSale(allSales);
    const priciestSaleItem = priciestSale(allSales);

    if (avg30 != null) {
      console.log(`Средняя цена за 30 дней: ${formatTon(avg30, 2)} TON`);
    }
    if (cheapest) {
      console.log(
        `Самая дешёвая продажа: ${formatTon(cheapest.amount, 2)} TON (${cheapest.date})`,
      );
    }
    if (priciestSaleItem) {
      console.log(
        `Самая дорогая продажа: ${formatTon(priciestSaleItem.amount, 2)} TON (${priciestSaleItem.date})`,
      );
    }

    const byDay = groupByDay(allSales);
    console.log('\nПродажи по дням (последние 5 дней):');
    const days = [...byDay.keys()].sort().reverse().slice(0, 5);
    for (const day of days) {
      const items = byDay.get(day)!;
      const total = items.reduce((s, i) => s + i.amount, 0);
      console.log(`  ${day}: ${items.length} шт., сумма ${formatTon(total, 2)} TON`);
    }
  }

  // ============================================================
  // 7. Пример: ищем лоты дешевле средней
  // ============================================================
  console.log('\n=== Лоты Skibidi дешевле средней цены за 30 дней ===');
  const avg = averagePrice(allSales, 30);

  if (avg != null) {
    const listing = await fetchSalingWithRetry(
      makeDefaultSalingRequest({
        count: 20,
        collectionNames: ['Signet Ring'],
        modelNames: ['Skibidi'],
        ordering: 'Price',
        lowToHigh: true,
      }),
    );

    for (const g of listing.gifts) {
      const discount = 1 - g.salePrice / avg;
      if (discount > 0) {
        console.log(
          `  лот #${g.number}: ${formatTon(g.salePrice, 2)} TON ` +
            `(${(discount * 100).toFixed(1)}% дешевле средней)`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});