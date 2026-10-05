import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  initClient,
  fetchSalingWithRetry,
  makeDefaultSalingRequest,
} from './client.js';
import type { Gift } from './types.js';
import { nanoToTon } from './types.js';
import {
  getStatsSmart,
  getPriceHistory,
  getCollectionPriceHistory,
  evaluateListing,
  decide,
  decideFromSales,
  getSaleById,
} from './db/analytics.js';
import {
  loadCatalog,
  loadMarket,
  listCatalogCollections,
  hydrateCatalogFromMarket,
  saveCatalog,
} from './store.js';
import { loadCatalogMedia } from './catalog-media.js';
import {
  countCollectionPriceRows,
  importMarketFileIfExists,
  collectionPriceHistoryFromMarketFile,
  modelPriceHistoryFromMarketFile,
} from './db/market-sync.js';
import {
  countMrktSales,
  importSalesFromHistoryDb,
} from './db/history-import.js';
import {
  loadParseConfig,
  saveParseConfig,
  HISTORY_FEED_BACKDROP_NAMES,
} from './parse-config.js';
import { listLiquidItems } from './db/liquidity.js';

const PORT = Number(process.env.PORT) || 3000;
const WEB_DIST = resolve(process.cwd(), 'web', 'dist');

function parsePositiveInt(
  value: unknown,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseFeeRate(value: unknown, fallback = 0.05): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 1) return fallback;
  return n;
}

function requireString(
  value: unknown,
  field: string,
): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

const app = Fastify({ logger: true });

app.addHook('onRequest', async (request) => {
  const url = request.raw.url ?? '';
  if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) {
    request.raw.url = url.replace(/^\/api/, '') || '/';
  }
});

app.get('/health', async (_req, reply) => {
  return reply.send({ ok: true });
});

function catalogNeedsModelHydrate(catalog: ReturnType<typeof loadCatalog>): boolean {
  const cols = listCatalogCollections(catalog);
  if (cols.length === 0) return true;
  return cols.every((c) => (catalog.collections[c]?.length ?? 0) === 0);
}

