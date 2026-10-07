import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  initClient,
  fetchCollectionsWithRetry,
  fetchModelsWithRetry,
  fetchBackdropsWithRetry,
  fetchFeedWithRetry,
  makeDefaultFeedRequest,
} from './client.js';
import type { Collection } from './types.js';
import {
  loadCatalog,
  saveCatalog,
  loadMarket,
  saveMarket,
  ensureCatalogCollection,
  addCatalogModels,
  syncCollectionThumbnails,
  syncModelThumbnails,
  syncCollectionBackdrops,
  hydrateCatalogFromMarket,
  pruneCatalogStore,
  isJunkCatalogKey,
  appendCollectionMarketPoint,
  appendModelMarketPoint,
  listCatalogModelTasks,
  isCollectionOnCooldown,
  getLastCollectionParsedAt,
} from './store.js';
import {
  recordParseError,
  flushParseErrors,
  printParseErrorSummary,
  getParseErrors,
} from './errors.js';
import type Database from 'better-sqlite3';
import {
  openHistoryDb,
  closeHistoryDb,
  insertFeedPage,
  countSales,
  HISTORY_DB_FILE,
} from './history-db.js';
import {
  syncCollectionSnapshot,
  syncModelSnapshots,
} from './db/market-sync.js';
import { isSaleDateOlderThanHistory, saveSales } from './db/storage.js';
import {
  isCollectionEnabledForParse,
  isHistoryFetchBackdropsEnabled,
  getHistoryFeedBackdropNames,
  countEnabledForParse,
  getEffectiveParserDelayMs,
  getParserTiming,
} from './parse-config.js';
import {
  findResumeIndex,
  loadHistoryProgress,
  saveHistoryProgress,
  HISTORY_PROGRESS_FILE,
} from './history-progress.js';

const FEED_TIMEOUT_MS = Number(process.env.PARSER_FEED_TIMEOUT_MS) || 60_000;
/** MRKT POST /feed отдаёт не больше 20 items, даже при count=100 */
export const FEED_API_PAGE_SIZE = 20;

