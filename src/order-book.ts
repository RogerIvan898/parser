import {
  fetchSalingWithRetry,
  makeSalingOrderBookRequest,
} from './client.js';
import {
  analyzeLot,
  isPotentiallyProfitableScoped,
  type ActiveListing,
} from './db/analytics.js';
import { findStyleCombo, isBackdropEnabledForAnalysis } from './parse-config.js';
import type { Gift } from './types.js';
import { nanoToTon, withoutLockedListings } from './types.js';

const ORDER_BOOK_SALING_COUNT = 20;

export type LotAnalysisResult = ReturnType<typeof analyzeLot>;

export interface OrderBookFetchInfo {
  fetched: boolean;
  asks: number;
  used: number;
  skippedReason: 'not_promising' | 'no_model' | null;
  error: string | null;
}

export function giftsToActiveListings(gifts: Gift[]): ActiveListing[] {
  const out: ActiveListing[] = [];
  for (const gift of gifts) {
    if (!gift.isOnSale || gift.salePrice <= 0) continue;
    const collection = gift.collectionName || gift.collectionTitle || gift.title;
    if (!collection?.trim()) continue;
    out.push({
      price: nanoToTon(gift.salePrice),
      collection: collection.trim(),
      model: gift.modelName || gift.modelTitle || null,
      backdrop: gift.backdropName?.trim() || null,
      id: gift.id || gift.giftIdString,
      createdAt: gift.receivedDate || gift.promoteEndAt || null,
    });
  }
  return out;
}

function cacheKey(collection: string, model: string, backdrop: string): string {
  return `${collection}\0${model}\0${backdrop}`;
}

/**
 * Стакан с MRKT.
 * Обычный фон: коллекция + модель.
 * Black / Onyx Black и ручная комбинация: ещё и backdrop.
 */
export async function loadOrderBookListings(
  collection: string,
  model: string,
  backdrop: string | null | undefined,
  cache?: Map<string, ActiveListing[]>,
): Promise<ActiveListing[]> {
  const backdropName = backdrop?.trim() ?? '';
  const key = cacheKey(collection, model, backdropName);
  const hit = cache?.get(key);
  if (hit) return hit;
  const res = await fetchSalingWithRetry(
    makeSalingOrderBookRequest({
      collection,
      model,
      backdrop: backdropName || null,
      count: ORDER_BOOK_SALING_COUNT,
    }),
    { retries: 1, timeoutMs: 20_000 },
  );
  const listings = giftsToActiveListings(withoutLockedListings(res.gifts));
  cache?.set(key, listings);
  return listings;
}

/**
 * Тот же разбор, что у сканера: сначала продажи, и только при buy/watch
 * на каком-то срезе — POST /gifts/saling.
 * Премиальный фон: коллекция + модель + фон. Обычный фон: коллекция + модель.
 */
export async function analyzeLotWithLiveOrderBook(params: {
  collection: string;
  model: string | null | undefined;
  backdrop: string | null | undefined;
  listingPrice: number;
  days?: number;
  feeRate?: number;
  excludeListingId?: string | null;
  cache?: Map<string, ActiveListing[]>;
  logPrefix?: string;
}): Promise<LotAnalysisResult & { orderBook: OrderBookFetchInfo }> {
  const days = params.days ?? 7;
  const feeRate = params.feeRate ?? 0.05;
  const model = params.model?.trim() ?? '';
  const backdrop = params.backdrop?.trim() ?? '';
  const salesOnly = analyzeLot(
    params.collection,
    model || null,
    backdrop || null,
    params.listingPrice,
    days,
    feeRate,
  );

  if (!model) {
    return {
      ...salesOnly,
      orderBook: {
        fetched: false,
        asks: 0,
        used: 0,
        skippedReason: 'no_model',
        error: null,
      },
    };
  }
  if (!isPotentiallyProfitableScoped(salesOnly.scopes)) {
    return {
      ...salesOnly,
      orderBook: {
        fetched: false,
        asks: 0,
        used: 0,
        skippedReason: 'not_promising',
        error: null,
      },
    };
  }

  try {
    const bookBackdrop =
      isBackdropEnabledForAnalysis(backdrop) ||
      findStyleCombo(params.collection, model, backdrop)
        ? backdrop
        : '';
    const asks = await loadOrderBookListings(
      params.collection,
      model,
      bookBackdrop,
      params.cache,
    );
    const exclude = params.excludeListingId?.trim();
    const used = exclude ? asks.filter((row) => row.id !== exclude) : asks;
    const analysis = analyzeLot(
      params.collection,
      model,
      backdrop || null,
      params.listingPrice,
      days,
      feeRate,
      used,
    );
    const prefix = params.logPrefix ?? '[lot]';
    console.log(
      `${prefix} стакан ${params.collection} / ${model}` +
        `${bookBackdrop ? ` / ${bookBackdrop}` : ''} asks=${asks.length} used=${used.length}`,
    );
    return {
      ...analysis,
      orderBook: {
        fetched: true,
        asks: asks.length,
        used: used.length,
        skippedReason: null,
        error: null,
      },
    };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(
      `[lot] стакан ${params.collection} / ${model} не загрузился: ${message}`,
    );
    return {
      ...salesOnly,
      orderBook: {
        fetched: false,
        asks: 0,
        used: 0,
        skippedReason: null,
        error: message,
      },
    };
  }
}
