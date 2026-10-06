import 'dotenv/config';
import type {
  Balance,
  Collection,
  FeedItem,
  FeedRequest,
  FeedResponse,
  FeedType,
  Model,
  ModelsRequest,
  GiftBackdrop,
  BackdropsRequest,
  Gift,
  SalingRequest,
  SalingResponse,
} from './types.js';
import { withoutLockedListings } from './types.js';
import { ensureToken } from './auth.js';

// ============================================================
// Конфигурация
// ============================================================

const BASE_URL = 'https://api.tgmrkt.io';

// Токен инициализируется асинхронно перед первым запросом
let AUTH: string | null = null;

/**
 * Инициализация: получить токен (из .env, auth.json или через initData).
 * Вызывается один раз в начале.
 */
export async function initClient(): Promise<void> {
  AUTH = await ensureToken();
}

/**
 * Принудительно обновить токен (например, после 401).
 */
export async function updateToken(newToken: string): Promise<void> {
  AUTH = newToken;
}

function requireAuth(): string {
  if (!AUTH) {
    throw new Error(
      '[client] клиент не инициализирован. Вызови initClient() в начале.',
    );
  }
  return AUTH;
}

const COMMON_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru,en;q=0.9',
  'content-type': 'application/json',
  origin: 'https://cdn.tgmrkt.io',
  referer: 'https://cdn.tgmrkt.io/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
};