app.get('/catalog', async (_req, reply) => {
  try {
    const catalog = loadCatalog();
    if (catalogNeedsModelHydrate(catalog)) {
      const market = loadMarket();
      const h = hydrateCatalogFromMarket(catalog, market);
      if (h.modelsAdded > 0 || h.thumbsFilled > 0) {
        saveCatalog(catalog);
        reply.log.info(
          { modelsAdded: h.modelsAdded, thumbsFilled: h.thumbsFilled },
          'catalog hydrated from market.json',
        );
      }
    }
    const collections = listCatalogCollections(catalog);
    const models: Record<string, string[]> = {};
    for (const name of collections) {
      const list = catalog.collections[name] ?? [];
      models[name] = [...list]
        .filter((m) => m.length > 0 && !/^\d+$/.test(m))
        .sort();
    }
    const fromCatalog = catalog.collectionThumbnails ?? {};
    const fromModels = catalog.modelThumbnails ?? {};
    const media = loadCatalogMedia();

    const collectionThumbnails = { ...media.collectionThumbnails, ...fromCatalog };
    const modelThumbnails: Record<string, Record<string, string>> = {
      ...media.modelThumbnails,
    };
    for (const [col, thumbs] of Object.entries(fromModels)) {
      modelThumbnails[col] = { ...media.modelThumbnails[col], ...thumbs };
    }

    const backdrops = catalog.backdrops ?? {};

    return reply.send({
      collections,
      models,
      collectionThumbnails,
      modelThumbnails,
      backdrops,
    });
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.get('/parse-config', async (_req, reply) => {
  try {
    const catalog = loadCatalog();
    const collections = listCatalogCollections(catalog);
    const cfg = loadParseConfig();
    return reply.send({
      collections,
      enabledCollections: cfg.enabledCollections,
      historyFetchBackdrops: cfg.historyFetchBackdrops,
      historyFeedBackdropNames: [...HISTORY_FEED_BACKDROP_NAMES],
    });
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.put('/parse-config', async (req, reply) => {
  const body = req.body as {
    enabledCollections?: unknown;
    historyFetchBackdrops?: unknown;
  };
  if (!Array.isArray(body.enabledCollections)) {
    return reply
      .code(400)
      .send({ error: 'enabledCollections должен быть массивом строк' });
  }
  const enabled = body.enabledCollections.filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  const historyFetchBackdrops =
    body.historyFetchBackdrops === undefined
      ? undefined
      : Boolean(body.historyFetchBackdrops);
  try {
    saveParseConfig({ enabledCollections: enabled, historyFetchBackdrops });
    const cfg = loadParseConfig();
    return reply.send({
      ok: true,
      enabledCollections: cfg.enabledCollections,
      historyFetchBackdrops: cfg.historyFetchBackdrops,
    });
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

function parseMinConfidence(
  value: unknown,
): 'high' | 'medium' | 'low' | null {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return null;
}

app.get('/liquidity', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const days = parsePositiveInt(q.days, 7);
  const limitRaw = q.limit;
  const limit =
    limitRaw === undefined || limitRaw === null || limitRaw === ''
      ? null
      : parsePositiveInt(limitRaw, 0) || null;
  const collection = requireString(q.collection, 'collection');
  const minConfidence = parseMinConfidence(q.minConfidence);
  try {
    const result = listLiquidItems(days, limit, collection, minConfidence);
    return reply.send(result);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.get('/stats', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const collection = requireString(q.collection, 'collection');
  const model = requireString(q.model, 'model');
  if (!collection || !model) {
    return reply.code(400).send({ error: 'collection и model обязательны' });
  }
  const days = parsePositiveInt(q.days, 7);
  try {
    const stats = getStatsSmart(collection, model, null, days);
    return reply.send(stats);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.get('/stats/backdrop', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const collection = requireString(q.collection, 'collection');
  const model = requireString(q.model, 'model');
  const backdrop = requireString(q.backdrop, 'backdrop');
  if (!collection || !model || !backdrop) {
    return reply
      .code(400)
      .send({ error: 'collection, model и backdrop обязательны' });
  }
  const days = parsePositiveInt(q.days, 7);
  try {
    const stats = getStatsSmart(collection, model, backdrop, days);
    return reply.send(stats);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.get('/history', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const collection = requireString(q.collection, 'collection');
  if (!collection) {
    return reply.code(400).send({ error: 'collection обязателен' });
  }
  const modelRaw = q.model;
  const model =
    typeof modelRaw === 'string' && modelRaw.trim() !== ''
      ? modelRaw.trim()
      : null;
  const days = parsePositiveInt(q.days, 30);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  try {
    let points = model
      ? getPriceHistory(collection, model, days)
      : getCollectionPriceHistory(collection, days);
    if (points.length === 0) {
      points = model
        ? modelPriceHistoryFromMarketFile(collection, model, sinceTs)
        : collectionPriceHistoryFromMarketFile(collection, sinceTs);
    }
    return reply.send({ collection, model, days, points });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

interface EvaluateBody {
  collection?: string;
  model?: string;
  backdrop?: string | null;
  price?: number;
  days?: number;
  feeRate?: number;
}

app.post('/evaluate', async (req, reply) => {
  const body = req.body as EvaluateBody;
  const collection = requireString(body.collection, 'collection');
  const model = requireString(body.model, 'model');
  const price = body.price;
  if (!collection || !model) {
    return reply.code(400).send({ error: 'collection и model обязательны' });
  }
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return reply.code(400).send({ error: 'price обязателен и должен быть > 0' });
  }
  const days = body.days !== undefined ? parsePositiveInt(body.days, 7) : 7;
  const feeRate = parseFeeRate(body.feeRate);
  const backdrop =
    body.backdrop === null || body.backdrop === undefined
      ? null
      : String(body.backdrop);

  try {
    const result = evaluateListing(
      collection,
      model,
      backdrop,
      price,
      days,
      feeRate,
    );
    return reply.send(result);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

interface DecideBody {
  collection?: string;
  model?: string;
  backdrop?: string | null;
  price?: number;
  floorPrice?: number;
  days?: number;
  feeRate?: number;
}

app.post('/decide', async (req, reply) => {
  const body = req.body as DecideBody;
  const collection = requireString(body.collection, 'collection');
  const model =
    body.model === null || body.model === undefined ? '' : String(body.model);
  const price = body.price;
  if (!collection) {
    return reply.code(400).send({ error: 'collection обязателен' });
  }
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return reply.code(400).send({ error: 'price обязателен и должен быть > 0' });
  }
  const days = body.days !== undefined ? parsePositiveInt(body.days, 7) : 7;
  const feeRate = parseFeeRate(body.feeRate);
  const backdrop =
    body.backdrop === null || body.backdrop === undefined
      ? null
      : String(body.backdrop);

  try {
    const result = decideFromSales(
      collection,
      model,
      backdrop,
      price,
      days,
      feeRate,
    );
    return reply.send(result);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.get('/item/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!id) {
    return reply.code(400).send({ error: 'id обязателен' });
  }
  try {
    const row = getSaleById(id);
    if (!row) {
      return reply.code(404).send({ error: 'продажа не найдена' });
    }
    let gift: Gift | null = null;
    try {
      const parsed = JSON.parse(row.raw_json) as { gift?: Gift };
      gift = parsed.gift ?? null;
    } catch {
      gift = null;
    }
    return reply.send({
      id: row.id,
      collection_name: row.collection_name,
      model_name: row.model_name,
      gift_number: row.gift_number,
      backdrop_name: row.backdrop_name,
      symbol_name: row.symbol_name,
      amount_nano: row.amount_nano,
      date: row.date,
      gift,
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.get('/deals', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const collection = requireString(q.collection, 'collection');
  if (!collection) {
    return reply.code(400).send({ error: 'collection обязателен' });
  }
  const days = parsePositiveInt(q.days, 7);
  const limit = parsePositiveInt(q.limit, 20);
  const minDiscount =
    q.minDiscount !== undefined && q.minDiscount !== ''
      ? Number(q.minDiscount)
      : 0.15;
  if (!Number.isFinite(minDiscount) || minDiscount < 0) {
    return reply.code(400).send({ error: 'minDiscount должен быть числом >= 0' });
  }
  const feeRate = 0.05;

  try {
    const res = await fetchSalingWithRetry(
      makeDefaultSalingRequest({
        collectionNames: [collection],
        ordering: 'Price',
        lowToHigh: true,
        count: 50,
      }),
    );

    const deals: {
      gift: Gift;
      evaluation: ReturnType<typeof evaluateListing>;
      verdict: ReturnType<typeof decide>;
    }[] = [];

    for (const gift of res.gifts) {
      const listingTon = nanoToTon(gift.salePrice);
      const floorNano =
        gift.floorPriceNanoTONsByBackdropModel ??
        gift.floorPriceNanoTONsByCollection;
      const floorTon = floorNano != null ? nanoToTon(floorNano) : 0;

      const evaluation = evaluateListing(
        gift.collectionName,
        gift.modelName,
        gift.backdropName,
        listingTon,
        days,
        feeRate,
      );
      const verdict = decide(
        gift.collectionName,
        gift.modelName,
        gift.backdropName,
        listingTon,
        floorTon,
        days,
        feeRate,
      );

      if (
        verdict.action === 'buy' &&
        verdict.metrics.discountVsMedian >= minDiscount
      ) {
        deals.push({ gift, evaluation, verdict });
      }
    }

    deals.sort(
      (a, b) => b.verdict.metrics.netMargin - a.verdict.metrics.netMargin,
    );

    return reply.send({
      collection,
      days,
      count: Math.min(deals.length, limit),
      deals: deals.slice(0, limit),
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

function bootstrapMrktDb(): void {
  if (countCollectionPriceRows() === 0) {
    const stats = importMarketFileIfExists();
    if (stats) {
      console.log(
        `[server] mrkt.db: импорт market.json → collection_prices +${stats.collectionPoints}, model_prices +${stats.modelPoints}`,
      );
    } else {
      console.warn(
        '[server] mrkt.db: нет collection_prices и нет data/market.json — запусти npm run parse',
      );
    }
  }

  if (countMrktSales() === 0) {
    const added = importSalesFromHistoryDb();
    if (added > 0) {
      console.log(`[server] mrkt.db: импорт sales из history.db +${added}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`[server] старт PORT=${PORT} cwd=${process.cwd()}`);
  bootstrapMrktDb();

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
    console.log(`[server] UI: ${WEB_DIST}`);
  } else {
    console.warn('[server] нет web/dist/index.html — отдаём только API');
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[server] готов: http://0.0.0.0:${PORT}`);

  void initClient().then(
    () => console.log('[server] MRKT: токен OK'),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        '[server] MRKT: нет токена (добавь MRKT_AUTH в env) — история/статистика из БД работают, лайв /deals нет:',
        msg.split('\n')[0],
      );
    },
  );
}

try {
  await main();
} catch (err) {
  console.error('[server] fatal:', err);
  process.exit(1);
}