function parserDelayMs(): number {
  return getEffectiveParserDelayMs();
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

/** Настройки feed для --history из argv */
export interface HistoryFeedConfig {
  /** Сколько продаж максимум вытянуть по одной модели за проход (курсором) */
  maxItemsPerModel: number;
  /** 1-based номер модели в очереди (как в логе 871/1000) */
  startFrom: number;
  /** true, если позицию задали флагом --from / --start, а не файлом прогресса */
  explicitStart: boolean;
}

export function parseHistoryFeedConfig(): HistoryFeedConfig {
  const bulk =
    process.argv.includes('--feed-100') || process.argv.includes('--bulk');
  const feedCountRaw = argValue('--feed-count');

  let maxItemsPerModel =
    getParserTiming().feedPages * FEED_API_PAGE_SIZE;

  if (bulk) {
    maxItemsPerModel = 100;
  } else if (feedCountRaw !== undefined) {
    const n = Number(feedCountRaw);
    if (Number.isFinite(n) && n > 0) {
      maxItemsPerModel = Math.floor(n);
    }
  }

  const fromRaw = argValue('--from') ?? argValue('--start');
  let startFrom = 1;
  const explicitStart = fromRaw !== undefined;
  if (explicitStart) {
    const n = Number(fromRaw);
    if (Number.isFinite(n) && n >= 1) startFrom = Math.floor(n);
  }

  return { maxItemsPerModel, startFrom, explicitStart };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeSave(label: string, save: () => void): boolean {
  try {
    save();
    return true;
  } catch (err) {
    recordParseError('io', label, err);
    return false;
  }
}

async function syncModelFeedPages(
  database: Database.Database,
  collectionName: string,
  modelName: string,
  backdropNames: string[],
  logLabel: string,
  round: number,
  step: string,
  maxItems: number,
  paginate: boolean,
): Promise<number> {
  let totalAdded = 0;
  let cursor = '';
  let fetched = 0;
  let page = 0;
  const maxPages = paginate
    ? Math.ceil(maxItems / FEED_API_PAGE_SIZE) + 1
    : 1;
  const backdropTag =
    backdropNames.length > 0
      ? ` backdrop=[${backdropNames.join(', ')}]`
      : '';

  while (fetched < maxItems && page < maxPages) {
    page++;
    const cursorLabel = cursor ? `${cursor.slice(0, 8)}…` : '""';
    console.log(
      `[history] круг ${round} (${step}) ${logLabel} → POST /feed${backdropTag} ` +
        `стр.${page} count=${FEED_API_PAGE_SIZE} (цель ${maxItems}, ` +
        `уже ${fetched}) cursor=${cursorLabel}`,
    );

    const t0 = Date.now();
    try {
      const res = await fetchFeedWithRetry(
        makeDefaultFeedRequest({
          count: FEED_API_PAGE_SIZE,
          cursor,
          collectionNames: [collectionName],
          modelNames: [modelName],
          backdropNames,
          type: ['Sale'],
          ordering: 'Latest',
          lowToHigh: false,
        }),
        { timeoutMs: FEED_TIMEOUT_MS, retries: 5 },
      );

      const { added, known } = insertFeedPage(database, res.items);
      try {
        saveSales(res.items);
      } catch (err) {
        recordParseError('history', `${logLabel} mrkt.db sales`, err);
      }
      totalAdded += added;
      fetched += res.items.length;
      const ms = Date.now() - t0;
      const total = countSales(database);

      console.log(
        `[history] круг ${round} (${step}) ${logLabel} стр.${page}: ` +
          `items=${res.items.length}, +${added} новых, ${ms} ms, в БД ${total} продаж`,
      );

      if (!paginate) break;

      if (res.items.some((item) => isSaleDateOlderThanHistory(item.date))) {
        console.log(
          `[history] (${step}) ${logLabel}: сделка старше 30 дней по дате покупки, дальше не листаю`,
        );
        break;
      }

      if (!res.cursor || res.items.length === 0) {
        console.log(`[history] (${step}) ${logLabel}: конец ленты`);
        break;
      }
      if (res.items.length < FEED_API_PAGE_SIZE) {
        console.log(`[history] (${step}) ${logLabel}: неполная страница, конец`);
        break;
      }
      if (known > 0) {
        console.log(
          `[history] (${step}) ${logLabel}: на стр.${page} уже есть ${known} в БД, старше не листаю`,
        );
        break;
      }
      cursor = res.cursor;
    } catch (err) {
      const msg = (err as Error).message;
      recordParseError('history', `${logLabel} page ${page}`, err);
      console.warn(
        `[history] (${step}) ${logLabel} стр.${page} ошибка: ${msg} ` +
          `(таймаут/сеть — остальные стр. пропущены, в след. круге снова с начала)`,
      );
      break;
    }

    if (fetched < maxItems) await sleep(parserDelayMs());
  }

  return totalAdded;
}

async function syncModelFeed(
  database: Database.Database,
  collectionName: string,
  modelName: string,
  round: number,
  step: string,
  feed: HistoryFeedConfig,
): Promise<number> {
  const label = `${collectionName} / ${modelName}`;
  let totalAdded = await syncModelFeedPages(
    database,
    collectionName,
    modelName,
    [],
    label,
    round,
    step,
    feed.maxItemsPerModel,
    true,
  );

  if (!isHistoryFetchBackdropsEnabled()) {
    return totalAdded;
  }

  for (const backdropName of getHistoryFeedBackdropNames()) {
    const backdropLabel = `${label} / фон «${backdropName}»`;
    totalAdded += await syncModelFeedPages(
      database,
      collectionName,
      modelName,
      [backdropName],
      backdropLabel,
      round,
      step,
      FEED_API_PAGE_SIZE,
      false,
    );
    await sleep(parserDelayMs());
  }

  return totalAdded;
}

async function syncCatalogAndMarket(writeMarket: boolean): Promise<void> {
  const catalog = loadCatalog();
  const market = loadMarket();

  console.log('[catalog] коллекции — 1 запрос API...');
  let remoteCols: Collection[];
  try {
    remoteCols = await fetchCollectionsWithRetry();
  } catch (err) {
    recordParseError('collections', 'GET /gifts/collections', err);
    throw err;
  }

  pruneCatalogStore(catalog);
  const hydrated = hydrateCatalogFromMarket(catalog, market);
  if (hydrated.modelsAdded > 0 || hydrated.thumbsFilled > 0) {
    console.log(
      `[catalog] из market.json: +${hydrated.modelsAdded} имён моделей, ` +
        `${hydrated.thumbsFilled} превью моделей`,
    );
  }

  let newCols = 0;
  for (const col of remoteCols) {
    if (isJunkCatalogKey(col.name)) continue;
    const isNew = ensureCatalogCollection(catalog, col.name);
    if (isNew) newCols++;
    syncCollectionThumbnails(catalog, col);
  }

  safeSave('catalog.json', () => saveCatalog(catalog));
  console.log(
    `[catalog] из API: ${remoteCols.length}, в каталоге: ${Object.keys(catalog.collections).length}, новых имён: ${newCols}`,
  );

  let newModels = 0;
  let skippedCooldown = 0;

  const eligible = remoteCols.filter((c) => !isJunkCatalogKey(c.name));
  const parseStats = countEnabledForParse(eligible.map((c) => c.name));
  if (parseStats.parseAll) {
    console.log(
      `[catalog] модели — все коллекции (${parseStats.total}); кулдаун 24ч только для market.json`,
    );
  } else {
    console.log(
      `[catalog] модели — выбрано ${parseStats.enabled}/${parseStats.total} ` +
        `(data/parse-config.json); кулдаун 24ч только для market.json`,
    );
    if (parseStats.enabled === 0) {
      console.warn(
        '[catalog] ни одна коллекция не включена в настройках парсинга — пропуск моделей/фонов',
      );
    }
  }

  let stepIndex = 0;
  let skippedByConfig = 0;
  for (const col of remoteCols) {
    if (isJunkCatalogKey(col.name)) continue;
    const name = col.name;
    if (!isCollectionEnabledForParse(name)) {
      skippedByConfig++;
      continue;
    }
    stepIndex++;
    const step = `${stepIndex}/${parseStats.enabled || parseStats.total}`;
    const label = col.title || name;

    const marketCooldown = writeMarket && isCollectionOnCooldown(market, name);
    if (marketCooldown) {
      skippedCooldown++;
      const last = getLastCollectionParsedAt(market, name);
      console.log(
        `[catalog] (${step}) ${label} — market.json кулдаун (${last}), каталог: запрос моделей...`,
      );
    } else {
      console.log(`[catalog] (${step}) ${label} — запрос моделей...`);
    }
    const t0 = Date.now();

    try {
      const models = await fetchModelsWithRetry([name]);
      const added = addCatalogModels(
        catalog,
        name,
        models.map((m) => m.modelName),
      );
      syncModelThumbnails(catalog, name, models);
      newModels += added;

      try {
        const backdrops = await fetchBackdropsWithRetry([name]);
        syncCollectionBackdrops(catalog, name, backdrops);
      } catch (err) {
        recordParseError('backdrops', name, err);
      }

      if (writeMarket && !marketCooldown) {
        const parsedAt = new Date().toISOString();
        appendCollectionMarketPoint(market, col, parsedAt);
        for (const m of models) {
          appendModelMarketPoint(market, m, parsedAt);
        }
        try {
          syncCollectionSnapshot(col, parsedAt);
          syncModelSnapshots(models, parsedAt);
        } catch (err) {
          recordParseError('models', `${name} mrkt.db prices`, err);
        }
      }

      const okCat = safeSave('catalog.json', () => saveCatalog(catalog));
      const okMkt =
        writeMarket &&
        !marketCooldown &&
        safeSave('market.json', () => saveMarket(market));

      const backdropCount = catalog.backdrops[name]?.length ?? 0;
      console.log(
        `[catalog] (${step}) ${label}: ${models.length} моделей, +${added} новых, ` +
          `${backdropCount} фонов (${Date.now() - t0} ms)${okCat || okMkt ? ' → json' : ''}`,
      );
    } catch (err) {
      recordParseError('models', name, err);
    }

    await sleep(parserDelayMs());
  }

  console.log(
    `[catalog] готово: +${newModels} новых моделей в списках, ` +
      `market.json пропущено (кулдаун): ${skippedCooldown}, ` +
      `пропущено (не в настройках): ${skippedByConfig}`,
  );
}

function historyTasks(): { collectionName: string; modelName: string }[] {
  const catalog = loadCatalog();
  return listCatalogModelTasks(catalog).filter((t) =>
    isCollectionEnabledForParse(t.collectionName),
  );
}

/** Середина круга: рестарт не должен заново обходить каталог и модели с начала. */
function resumeSkipsCatalog(feed: HistoryFeedConfig): boolean {
  if (feed.explicitStart) return false;
  const progress = loadHistoryProgress();
  if (!progress) return false;
  const tasks = historyTasks();
  if (tasks.length === 0) return false;
  return findResumeIndex(tasks, progress) > 0;
}

async function syncFeed(feed: HistoryFeedConfig): Promise<void> {
  const tasks = historyTasks();
  if (tasks.length === 0) {
    console.warn(
      '[history] нет пар коллекция+модель (или все коллекции выключены в parse-config) — ' +
        'npm run parse -- --catalog и включи коллекции в настройках веба',
    );
    return;
  }

  if (feed.explicitStart && feed.startFrom > tasks.length) {
    console.warn(
      `[history] --from ${feed.startFrom} больше числа моделей (${tasks.length})`,
    );
    return;
  }

  const progress = feed.explicitStart ? null : loadHistoryProgress();
  let round = progress?.round ?? 1;
  let index = feed.explicitStart ? feed.startFrom - 1 : 0;
  if (progress) {
    const found = findResumeIndex(tasks, progress);
    const samePair =
      tasks[found]?.collectionName === progress.collectionName &&
      tasks[found]?.modelName === progress.modelName;
    index = found;
    if (!samePair && found === 0) {
      console.warn(
        `[history] в каталоге нет ${progress.collectionName} / ${progress.modelName} ` +
          'и ничего после неё — круг с начала',
      );
    } else if (!samePair) {
      console.warn(
        `[history] в каталоге нет ${progress.collectionName} / ${progress.modelName}, ` +
          `продолжаю с ${tasks[found]!.collectionName} / ${tasks[found]!.modelName}`,
      );
    }
  }

  const database = openHistoryDb();
  const pauseBetweenRounds = () => getParserTiming().historyRoundMs;

  console.log(`[history] SQLite: ${HISTORY_DB_FILE}`);
  console.log(
    `[history] моделей в каталоге: ${tasks.length}, до ${feed.maxItemsPerModel} продаж/модель/круг, ` +
      `по ${FEED_API_PAGE_SIZE} за запрос (лимит API /feed)`,
  );
  if (index > 0) {
    const at = tasks[index]!;
    console.log(
      `[history] продолжаю круг ${round} с ${index + 1}/${tasks.length} ` +
        `${at.collectionName} / ${at.modelName}` +
        (feed.explicitStart
          ? ' (флаги --from / --start)'
          : ` (${HISTORY_PROGRESS_FILE})`),
    );
  }
  console.log(`[history] в БД сейчас: ${countSales(database)} продаж`);
  const backdropHistory = isHistoryFetchBackdropsEnabled();
  console.log(
    '[history] бесконечные круги: коллекция + модель (курсором)' +
      (backdropHistory
        ? `, затем по 1×${FEED_API_PAGE_SIZE} на фоны: ${getHistoryFeedBackdropNames().join(', ')} (выкл. в настройках)`
        : ', опрос фонов выключен (parse-config.json)') +
      ' (Ctrl+C)',
  );

  let grandTotal = 0;

  try {
    for (;;) {
      let roundAdded = 0;
      console.log(`\n[history] === круг ${round} ===`);

      for (let i = index; i < tasks.length; i++) {
        const stepNum = i + 1;
        const { collectionName, modelName } = tasks[i]!;
        const step = `${stepNum}/${tasks.length}`;
        roundAdded += await syncModelFeed(
          database,
          collectionName,
          modelName,
          round,
          step,
          feed,
        );

        const hasNext = i + 1 < tasks.length;
        const next = hasNext ? tasks[i + 1]! : tasks[0]!;
        saveHistoryProgress({
          round: hasNext ? round : round + 1,
          collectionName: next.collectionName,
          modelName: next.modelName,
        });

        if (hasNext) await sleep(parserDelayMs());
      }

      grandTotal += roundAdded;
      console.log(
        `[history] круг ${round} итог: +${roundAdded} продаж, за сессию: +${grandTotal}, в БД: ${countSales(database)}`,
      );
      index = 0;
      round += 1;
      const roundPause = pauseBetweenRounds();
      console.log(`[history] пауза ${roundPause} ms...`);
      await sleep(roundPause);
    }
  } finally {
    closeHistoryDb();
  }
}

/**
 * Деплой: один проход коллекций (каталог + модели + market.json),
 * затем бесконечные круги POST /feed по каждой модели.
 * Не завершается, пока жив процесс.
 */
export async function runCatalogThenHistory(): Promise<void> {
  const { startSalesHistoryRetentionLoop } = await import('./db/sales-retention.js');
  startSalesHistoryRetentionLoop();
  await initClient();
  const historyFeed = parseHistoryFeedConfig();
  if (resumeSkipsCatalog(historyFeed)) {
    console.log(
      '[parser] есть незавершённый круг истории — каталог не обновляю, продолжаю /feed',
    );
  } else {
    console.log(
      `[parser] шаг 1/2: коллекции и модели каталога (delay=${parserDelayMs()}ms)`,
    );
    await syncCatalogAndMarket(true);
  }
  console.log(
    `[parser] шаг 2/2: бесконечный парсер моделей, ` +
      `до ${historyFeed.maxItemsPerModel} продаж/модель/круг`,
  );
  await syncFeed(historyFeed);
}

function launchedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const catalogMode =
    process.argv.includes('--catalog') ||
    process.argv.includes('--catalog-only');
  const historyMode =
    process.argv.includes('--history') || process.argv.includes('--feed');
  const historyFeed = parseHistoryFeedConfig();

  console.log('=== MRKT parser ===');
  if (historyMode) {
    console.log(
      `[config] delay=${parserDelayMs()}ms, feed maxItems/model=${historyFeed.maxItemsPerModel}, ` +
        `from=${historyFeed.startFrom}`,
    );
  } else {
    console.log(`[config] delay=${parserDelayMs()}ms`);
  }

  try {
    await initClient();
  } catch (err) {
    recordParseError('auth', 'initClient', err);
    flushParseErrors();
    printParseErrorSummary();
    process.exit(1);
  }

  try {
    if (historyMode) {
      await syncFeed(historyFeed);
    } else {
      await syncCatalogAndMarket(!catalogMode);
      console.log(
        catalogMode
          ? 'готово: catalog.json'
          : 'готово: catalog.json + market.json (история: npm run parse -- --history → data/history.db)',
      );
    }
  } catch (err) {
    recordParseError('collections', 'sync', err);
  } finally {
    flushParseErrors();
    printParseErrorSummary();
    if (getParseErrors().length > 0) {
      process.exit(1);
    }
  }
}

if (launchedAsCli()) {
  main().catch((err) => {
    recordParseError('collections', 'fatal', err);
    flushParseErrors();
    console.error('[parser] fatal:', err);
    process.exit(1);
  });
}