function authHeaders(): Record<string, string> {
  const token = requireAuth();
  return {
    ...COMMON_HEADERS,
    authorization: token,
    cookie: `access_token=${token}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Универсальный ретраер
// ============================================================

async function withRetry<T>(
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastErr = err;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      console.warn(
        `[${label}] попытка ${attempt}/${retries} упала: ${(err as Error).message}. Ждём ${wait}ms...`,
      );
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

async function parseError(res: Response): Promise<never> {
  const text = await res.text().catch(() => '');
  throw new Error(
    `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`,
  );
}

// ============================================================
// GET /api/v1/balance
// ============================================================

export async function fetchBalance(signal?: AbortSignal): Promise<Balance> {
  const res = await fetch(`${BASE_URL}/api/v1/balance`, {
    method: 'GET',
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as Balance;
}

export function fetchBalanceWithRetry(
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Balance> {
  return withRetry('balance', (signal) => fetchBalance(signal), opts);
}

// ============================================================
// GET /api/v1/gifts/collections
// ============================================================

export async function fetchCollections(
  signal?: AbortSignal,
): Promise<Collection[]> {
  const res = await fetch(`${BASE_URL}/api/v1/gifts/collections`, {
    method: 'GET',
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as Collection[];
}

export function fetchCollectionsWithRetry(
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Collection[]> {
  return withRetry('collections', (signal) => fetchCollections(signal), opts);
}

// ============================================================
// POST /api/v1/gifts/models
// ============================================================

export async function fetchModels(
  collections: string[],
  signal?: AbortSignal,
): Promise<Model[]> {
  const body: ModelsRequest = { collections };
  const res = await fetch(`${BASE_URL}/api/v1/gifts/models`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as Model[];
}

export function fetchModelsWithRetry(
  collections: string[],
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Model[]> {
  return withRetry('models', (signal) => fetchModels(collections, signal), opts);
}

// ============================================================
// POST /api/v1/gifts/backdrops
// ============================================================

export async function fetchBackdrops(
  collections: string[],
  signal?: AbortSignal,
): Promise<GiftBackdrop[]> {
  const body: BackdropsRequest = { collections };
  const res = await fetch(`${BASE_URL}/api/v1/gifts/backdrops`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as GiftBackdrop[];
}

export function fetchBackdropsWithRetry(
  collections: string[],
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<GiftBackdrop[]> {
  return withRetry(
    'backdrops',
    (signal) => fetchBackdrops(collections, signal),
    opts,
  );
}

/**
 * Обход всех коллекций: получить модели для каждой.
 */
export async function fetchAllModels(
  collections: Collection[],
  opts: {
    delayMs?: number;
    onProgress?: (done: number, total: number, name: string) => void;
  } = {},
): Promise<Map<string, Model[]>> {
  const delayMs = opts.delayMs ?? 300;
  const result = new Map<string, Model[]>();

  let done = 0;
  for (const col of collections) {
    try {
      const models = await fetchModelsWithRetry([col.name]);
      result.set(col.name, models);
    } catch (err) {
      console.warn(`[models] ${col.name} упала: ${(err as Error).message}`);
      result.set(col.name, []);
    }

    done++;
    opts.onProgress?.(done, collections.length, col.name);

    if (delayMs > 0) await sleep(delayMs);
  }

  return result;
}

// ============================================================
// POST /api/v1/gifts/saling
// ============================================================

/**
 * Лента saling без фильтров (ordering `None`): MRKT отдаёт недавно выставленные лоты,
 * не сортировку «самые дешёвые». Используется сканером profit-deals.
 */
export function makeSalingScannerFeedRequest(): SalingRequest {
  return makeDefaultSalingRequest({ count: 20, cursor: '' });
}

export function makeDefaultSalingRequest(
  overrides: Partial<SalingRequest> = {},
): SalingRequest {
  return {
    count: 20,
    cursor: '',
    collectionNames: [],
    modelNames: [],
    backdropNames: [],
    symbolNames: [],
    minPrice: null,
    maxPrice: null,
    number: null,
    isPremarket: null,
    isNew: null,
    luckyBuy: null,
    giftType: null,
    craftable: null,
    isCrafted: null,
    tgCanBeCraftedFrom: null,
    removeSelfSales: null,
    isTransferable: null,
    availableForStaking: null,
    forGame: null,
    ordering: 'None',
    lowToHigh: false,
    query: null,
    ...overrides,
  };
}

export async function fetchSaling(
  body: SalingRequest,
  signal?: AbortSignal,
): Promise<SalingResponse> {
  const res = await fetch(`${BASE_URL}/api/v1/gifts/saling`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await parseError(res);
  const data = (await res.json()) as SalingResponse;
  return {
    ...data,
    gifts: withoutLockedListings(data.gifts ?? []),
  };
}

export function fetchSalingWithRetry(
  body: SalingRequest,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<SalingResponse> {
  return withRetry('saling', (signal) => fetchSaling(body, signal), opts);
}

/**
 * Обойти маркет по курсору и собрать лоты.
 */
export async function fetchAllSaling(
  base: Partial<SalingRequest> = {},
  opts: {
    maxPages?: number;
    delayMs?: number;
    onPage?: (
      page: number,
      batch: number,
      total: number,
      cursor: string | null,
    ) => void;
  } = {},
): Promise<{ gifts: Gift[]; total: number }> {
  const maxPages = opts.maxPages ?? 100;
  const delayMs = opts.delayMs ?? 250;
  const pageSize = base.count ?? 50;

  const all: Gift[] = [];
  let cursor = base.cursor ?? '';
  let page = 0;
  let reportedTotal = 0;

  while (page < maxPages) {
    const body = makeDefaultSalingRequest({
      ...base,
      count: pageSize,
      cursor,
    });

    const res = await fetchSalingWithRetry(body);
    reportedTotal = res.total;
    all.push(...res.gifts);
    page++;
    opts.onPage?.(page, res.gifts.length, res.total, res.cursor);

    if (!res.cursor || res.gifts.length === 0) break;
    cursor = res.cursor;

    if (delayMs > 0) await sleep(delayMs);
  }

  return { gifts: all, total: reportedTotal };
}

// ============================================================
// POST /api/v1/feed
// ============================================================

export function makeDefaultFeedRequest(
  overrides: Partial<FeedRequest> = {},
): FeedRequest {
  return {
    count: 20,
    cursor: '',
    collectionNames: [],
    modelNames: [],
    backdropNames: [],
    number: null,
    type: ['Sale'],
    minPrice: null,
    maxPrice: null,
    ordering: 'Latest',
    lowToHigh: false,
    query: null,
    ...overrides,
  };
}

export async function fetchFeed(
  body: FeedRequest,
  signal?: AbortSignal,
): Promise<FeedResponse> {
  const res = await fetch(`${BASE_URL}/api/v1/feed`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as FeedResponse;
}

export function fetchFeedWithRetry(
  body: FeedRequest,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<FeedResponse> {
  return withRetry('feed', (signal) => fetchFeed(body, signal), opts);
}

/**
 * Собрать всю историю событий по коллекции+модели, ходя по курсору.
 */
export async function fetchAllFeed(
  collection: string,
  model: string,
  opts: {
    types?: FeedType[];
    maxPages?: number;
    delayMs?: number;
    onPage?: (page: number, count: number, cursor: string | null) => void;
  } = {},
): Promise<FeedItem[]> {
  const types = opts.types ?? ['Sale'];
  const maxPages = opts.maxPages ?? 50;
  const delayMs = opts.delayMs ?? 300;

  const all: FeedItem[] = [];
  let cursor = '';
  let page = 0;

  while (page < maxPages) {
    const body = makeDefaultFeedRequest({
      count: 20,
      cursor,
      collectionNames: [collection],
      modelNames: [model],
      type: types,
      ordering: 'Latest',
      lowToHigh: false,
    });

    const res = await fetchFeedWithRetry(body);
    all.push(...res.items);
    page++;
    opts.onPage?.(page, res.items.length, res.cursor);

    if (!res.cursor || res.items.length === 0) break;
    cursor = res.cursor;

    if (delayMs > 0) await sleep(delayMs);
  }

  return all;
}

// ============================================================
// Производные хелперы
// ============================================================

/** Самая редкая модель в коллекции. */
export function rarestModel(models: Model[]): Model | null {
  if (models.length === 0) return null;
  return models.reduce((a, b) =>
    a.rarityPerMille <= b.rarityPerMille ? a : b,
  );
}

/** Самая дорогая модель по floor. */
export function priciestModel(models: Model[]): Model | null {
  const withFloor = models.filter((m) => m.floorPriceNanoTons != null);
  if (withFloor.length === 0) return null;
  return withFloor.reduce((a, b) =>
    (a.floorPriceNanoTons ?? 0) >= (b.floorPriceNanoTons ?? 0) ? a : b,
  );
}

/** Модели дешевле заданной цены в TON. */
export function cheaperThan(models: Model[], ton: number): Model[] {
  const nano = ton * 1_000_000_000;
  return models.filter(
    (m) => m.floorPriceNanoTons != null && m.floorPriceNanoTons < nano,
  );
}

/** Отсортировать коллекции по объёму (по убыванию). */
export function sortByVolume(cols: Collection[]): Collection[] {
  return [...cols].sort((a, b) => b.volume - a.volume);
}

/** Только новые коллекции. */
export function onlyNew(cols: Collection[]): Collection[] {
  return cols.filter((c) => c.isNew);
}

/** Коллекции с просадкой floor за день. */
export function floorDropped(cols: Collection[]): Collection[] {
  return cols.filter(
    (c) =>
      c.floorPriceNanoTons != null &&
      c.previousDayFloorPriceNanoTons != null &&
      c.floorPriceNanoTons < c.previousDayFloorPriceNanoTons,
  );
}

/** Средняя цена продажи за последние N дней. */
export function averagePrice(items: FeedItem[], days = 30): number | null {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = items.filter((i) => new Date(i.date).getTime() >= cutoff);
  if (recent.length === 0) return null;
  return recent.reduce((s, i) => s + i.amount, 0) / recent.length;
}

/** Самая дешёвая продажа в выборке. */
export function cheapestSale(items: FeedItem[]): FeedItem | null {
  if (items.length === 0) return null;
  return items.reduce((a, b) => (a.amount <= b.amount ? a : b));
}

/** Самая дорогая продажа в выборке. */
export function priciestSale(items: FeedItem[]): FeedItem | null {
  if (items.length === 0) return null;
  return items.reduce((a, b) => (a.amount >= b.amount ? a : b));
}

/** Группировка продаж по дням: Map<YYYY-MM-DD, FeedItem[]>. */
export function groupByDay(items: FeedItem[]): Map<string, FeedItem[]> {
  const map = new Map<string, FeedItem[]>();
  for (const i of items) {
    const day = i.date.slice(0, 10);
    const arr = map.get(day) ?? [];
    arr.push(i);
    map.set(day, arr);
  }
  return map;
}