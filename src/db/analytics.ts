import {
  getBackdropAdjustmentConfig,
  getBullishMarginPremium,
  getSalesVerdictThresholds,
  isBackdropEnabledForAnalysis,
  type BackdropAdjustmentConfig,
} from '../parse-config.js';
import { NANO } from '../types.js';
import { db } from './index.js';
import { nowTs } from './storage.js';

export interface PriceStats {
  collection: string;
  model: string;
  backdrop?: string;
  days: number;
  samples: number;
  min: number;
  max: number;
  avg: number;
  median: number;
  p25: number;
  p75: number;
  last: number;
  lastTs: number | null;
}

export interface StatsWithConfidence extends PriceStats {
  scope: 'model+backdrop' | 'model' | 'collection' | 'collection+backdrop';
  confidence: 'high' | 'medium' | 'low';
}

export interface DealEvaluation {
  listingPrice: number;
  referencePrice: number;
  discount: number;
  verdict: 'buy' | 'fair' | 'expensive';
  confidence: StatsWithConfidence['confidence'];
  samples: number;
  salesPerDay: number;
  netMargin: number;
}

export type EvidenceTier = 'insufficient' | 'weak' | 'extended' | 'reliable';

export interface DealVerdict {
  action: 'buy' | 'watch' | 'skip' | 'insufficient';
  /** Насколько срез сам может решать. insufficient/weak — не buy и не skip. */
  evidence?: EvidenceTier;
  reason: string;
  metrics: {
    listingPrice: number;
    referencePrice: number;
    floorPrice: number;
    discountVsMedian: number;
    discountVsFloor: number;
    netMargin: number;
    confidence: StatsWithConfidence['confidence'];
    samples: number;
    salesPerDay: number;
    /** Окно, по медиане которого посчитан дисконт (7 или 30). */
    windowDays?: number;
    samples7?: number;
    samples30?: number | null;
    priceStability?: number | null;
    /** Медиана 7д того же среза, до подмены на свежую. */
    median7?: number;
    median3?: number | null;
    samples3?: number | null;
    /** (median3−median7)/median7. null — мало продаж за 3д. */
    trend?: number | null;
    trendDirection?: 'down' | 'up' | 'flat' | 'unknown';
    /**
     * true только при медвежьем сдвиге (reference = median3).
     * Бычий рынок сюда не входит: иначе узкий skip отменял бы широкий buy.
     */
    trendAdjusted?: boolean;
    trendStatus?: 'bullish' | 'bearish' | 'neutral';
    /** true — ориентир поднят по формуле median7 + (median3−median7)×0.7. */
    bullishDiscountApplied?: boolean;
    rawMedian3?: number | null;
    trendView?: {
      status: 'bullish' | 'bearish' | 'neutral';
      median7: number;
      median3: number | null;
      referenceUsed: number;
    } | null;
    /** Доля сделок за 3д строго ниже медианы 7д. */
    recentBelowBaseRatio?: number | null;
    /** Ориентир до защиты по тренду (медиана 7д или 30д). */
    baseReferencePrice?: number;
    /** Медиана model+backdrop, по которой считали ratio (уже с 3д, если тренд сработал). */
    backdropMedian?: number | null;
    backdropSamples7?: number | null;
    backdropSamples30?: number | null;
    /** backdropMedian / ориентир модели. */
    backdropRatio?: number | null;
    /** ratio после soft-clamp выбранного коридора. */
    backdropRatioClamped?: number | null;
    backdropTier?: 'low' | 'mid' | 'high' | null;
    backdropShiftFactor?: number | null;
    /** Фактический сдвиг ориентира: 0.95 → −0.05. null — цену не двигали. */
    backdropAdjustment?: number | null;
    backdropAdjustmentApplied?: boolean;
    /** Активный стакан этого среза. null — стакан не передавали. */
    orderBookMetrics?: OrderBookMetrics | null;
  };
}

/** Активное объявление. Цена в TON. Оцениваемый лот в массив не класть. */
export interface ActiveListing {
  price: number;
  collection: string;
  model?: string | null;
  backdrop?: string | null;
  createdAt?: string | number | null;
  id?: string | null;
}

export interface OrderBookMetrics {
  activeFloor: number;
  cheaperListingsCount: number;
  listingsBelowTarget: number;
  /** null — продаж в день нет, очередь не переводится в дни. */
  liquidityOverhangDays: number | null;
  targetSellPrice: number;
  activeCount: number;
  referenceCapped: boolean;
  /** Ближайший чужой листинг строго выше текущей цены. */
  nextAskPrice: number | null;
}

function nanoToTon(nano: number): number {
  return nano / NANO;
}

function emptyStats(
  collection: string,
  model: string,
  days: number,
  backdrop?: string,
): PriceStats {
  return {
    collection,
    model,
    backdrop,
    days,
    samples: 0,
    min: 0,
    max: 0,
    avg: 0,
    median: 0,
    p25: 0,
    p75: 0,
    last: 0,
    lastTs: null,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function buildStatsFromAmounts(
  collection: string,
  model: string,
  days: number,
  amountsNano: number[],
  lastRow: { amount_nano: number; ts: number } | undefined,
  backdrop?: string,
): PriceStats {
  if (amountsNano.length === 0) {
    return emptyStats(collection, model, days, backdrop);
  }
  const tons = amountsNano.map(nanoToTon).sort((a, b) => a - b);
  const sum = tons.reduce((a, b) => a + b, 0);
  const last = lastRow ? nanoToTon(lastRow.amount_nano) : tons[tons.length - 1];
  return {
    collection,
    model,
    backdrop,
    days,
    samples: tons.length,
    min: tons[0],
    max: tons[tons.length - 1],
    avg: sum / tons.length,
    median: percentile(tons, 0.5),
    p25: percentile(tons, 0.25),
    p75: percentile(tons, 0.75),
    last,
    lastTs: lastRow?.ts ?? null,
  };
}

const salesByModelStmt = db.prepare(`
  SELECT amount_nano FROM sales
  WHERE collection_name = ? AND model_name = ? AND ts >= ?
  ORDER BY amount_nano ASC
`);

const lastSaleByModelStmt = db.prepare(`
  SELECT amount_nano, ts FROM sales
  WHERE collection_name = ? AND model_name = ? AND ts >= ?
  ORDER BY ts DESC LIMIT 1
`);

const salesByModelBackdropStmt = db.prepare(`
  SELECT amount_nano FROM sales
  WHERE collection_name = ? AND model_name = ? AND backdrop_name = ? AND ts >= ?
  ORDER BY amount_nano ASC
`);

const lastSaleByModelBackdropStmt = db.prepare(`
  SELECT amount_nano, ts FROM sales
  WHERE collection_name = ? AND model_name = ? AND backdrop_name = ? AND ts >= ?
  ORDER BY ts DESC LIMIT 1
`);

const salesByCollectionStmt = db.prepare(`
  SELECT amount_nano FROM sales
  WHERE collection_name = ? AND ts >= ?
  ORDER BY amount_nano ASC
`);

const lastSaleByCollectionStmt = db.prepare(`
  SELECT amount_nano, ts FROM sales
  WHERE collection_name = ? AND ts >= ?
  ORDER BY ts DESC LIMIT 1
`);

const countSalesModelStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM sales
  WHERE collection_name = ? AND model_name = ? AND ts >= ?
`);

const countSalesModelBackdropStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM sales
  WHERE collection_name = ? AND model_name = ? AND backdrop_name = ? AND ts >= ?
`);

const salesByCollectionBackdropStmt = db.prepare(`
  SELECT amount_nano FROM sales
  WHERE collection_name = ? AND backdrop_name = ? AND ts >= ?
  ORDER BY amount_nano ASC
`);

const lastSaleByCollectionBackdropStmt = db.prepare(`
  SELECT amount_nano, ts FROM sales
  WHERE collection_name = ? AND backdrop_name = ? AND ts >= ?
  ORDER BY ts DESC LIMIT 1
`);

const countSalesCollectionStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM sales
  WHERE collection_name = ? AND ts >= ?
`);

const countSalesCollectionBackdropStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM sales
  WHERE collection_name = ? AND backdrop_name = ? AND ts >= ?
`);

const latestFloorStmt = db.prepare(`
  SELECT floor_nano FROM model_prices
  WHERE collection_name = ? AND model_name = ?
  ORDER BY ts DESC LIMIT 1
`);

const priceHistoryStmt = db.prepare(`
  SELECT ts, floor_nano FROM model_prices
  WHERE collection_name = ? AND model_name = ? AND ts >= ?
  ORDER BY ts ASC
`);

const collectionPriceHistoryStmt = db.prepare(`
  SELECT ts, floor_nano FROM collection_prices
  WHERE collection_name = ? AND ts >= ?
  ORDER BY ts ASC
`);

const saleByIdStmt = db.prepare(`
  SELECT
    id, collection_name, model_name, backdrop_name, amount_nano, ts
  FROM sales WHERE id = ?
`);

function cutoffTs(days: number): number {
  return nowTs() - days * 86400;
}

function sliceAmountNanos(
  collection: string,
  model: string,
  backdrop: string,
  since: number,
): number[] {
  if (model && backdrop) {
    return (
      salesByModelBackdropStmt.all(collection, model, backdrop, since) as {
        amount_nano: number;
      }[]
    ).map((r) => r.amount_nano);
  }
  if (model) {
    return (
      salesByModelStmt.all(collection, model, since) as { amount_nano: number }[]
    ).map((r) => r.amount_nano);
  }
  if (backdrop) {
    return (
      salesByCollectionBackdropStmt.all(collection, backdrop, since) as {
        amount_nano: number;
      }[]
    ).map((r) => r.amount_nano);
  }
  return (
    salesByCollectionStmt.all(collection, since) as { amount_nano: number }[]
  ).map((r) => r.amount_nano);
}

export function getModelPriceStats(
  collection: string,
  model: string,
  days = 7,
): PriceStats {
  const since = cutoffTs(days);
  const rows = salesByModelStmt.all(collection, model, since) as {
    amount_nano: number;
  }[];
  const last = lastSaleByModelStmt.get(collection, model, since) as
    | { amount_nano: number; ts: number }
    | undefined;
  return buildStatsFromAmounts(
    collection,
    model,
    days,
    rows.map((r) => r.amount_nano),
    last,
  );
}

export function getModelBackdropStats(
  collection: string,
  model: string,
  backdrop: string,
  days = 7,
): PriceStats {
  const since = cutoffTs(days);
  const rows = salesByModelBackdropStmt.all(
    collection,
    model,
    backdrop,
    since,
  ) as { amount_nano: number }[];
  const last = lastSaleByModelBackdropStmt.get(
    collection,
    model,
    backdrop,
    since,
  ) as { amount_nano: number; ts: number } | undefined;
  return buildStatsFromAmounts(
    collection,
    model,
    days,
    rows.map((r) => r.amount_nano),
    last,
    backdrop,
  );
}

export function getCollectionBackdropStats(
  collection: string,
  backdrop: string,
  days = 7,
): PriceStats {
  const since = cutoffTs(days);
  const rows = salesByCollectionBackdropStmt.all(collection, backdrop, since) as {
    amount_nano: number;
  }[];
  const last = lastSaleByCollectionBackdropStmt.get(collection, backdrop, since) as
    | { amount_nano: number; ts: number }
    | undefined;
  return buildStatsFromAmounts(
    collection,
    '',
    days,
    rows.map((r) => r.amount_nano),
    last,
    backdrop,
  );
}

export function getCollectionStats(
  collection: string,
  days = 7,
): PriceStats {
  const since = cutoffTs(days);
  const rows = salesByCollectionStmt.all(collection, since) as {
    amount_nano: number;
  }[];
  const last = lastSaleByCollectionStmt.get(collection, since) as
    | { amount_nano: number; ts: number }
    | undefined;
  return buildStatsFromAmounts(
    collection,
    '',
    days,
    rows.map((r) => r.amount_nano),
    last,
  );
}

/** Надёжная оценка по окну (7д или расширенные 30д). */
export const MIN_SAMPLES_TO_EVALUATE = 10;
/** Ниже — срез ничего не доказал. От 5 до 9 — слабый доп. сигнал, не самостоятельный вердикт. */
export const WEAK_SAMPLES = 5;
/** Если за основное окно меньше 10 продаж — смотрим это окно как extended evidence. */
export const EXTENDED_WINDOW_DAYS = 30;
/** |median7−median30|/median30: до 15% можно брать extended как итог, 15–30% только как справка, выше — 30д не ориентир. */
export const PRICE_STABILITY_OK = 0.15;
export const PRICE_STABILITY_MAX = 0.3;
/** Extended buy требует запас сверх обычных порогов: 30д менее актуальны. */
export const EXTENDED_BUY_EXTRA = 0.02;
/** Свежее окно на том же срезе: детектор сдвига рынка, не замена 30д. */
export const RECENT_WINDOW_DAYS = 3;
/** Меньше — тренд неизвестен (2 продажи ≠ «рынок рухнул»). */
export const MIN_SAMPLES_FOR_TREND = 5;
/** (median3−median7)/median7 ≤ этого — для решения берём медиану 3д. */
export const TREND_DOWN_THRESHOLD = -0.1;
/** Доля продаж за 3д ниже медианы 7д, тоже включает защиту. */
export const RECENT_BELOW_BASE_MIN = 0.75;
/** Доля продаж за 3д строго выше медианы 7д: вместе с ростом ≥10% включает бычий ориентир. */
export const RECENT_ABOVE_BASE_MIN = 0.75;
/** Какую долю роста 3д к 7д переносим в ориентир. Остальное — запас на откат. */
export const BULLISH_HAIRCUT = 0.7;
/**
 * Black / Onyx Black: если коллекция+фон ещё не набрала 10 продаж,
 * модель+фон может задать цену уже от 3 продаж.
 */
export const PREMIUM_MODEL_BACKDROP_MIN = 3;
/**
 * Обычный фон: коридор и доля сдвига задаёт объём 30д/7д
 * (getBackdropAdjustmentConfig), не фиксированные 0.80–1.20.
 * Полный сдвиг (high) и ≥10 продаж за 7д — model+backdrop может быть primary.
 */
export const BACKDROP_SUPPORT_MIN = 5;
/** Лот не ниже флора, если он в пределах 0.5% от минимального листинга. */
export const ORDER_BOOK_FLOOR_SPREAD = 0.005;
/** Историческая медиана не выше текущего флора больше чем на 3%. */
export const ORDER_BOOK_FLOOR_CAP = 1.03;
export const ORDER_BOOK_WALL_LISTINGS = 3;
export const ORDER_BOOK_OVERHANG_WATCH_DAYS = 2;
export const ORDER_BOOK_OVERHANG_SKIP_DAYS = 5;

/**
 * Уверенность от размера выборки того окна, по которому считаем цену.
 * Extended (30д вместо пустых 7д) всегда low — это задаёт вызывающий код.
 */
export function confidenceFromSamples(
  samples: number,
): StatsWithConfidence['confidence'] {
  if (samples >= 100) return 'high';
  if (samples >= 30) return 'medium';
  return 'low';
}

function confidenceForScope(
  _scope: StatsWithConfidence['scope'],
  samples: number,
): StatsWithConfidence['confidence'] {
  return confidenceFromSamples(samples);
}

function iqrRatioOf(stats: PriceStats): number | null {
  if (stats.samples < 4 || stats.median <= 0) return null;
  return (stats.p75 - stats.p25) / stats.median;
}

/** Порог продаж/день для коллекции. Редкий фон этим не меряем. */
function minCollectionSalesPerDay(medianTon: number): number {
  if (medianTon <= 0) return 0.2;
  if (medianTon < 10) return 0.5;
  if (medianTon <= 100) return 0.2;
  return 0.05;
}

/**
 * Ликвидность сделки: сначала коллекция, затем мягко модель.
 * Срез «модель+фон» (монохром) на ликвидность не смотрит — у него своя медиана цены.
 */
function liquidityBlockReason(
  collection: string,
  model: string,
  days: number,
): string | null {
  const coll = getCollectionStats(collection, days);
  const collPerDay = coll.samples / days;
  const minColl = minCollectionSalesPerDay(coll.median);
  if (coll.samples < 30 || collPerDay < minColl) {
    return (
      `коллекция неликвидная: ${coll.samples} продаж, ` +
      `${collPerDay.toFixed(2)}/день (нужно ≥ 30 и ≥ ${minColl}/день)`
    );
  }
  if (!model) return null;
  const modelStats = getModelPriceStats(collection, model, days);
  if (modelStats.samples < 5) {
    return `у модели мало продаж (${modelStats.samples} за ${days} дн.)`;
  }
  return null;
}

export function getStatsSmart(
  collection: string,
  model: string,
  backdrop: string | null | undefined,
  days = 7,
): StatsWithConfidence {
  const backdropTrimmed = backdrop?.trim() ?? '';

  if (backdropTrimmed) {
    const mb = getModelBackdropStats(
      collection,
      model,
      backdropTrimmed,
      days,
    );
    if (mb.samples >= 3) {
      return {
        ...mb,
        scope: 'model+backdrop',
        confidence: confidenceForScope('model+backdrop', mb.samples),
      };
    }
  }

  const m = getModelPriceStats(collection, model, days);
  if (m.samples >= 3) {
    return {
      ...m,
      scope: 'model',
      confidence: confidenceForScope('model', m.samples),
    };
  }

  const c = getCollectionStats(collection, days);
  if (c.samples >= 3) {
    return {
      ...c,
      model,
      scope: 'collection',
      confidence: confidenceForScope('collection', c.samples),
    };
  }

  return {
    ...m,
    scope: 'model',
    confidence: 'low',
  };
}

export function getLatestFloor(
  collection: string,
  model: string,
): number | null {
  const row = latestFloorStmt.get(collection, model) as
    | { floor_nano: number | null }
    | undefined;
  if (!row || row.floor_nano == null) return null;
  return row.floor_nano;
}

/** Статистика ровно по выбранному срезу, без отката на более широкий. */
export function getStatsExact(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  days = 30,
): StatsWithConfidence {
  const modelTrimmed = model?.trim() ?? '';
  const backdropTrimmed = backdrop?.trim() ?? '';

  if (modelTrimmed && backdropTrimmed) {
    const stats = getModelBackdropStats(
      collection,
      modelTrimmed,
      backdropTrimmed,
      days,
    );
    return {
      ...stats,
      scope: 'model+backdrop',
      confidence: confidenceForScope('model+backdrop', stats.samples),
    };
  }

  if (modelTrimmed) {
    const stats = getModelPriceStats(collection, modelTrimmed, days);
    return {
      ...stats,
      scope: 'model',
      confidence: confidenceForScope('model', stats.samples),
    };
  }

  if (backdropTrimmed) {
    const stats = getCollectionBackdropStats(
      collection,
      backdropTrimmed,
      days,
    );
    return {
      ...stats,
      scope: 'collection+backdrop',
      confidence: confidenceForScope('collection', stats.samples),
    };
  }

  const stats = getCollectionStats(collection, days);
  return {
    ...stats,
    scope: 'collection',
    confidence: confidenceForScope('collection', stats.samples),
  };
}

function salesCountExact(
  collection: string,
  model: string,
  backdrop: string,
  since: number,
): number {
  if (model && backdrop) {
    return (
      countSalesModelBackdropStmt.get(collection, model, backdrop, since) as {
        c: number;
      }
    ).c;
  }
  if (model) {
    return (
      countSalesModelStmt.get(collection, model, since) as { c: number }
    ).c;
  }
  if (backdrop) {
    return (
      countSalesCollectionBackdropStmt.get(collection, backdrop, since) as {
        c: number;
      }
    ).c;
  }
  return (countSalesCollectionStmt.get(collection, since) as { c: number }).c;
}

export function getSalesPerDay(
  collection: string,
  model: string,
  backdrop: string | null | undefined,
  days = 7,
): number {
  const since = cutoffTs(days);
  const backdropTrimmed = backdrop?.trim() ?? '';
  const row = backdropTrimmed
    ? countSalesModelBackdropStmt.get(
        collection,
        model,
        backdropTrimmed,
        since,
      )
    : countSalesModelStmt.get(collection, model, since);
  const count = (row as { c: number }).c;
  return count / days;
}

function netMargin(
  listingPrice: number,
  referencePrice: number,
  feeRate: number,
): number {
  if (listingPrice <= 0) return 0;
  return (referencePrice * (1 - feeRate) - listingPrice) / listingPrice;
}

function discountVsMedian(listingPrice: number, median: number): number {
  if (median <= 0) return 0;
  return (median - listingPrice) / median;
}

export function evaluateListing(
  collection: string,
  model: string,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
): DealEvaluation {
  const stats = getStatsSmart(collection, model, backdrop, days);
  const referencePrice = stats.median;
  const discount = discountVsMedian(listingPrice, referencePrice);
  const salesPerDay = getSalesPerDay(collection, model, backdrop, days);
  const margin = netMargin(listingPrice, referencePrice, feeRate);

  let verdict: DealEvaluation['verdict'] = 'fair';
  if (discount >= 0.15) verdict = 'buy';
  else if (discount < -0.05) verdict = 'expensive';

  return {
    listingPrice,
    referencePrice,
    discount,
    verdict,
    confidence: stats.confidence,
    samples: stats.samples,
    salesPerDay,
    netMargin: margin,
  };
}

export function decide(
  collection: string,
  model: string,
  backdrop: string | null | undefined,
  listingPrice: number,
  floorPrice: number,
  days = 7,
  feeRate = 0.05,
): DealVerdict {
  const stats = getStatsSmart(collection, model, backdrop, days);
  const referencePrice = stats.median;
  const discount = discountVsMedian(listingPrice, referencePrice);
  const salesPerDay = getSalesPerDay(collection, model, backdrop, days);
  const margin = netMargin(listingPrice, referencePrice, feeRate);

  const discountVsFloor =
    floorPrice > 0 ? (floorPrice - listingPrice) / floorPrice : 0;

  const metrics: DealVerdict['metrics'] = {
    listingPrice,
    referencePrice,
    floorPrice,
    discountVsMedian: discount,
    discountVsFloor,
    netMargin: margin,
    confidence: stats.confidence,
    samples: stats.samples,
    salesPerDay,
  };

  if (stats.samples < MIN_SAMPLES_TO_EVALUATE) {
    return {
      action: 'skip',
      reason: `мало данных о продажах (${stats.samples}, нужно ≥ ${MIN_SAMPLES_TO_EVALUATE})`,
      metrics,
    };
  }

  if (salesPerDay < 0.2) {
    return {
      action: 'skip',
      reason: 'неликвид (< 0.2 продаж в день)',
      metrics,
    };
  }

  if (
    discount >= 0.2 &&
    margin >= 0.15 &&
    stats.confidence !== 'low'
  ) {
    const pct = Math.round(discount * 100);
    const marginPct = Math.round(margin * 100);
    return {
      action: 'buy',
      reason: `дешевле медианы на ${pct}%, чистая маржа ${marginPct}%`,
      metrics,
    };
  }

  if (discount >= 0.1) {
    return {
      action: 'watch',
      reason: 'умеренный дисконт, но мало для покупки',
      metrics,
    };
  }

  return {
    action: 'skip',
    reason: 'цена у медианы или выше',
    metrics,
  };
}

function scopeLabel(scope: StatsWithConfidence['scope']): string {
  switch (scope) {
    case 'model+backdrop':
      return 'модель и фон';
    case 'model':
      return 'модель';
    case 'collection+backdrop':
      return 'коллекция и фон';
    default:
      return 'коллекция';
  }
}

function priceStabilityRatio(
  median7: number,
  median30: number,
): number | null {
  if (median7 <= 0 || median30 <= 0) return null;
  return Math.abs(median7 - median30) / median30;
}

type Confidence = StatsWithConfidence['confidence'];

function listingMatchesScope(
  listing: ActiveListing,
  scope: StatsWithConfidence['scope'],
  collection: string,
  model: string,
  backdrop: string,
): boolean {
  if (listing.collection.trim() !== collection) return false;
  if (scope === 'collection') return true;
  if (scope === 'model') return (listing.model?.trim() ?? '') === model;
  if (scope === 'collection+backdrop') {
    return (listing.backdrop?.trim() ?? '') === backdrop;
  }
  return (
    (listing.model?.trim() ?? '') === model &&
    (listing.backdrop?.trim() ?? '') === backdrop
  );
}

function listingsForScope(
  listings: ActiveListing[] | null | undefined,
  scope: StatsWithConfidence['scope'],
  collection: string,
  model: string,
  backdrop: string,
): ActiveListing[] | null {
  if (!listings) return null;
  return listings.filter((row) =>
    listingMatchesScope(row, scope, collection, model, backdrop),
  );
}

function buildOrderBookMetrics(
  asks: ActiveListing[] | null,
  listingPrice: number,
  salesReference: number,
  salesPerDay: number,
  feeRate: number,
  requiredMargin: number,
): OrderBookMetrics | null {
  if (!asks) return null;
  const prices = asks
    .map((row) => row.price)
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  const activeFloor = prices[0] ?? 0;
  const cheaperListingsCount = prices.filter((price) => price <= listingPrice).length;
  const effectiveReference =
    activeFloor > 0
      ? Math.min(salesReference, activeFloor * ORDER_BOOK_FLOOR_CAP)
      : salesReference;
  const grossFromMargin =
    feeRate < 1 ? (listingPrice * (1 + requiredMargin)) / (1 - feeRate) : listingPrice;
  const targetSellPrice =
    effectiveReference > 0
      ? Math.min(grossFromMargin, effectiveReference)
      : grossFromMargin;
  const listingsBelowTarget = prices.filter((price) => price < targetSellPrice).length;
  const liquidityOverhangDays =
    salesPerDay > 0 ? listingsBelowTarget / salesPerDay : null;
  const nextAskPrice =
    prices.find((price) => price > listingPrice * (1 + ORDER_BOOK_FLOOR_SPREAD)) ??
    null;
  return {
    activeFloor,
    cheaperListingsCount,
    listingsBelowTarget,
    liquidityOverhangDays,
    targetSellPrice,
    activeCount: prices.length,
    referenceCapped:
      activeFloor > 0 &&
      salesReference > 0 &&
      effectiveReference < salesReference - 1e-9,
    nextAskPrice,
  };
}

function capReferenceByFloor(reference: number, book: OrderBookMetrics | null): number {
  if (!book || book.activeFloor <= 0 || reference <= 0) return reference;
  return Math.min(reference, book.activeFloor * ORDER_BOOK_FLOOR_CAP);
}

/**
 * 3.1–3.2. Стакан не передан или пуст — вердикт не трогаем.
 * Дешевле флора больше чем на 0.5% — правило 3.1 не срабатывает.
 */
function applyOrderBookVeto(
  action: DealVerdict['action'],
  reason: string,
  listingPrice: number,
  feeRate: number,
  book: OrderBookMetrics | null,
): { action: DealVerdict['action']; reason: string } {
  if (!book || book.activeCount === 0 || book.activeFloor <= 0) {
    return { action, reason };
  }
  if (action !== 'buy' && action !== 'watch') return { action, reason };

  const notBelowFloor =
    listingPrice >= book.activeFloor * (1 - ORDER_BOOK_FLOOR_SPREAD);
  const someoneCheaper =
    book.activeFloor < listingPrice * (1 - ORDER_BOOK_FLOOR_SPREAD);
  if (someoneCheaper) {
    return {
      action: 'skip',
      reason: `${reason}; cheaper_active_listings_exist`,
    };
  }
  if (notBelowFloor) {
    if (action !== 'buy') return { action, reason };
    const next = book.nextAskPrice;
    const { buyMinMargin } = getSalesVerdictThresholds();
    const marginToNext =
      next != null && next > listingPrice ? netMargin(listingPrice, next, feeRate) : -1;
    if (marginToNext >= buyMinMargin) {
      return {
        action: 'watch',
        reason: `${reason}; listing_at_active_floor`,
      };
    }
    return {
      action: 'skip',
      reason: `${reason}; cheaper_active_listings_exist`,
    };
  }

  if (action === 'buy' && book.listingsBelowTarget > ORDER_BOOK_WALL_LISTINGS) {
    const overhang = book.liquidityOverhangDays;
    const deep = overhang == null || overhang > ORDER_BOOK_OVERHANG_SKIP_DAYS;
    if (deep || (overhang != null && overhang > ORDER_BOOK_OVERHANG_WATCH_DAYS)) {
      return {
        action: deep ? 'skip' : 'watch',
        reason: `${reason}; sell_wall_liquidity_block`,
      };
    }
  }
  return { action, reason };
}

/**
 * Вердикт одного среза.
 * Мало продаж — insufficient/weak, не skip: срез ничего не доказал.
 * Skip только когда выборка достаточна и по ней лот покупать не стоит.
 * Если за `days` (обычно 7) меньше 10 продаж, медиана 30д может стать ориентиром
 * (evidence=extended, confidence=low), пока медианы не разъехались больше чем на 30%.
 * На любом срезе отдельно считаются 3 дня: если рынок просел (тренд ≤ −10%
 * или ≥75% свежих сделок ниже медианы 7д, при ≥5 продажах за 3д),
 * buy/watch/skip идут от медианы 3д, а не от устаревшей 7д/30д.
 */
export function decideFromSales(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
  activeListings?: ActiveListing[] | null,
): DealVerdict & { scope: StatsWithConfidence['scope'] } {
  const modelTrimmed = model?.trim() ?? '';
  const backdropTrimmed = backdrop?.trim() ?? '';
  const stats7 = getStatsExact(collection, modelTrimmed, backdropTrimmed, days);
  const slice = scopeLabel(stats7.scope);
  const feePct = Math.round(feeRate * 1000) / 10;

  let evidence: EvidenceTier = 'insufficient';
  let priced = stats7;
  let windowDays = days;
  let samples30: number | null = null;
  let stability: number | null = null;
  let stabilityNote = '';

  if (stats7.samples >= MIN_SAMPLES_TO_EVALUATE) {
    evidence = 'reliable';
  } else if (days < EXTENDED_WINDOW_DAYS) {
    const stats30 = getStatsExact(
      collection,
      modelTrimmed,
      backdropTrimmed,
      EXTENDED_WINDOW_DAYS,
    );
    samples30 = stats30.samples;
    stability =
      stats7.samples >= 2
        ? priceStabilityRatio(stats7.median, stats30.median)
        : null;

    const diverged =
      stability !== null && stability > PRICE_STABILITY_MAX;
    if (stats30.samples >= MIN_SAMPLES_TO_EVALUATE && !diverged) {
      evidence = 'extended';
      priced = stats30;
      windowDays = EXTENDED_WINDOW_DAYS;
      if (stability !== null && stability >= PRICE_STABILITY_OK) {
        stabilityNote = `, медианы 7д/30д разошлись на ${Math.round(stability * 100)}%`;
      }
    } else if (stats7.samples >= WEAK_SAMPLES) {
      evidence = 'weak';
      if (diverged && stability !== null) {
        stabilityNote = `, 30д не ориентир (расхождение ${Math.round(stability * 100)}%)`;
      }
    } else {
      evidence = 'insufficient';
      if (diverged && stability !== null) {
        stabilityNote = `, 30д не ориентир (расхождение ${Math.round(stability * 100)}%)`;
      }
    }
  } else if (stats7.samples >= WEAK_SAMPLES) {
    evidence = 'weak';
  }

  const stats3 =
    days > RECENT_WINDOW_DAYS
      ? getStatsExact(
          collection,
          modelTrimmed,
          backdropTrimmed,
          RECENT_WINDOW_DAYS,
        )
      : null;
  const samples3 = stats3 ? stats3.samples : null;
  const median7 = stats7.median;
  const median3 = stats3 && stats3.samples > 0 ? stats3.median : null;
  const recentNanos =
    samples3 != null && samples3 > 0
      ? sliceAmountNanos(
          collection,
          modelTrimmed,
          backdropTrimmed,
          cutoffTs(RECENT_WINDOW_DAYS),
        )
      : [];
  let trend: number | null = null;
  let trendDirection: 'down' | 'up' | 'flat' | 'unknown' = 'unknown';
  let recentBelow: number | null = null;
  let recentAbove: number | null = null;
  if (recentNanos.length > 0 && median7 > 0) {
    const tons = recentNanos.map(nanoToTon);
    recentBelow = tons.filter((n) => n < median7).length / tons.length;
    recentAbove = tons.filter((n) => n > median7).length / tons.length;
  }
  if (
    samples3 != null &&
    samples3 >= MIN_SAMPLES_FOR_TREND &&
    median7 > 0 &&
    median3 != null &&
    median3 > 0
  ) {
    trend = (median3 - median7) / median7;
    if (trend <= TREND_DOWN_THRESHOLD) trendDirection = 'down';
    else if (trend >= -TREND_DOWN_THRESHOLD) trendDirection = 'up';
    else trendDirection = 'flat';
  }
  const ratioDown =
    samples3 != null &&
    samples3 >= MIN_SAMPLES_FOR_TREND &&
    recentBelow != null &&
    recentBelow >= RECENT_BELOW_BASE_MIN;
  const trendDown = trendDirection === 'down' || ratioDown;
  if (trendDown) trendDirection = 'down';

  const baseReferencePrice = priced.median;
  const bullishUp =
    samples3 != null &&
    samples3 >= MIN_SAMPLES_FOR_TREND &&
    trend != null &&
    trend >= -TREND_DOWN_THRESHOLD &&
    recentAbove != null &&
    recentAbove >= RECENT_ABOVE_BASE_MIN &&
    median3 != null &&
    median3 > 0 &&
    median7 > 0;
  let trendStatus: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let salesReference = baseReferencePrice;
  let decisionDays = windowDays;
  if (trendDown && median3 != null && median3 > 0) {
    trendStatus = 'bearish';
    salesReference = median3;
    decisionDays = RECENT_WINDOW_DAYS;
  } else if (bullishUp && median3 != null) {
    trendStatus = 'bullish';
    salesReference = median7 + (median3 - median7) * BULLISH_HAIRCUT;
    decisionDays = RECENT_WINDOW_DAYS;
  }
  const trendAdjusted = trendStatus === 'bearish';
  const bullishDiscountApplied = trendStatus === 'bullish';
  const salesPerDay = windowDays > 0 ? priced.samples / windowDays : 0;
  const requiredMargin = getSalesVerdictThresholds().buyMinMargin;
  const orderBook = buildOrderBookMetrics(
    listingsForScope(
      activeListings,
      stats7.scope,
      collection,
      modelTrimmed,
      backdropTrimmed,
    ),
    listingPrice,
    salesReference,
    salesPerDay,
    feeRate,
    requiredMargin,
  );
  const referencePrice = capReferenceByFloor(salesReference, orderBook);
  const discount = discountVsMedian(listingPrice, referencePrice);
  const margin = netMargin(listingPrice, referencePrice, feeRate);
  const confidence: Confidence =
    evidence === 'extended' ? 'low' : confidenceFromSamples(priced.samples);
  const trendNote = trendAdjusted
    ? `; свежий рынок ${RECENT_WINDOW_DAYS}д ${median3!.toFixed(2)} TON vs 7д ${median7.toFixed(2)} (${trend != null ? `${Math.round(trend * 100)}%` : 'доля ниже базы'}${recentBelow != null ? `, ниже 7д ${Math.round(recentBelow * 100)}%` : ''})`
    : bullishDiscountApplied
      ? `; рост ${RECENT_WINDOW_DAYS}д ${median3!.toFixed(2)} TON vs 7д ${median7.toFixed(2)}, ориентир ${salesReference.toFixed(2)} TON (haircut ${Math.round(BULLISH_HAIRCUT * 100)}%)`
      : '';

  const metrics: DealVerdict['metrics'] = {
    listingPrice,
    referencePrice,
    floorPrice: 0,
    discountVsMedian: discount,
    discountVsFloor: 0,
    netMargin: margin,
    confidence,
    samples: priced.samples,
    salesPerDay,
    windowDays: decisionDays,
    samples7: stats7.samples,
    samples30,
    priceStability: stability,
    median7,
    median3,
    samples3,
    trend,
    trendDirection,
    trendAdjusted,
    trendStatus,
    bullishDiscountApplied,
    rawMedian3: median3,
    trendView: {
      status: trendStatus,
      median7,
      median3,
      referenceUsed: referencePrice,
    },
    recentBelowBaseRatio: recentBelow,
    baseReferencePrice,
    orderBookMetrics: orderBook,
  };

  const withBook = (
    action: DealVerdict['action'],
    evidenceOut: EvidenceTier,
    reason: string,
    metricsOut: DealVerdict['metrics'] = metrics,
  ): DealVerdict & { scope: StatsWithConfidence['scope'] } => {
    const veto = applyOrderBookVeto(
      action,
      reason,
      listingPrice,
      feeRate,
      metricsOut.orderBookMetrics ?? orderBook,
    );
    return {
      action: veto.action,
      evidence: evidenceOut,
      scope: stats7.scope,
      reason: veto.reason,
      metrics: metricsOut,
    };
  };

  if (evidence === 'insufficient' || evidence === 'weak') {
    const n30 = samples30 ?? 0;
    const kind =
      evidence === 'weak'
        ? `слабая выборка (${stats7.samples} за ${days}д, за 30д ${n30}) — не самостоятельная оценка`
        : `мало данных (за ${days}д ${stats7.samples}, за 30д ${n30}) — срез ничего не доказал`;
    return {
      action: 'insufficient',
      evidence,
      scope: stats7.scope,
      reason: `срез «${slice}»: ${kind}${stabilityNote}`,
      metrics,
    };
  }

  const pct = Math.round(Math.abs(discount) * 100);
  const marginPct = Math.round(margin * 100);
  const windowLabel = trendAdjusted
    ? `${slice}, ${RECENT_WINDOW_DAYS}д`
    : evidence === 'extended'
      ? `${slice}, ${windowDays}д`
      : slice;
  const { buyMinDiscount, buyMinMargin, watchMinDiscount } =
    getSalesVerdictThresholds();
  const marginNeed =
    buyMinMargin + (bullishDiscountApplied ? getBullishMarginPremium() : 0);
  const iqr = iqrRatioOf(trendAdjusted && stats3 ? stats3 : priced);
  const regularBuy = discount >= buyMinDiscount && margin >= marginNeed;
  const extendedBuy =
    discount >= buyMinDiscount + EXTENDED_BUY_EXTRA &&
    margin >= marginNeed + EXTENDED_BUY_EXTRA;
  const freshMove = trendAdjusted || bullishDiscountApplied;
  const priceOk = evidence === 'extended' && !freshMove ? extendedBuy : regularBuy;
  const extendedShort =
    evidence === 'extended' && !freshMove && regularBuy && !extendedBuy;

  if (priceOk && iqr !== null && iqr > 0.5) {
    return {
      action: 'insufficient',
      evidence: 'weak',
      scope: stats7.scope,
      reason: `срез «${windowLabel}»: медиана ненадёжна (IQR/median ${iqr.toFixed(2)}) — не самостоятельная оценка`,
      metrics: { ...metrics, confidence: 'low' },
    };
  }

  if (priceOk) {
    const illiquid = liquidityBlockReason(collection, modelTrimmed, days);
    if (illiquid) {
      return {
        action: 'skip',
        evidence,
        scope: stats7.scope,
        reason: illiquid,
        metrics,
      };
    }
    return withBook(
      'buy',
      evidence,
      `дешевле медианы (${windowLabel}) на ${pct}%, после комиссии ${feePct}% маржа ~${marginPct}%${stabilityNote}${trendNote}`,
    );
  }
  if (discount >= watchMinDiscount && margin > 0) {
    const short =
      extendedShort
        ? `; для buy по 30д нужен запас +${Math.round(EXTENDED_BUY_EXTRA * 100)} п.п. к порогам`
        : '';
    return withBook(
      'watch',
      evidence,
      `дисконт к медиане (${windowLabel}) ${pct}%, маржа после ${feePct}% — ${marginPct}%${stabilityNote}${trendNote}${short}`,
    );
  }
  if (discount < -0.05) {
    return {
      action: 'skip',
      evidence,
      scope: stats7.scope,
      reason: `дороже медианы продаж (${windowLabel}) на ${pct}%${stabilityNote}${trendNote}`,
      metrics,
    };
  }
  if (margin < 0) {
    return {
      action: 'skip',
      evidence,
      scope: stats7.scope,
      reason: `после комиссии ${feePct}% перепродажа в минус (маржа ${marginPct}%)${stabilityNote}${trendNote}`,
      metrics,
    };
  }
  return {
    action: 'skip',
    evidence,
    scope: stats7.scope,
    reason: `цена около медианы продаж (${windowLabel})${stabilityNote}${trendNote}`,
    metrics,
  };
}

export interface ScopedLotEvaluation {
  scope: StatsWithConfidence['scope'];
  model: string | null;
  backdrop: string | null;
  verdict: DealVerdict & { scope: StatsWithConfidence['scope'] };
}

type BackdropDiag = Pick<
  DealVerdict['metrics'],
  | 'backdropMedian'
  | 'backdropSamples7'
  | 'backdropSamples30'
  | 'backdropRatio'
  | 'backdropRatioClamped'
  | 'backdropTier'
  | 'backdropShiftFactor'
  | 'backdropAdjustment'
  | 'backdropAdjustmentApplied'
>;

function withBackdropDiag(
  s: ScopedLotEvaluation,
  diag: BackdropDiag,
): ScopedLotEvaluation {
  return {
    ...s,
    verdict: {
      ...s.verdict,
      metrics: { ...s.verdict.metrics, ...diag },
    },
  };
}

/**
 * Пересчёт buy/watch/skip от нового ориентира. Пороги те же, что в decideFromSales.
 * Слабый/ненадёжный срез не превращаем в самостоятельный вердикт.
 */
function repriceToReference(
  s: ScopedLotEvaluation,
  referencePrice: number,
  feeRate: number,
  collection: string,
  days: number,
  diag: BackdropDiag,
): ScopedLotEvaluation {
  if (
    s.verdict.evidence === 'insufficient' ||
    s.verdict.evidence === 'weak' ||
    s.verdict.reason.includes('медиана ненадёжна')
  ) {
    return withBackdropDiag(s, diag);
  }

  const listingPrice = s.verdict.metrics.listingPrice;
  const book = s.verdict.metrics.orderBookMetrics ?? null;
  const cappedReference = capReferenceByFloor(referencePrice, book);
  const discount = discountVsMedian(listingPrice, cappedReference);
  const margin = netMargin(listingPrice, cappedReference, feeRate);
  const metrics: DealVerdict['metrics'] = {
    ...s.verdict.metrics,
    ...diag,
    referencePrice: cappedReference,
    discountVsMedian: discount,
    netMargin: margin,
    orderBookMetrics: book
      ? {
          ...book,
          referenceCapped:
            book.referenceCapped || cappedReference < referencePrice - 1e-9,
        }
      : book,
  };
  const draft: ScopedLotEvaluation = {
    ...s,
    verdict: { ...s.verdict, metrics },
  };
  const action = priceActionFromMetrics(draft);
  if (!action) return draft;
  if (
    action === s.verdict.action &&
    Math.abs(referencePrice - s.verdict.metrics.referencePrice) < 1e-6
  ) {
    return draft;
  }

  const pct = Math.round(Math.abs(discount) * 100);
  const marginPct = Math.round(margin * 100);
  const feePct = Math.round(feeRate * 1000) / 10;
  const adjPct = Math.round((diag.backdropAdjustment ?? 0) * 100);
  const trendNote = s.verdict.metrics.trendAdjusted
    ? `; свежий рынок ${RECENT_WINDOW_DAYS}д`
    : '';
  const adjNote = `; фон ${adjPct >= 0 ? '+' : ''}${adjPct}% (${diag.backdropSamples7} продаж model+backdrop)${trendNote}`;

  let next = draft;
  let nextAction = action;
  let nextReason = `цена около медианы с учётом фона${adjNote}`;
  if (action === 'buy') {
    const illiquid = liquidityBlockReason(collection, s.model?.trim() ?? '', days);
    if (illiquid) {
      nextAction = 'skip';
      nextReason = illiquid;
    } else {
      nextReason = `дешевле медианы с учётом фона на ${pct}%, после комиссии ${feePct}% маржа ~${marginPct}%${adjNote}`;
    }
  } else if (action === 'watch') {
    nextReason = `дисконт к медиане с учётом фона ${pct}%, маржа после ${feePct}% — ${marginPct}%${adjNote}`;
  } else if (discount < -0.05) {
    nextReason = `дороже медианы с учётом фона на ${pct}%${adjNote}`;
  } else if (margin < 0) {
    nextReason = `после комиссии ${feePct}% перепродажа в минус (маржа ${marginPct}%)${adjNote}`;
  }
  next = withAction(draft, nextAction, nextReason);
  const veto = applyOrderBookVeto(
    next.verdict.action,
    next.verdict.reason,
    listingPrice,
    feeRate,
    next.verdict.metrics.orderBookMetrics ?? null,
  );
  if (veto.action === next.verdict.action && veto.reason === next.verdict.reason) {
    return next;
  }
  if (veto.action !== 'buy' && veto.action !== 'watch' && veto.action !== 'skip') {
    return next;
  }
  return withAction(next, veto.action, veto.reason);
}

/**
 * За границей коридора ratio не обрезается ступенькой, а затухает логарифмом.
 * Выше max: max + ln(1 + (raw − max)). Ниже min: min − ln(1 + (min − raw)).
 */
export function softClampRatio(raw: number, minBound: number, maxBound: number): number {
  if (raw > maxBound) return maxBound + Math.log(1 + (raw - maxBound));
  if (raw < minBound) return minBound - Math.log(1 + (minBound - raw));
  return raw;
}

export interface BackdropTierChoice {
  id: 'low' | 'mid' | 'high';
  min: number;
  max: number;
  shiftFactor: number;
}

/**
 * High: N30 и N7 дотягивают до high.
 * Low: N30 не выше low.maxSales30 или N7 ниже mid.minSales7.
 * Иначе mid, включая зазор «N30 уже high, но N7 ещё между mid и high».
 */
export function selectBackdropTier(
  samples7: number,
  samples30: number,
  cfg: BackdropAdjustmentConfig = getBackdropAdjustmentConfig(),
): BackdropTierChoice {
  const { lowVolume: low, midVolume: mid, highVolume: high } = cfg;
  if (samples30 >= high.minSales30 && samples7 >= high.minSales7) {
    return {
      id: 'high',
      min: high.range[0],
      max: high.range[1],
      shiftFactor: high.shiftFactor,
    };
  }
  const thin = samples30 <= low.maxSales30 || samples7 < mid.minSales7;
  if (!thin && samples7 >= mid.minSales7) {
    return {
      id: 'mid',
      min: mid.range[0],
      max: mid.range[1],
      shiftFactor: mid.shiftFactor,
    };
  }
  return {
    id: 'low',
    min: low.range[0],
    max: low.range[1],
    shiftFactor: low.shiftFactor,
  };
}

/**
 * Обычный фон: ratio = ориентир model+backdrop / ориентир модели (оба уже с 3д-трендом).
 * Коридор и доля сдвига зависят от продаж 30д и 7д. За границей коридора — soft clamp.
 * Полный сдвиг и ≥10 продаж за 7д — model+backdrop может стать primary.
 * Black / Onyx Black не трогаем.
 */
function applyOrdinaryBackdropAdjustment(
  scopes: ScopedLotEvaluation[],
  collection: string,
  days: number,
  feeRate: number,
): ScopedLotEvaluation[] {
  const modelSlice = scopes.find((s) => s.scope === 'model');
  const mb = scopes.find((s) => s.scope === 'model+backdrop');
  if (!modelSlice || !mb) return scopes;
  if (isBackdropEnabledForAnalysis(mb.backdrop)) return scopes;

  const n7 = samples7of(mb);
  const modelAnchor = modelSlice.verdict.metrics.referencePrice;
  const backdropPrice = mb.verdict.metrics.referencePrice;
  const ratio =
    modelAnchor > 0 && backdropPrice > 0 ? backdropPrice / modelAnchor : null;
  if (ratio == null || n7 < 1) return scopes;

  const n30 =
    mb.verdict.metrics.samples30 ??
    getStatsExact(
      collection,
      mb.model,
      mb.backdrop,
      EXTENDED_WINDOW_DAYS,
    ).samples;
  const tier = selectBackdropTier(n7, n30);
  const clamped = softClampRatio(ratio, tier.min, tier.max);
  const shift = tier.shiftFactor;
  const factor = 1 + shift * (clamped - 1);
  const adjustment = factor - 1;
  const fullLead =
    shift >= 1 && n7 >= MIN_SAMPLES_TO_EVALUATE && usableForPrimary(mb);
  const repriceTarget = fullLead ? mb : modelSlice;
  const canReprice =
    shift > 0 &&
    repriceTarget.verdict.evidence !== 'insufficient' &&
    repriceTarget.verdict.evidence !== 'weak' &&
    !repriceTarget.verdict.reason.includes('медиана ненадёжна');
  const applied = canReprice && Math.abs(adjustment) > 1e-9;
  const diag = backdropDiag(mb, ratio, adjustment, applied, {
    samples30: n30,
    clamped,
    tier: tier.id,
    shiftFactor: shift,
  });

  let nextModel = modelSlice;
  let nextMb = mb;
  if (canReprice) {
    const newRef = modelAnchor * factor;
    if (fullLead) {
      nextMb = repriceToReference(mb, newRef, feeRate, collection, days, diag);
      nextModel = withBackdropDiag(modelSlice, diag);
    } else {
      nextModel = repriceToReference(
        modelSlice,
        newRef,
        feeRate,
        collection,
        days,
        diag,
      );
      nextMb = withBackdropDiag(mb, diag);
    }
  } else {
    nextModel = withBackdropDiag(modelSlice, diag);
    nextMb = withBackdropDiag(mb, diag);
  }

  return scopes.map((s) => {
    if (s.scope === 'model') return nextModel;
    if (s.scope === 'model+backdrop') return nextMb;
    return s;
  });
}

function backdropDiag(
  mb: ScopedLotEvaluation,
  ratio: number | null,
  adjustment: number | null,
  applied: boolean,
  extra?: {
    samples30?: number | null;
    clamped?: number | null;
    tier?: 'low' | 'mid' | 'high' | null;
    shiftFactor?: number | null;
  },
): BackdropDiag {
  const m = mb.verdict.metrics;
  return {
    backdropMedian: m.referencePrice > 0 ? m.referencePrice : (m.median7 ?? null),
    backdropSamples7: m.samples7 ?? m.samples,
    backdropSamples30: extra?.samples30 ?? m.samples30 ?? null,
    backdropRatio: ratio,
    backdropRatioClamped: extra?.clamped ?? null,
    backdropTier: extra?.tier ?? null,
    backdropShiftFactor: extra?.shiftFactor ?? null,
    backdropAdjustment: adjustment,
    backdropAdjustmentApplied: applied,
  };
}

/**
 * Четыре среза по одному лоту (без отката getStatsSmart):
 * коллекция, модель и — если фон указан — коллекция+фон и модель+фон.
 * Для обычного фона model+backdrop только корректирует цену (см. applyOrdinaryBackdropAdjustment).
 * Black / Onyx Black по-прежнему решаются в pickPremiumBackdropVerdict.
 */
export function evaluateLotAllScopes(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
  activeListings?: ActiveListing[] | null,
): ScopedLotEvaluation[] {
  const modelTrimmed = model?.trim() ?? '';
  const backdropTrimmed = backdrop?.trim() ?? '';
  const slices: { model: string | null; backdrop: string | null }[] = [
    { model: null, backdrop: null },
  ];
  if (modelTrimmed) {
    slices.push({ model: modelTrimmed, backdrop: null });
  }
  if (backdropTrimmed) {
    slices.push({ model: null, backdrop: backdropTrimmed });
    if (modelTrimmed) {
      slices.push({ model: modelTrimmed, backdrop: backdropTrimmed });
    }
  }

  const scoped = slices.map((s) => {
    const verdict = decideFromSales(
      collection,
      s.model,
      s.backdrop,
      listingPrice,
      days,
      feeRate,
      activeListings,
    );
    return {
      scope: verdict.scope,
      model: s.model,
      backdrop: s.backdrop,
      verdict,
    };
  });
  return applyOrdinaryBackdropAdjustment(scoped, collection, days, feeRate);
}

/**
 * Точность среза. model и collection+backdrop — разные оси, не родитель/ребёнок:
 * пересечение (model+backdrop) важнее обеих, между осями выигрывает buy/watch.
 */
const SCOPE_SPECIFICITY: Record<StatsWithConfidence['scope'], number> = {
  collection: 0,
  model: 1,
  'collection+backdrop': 2,
  'model+backdrop': 3,
};

function mostSpecific(items: ScopedLotEvaluation[]): ScopedLotEvaluation {
  return items.reduce((best, cur) =>
    SCOPE_SPECIFICITY[cur.scope] > SCOPE_SPECIFICITY[best.scope] ? cur : best,
  );
}

/** Extended может быть итогом, только если 30д стабильны относительно 7д. */
function extendedEligible(s: ScopedLotEvaluation): boolean {
  if (s.verdict.evidence !== 'extended') return false;
  if (s.verdict.action === 'insufficient') return false;
  const n30 = s.verdict.metrics.samples30 ?? s.verdict.metrics.samples;
  if (n30 < MIN_SAMPLES_TO_EVALUATE) return false;
  const stab = s.verdict.metrics.priceStability;
  if (stab != null && stab > PRICE_STABILITY_OK) return false;
  return true;
}

function usableForPrimary(s: ScopedLotEvaluation): boolean {
  if (s.verdict.action === 'insufficient') return false;
  if (s.verdict.evidence === 'weak' || s.verdict.evidence === 'insufficient') {
    return false;
  }
  if (s.verdict.evidence === 'reliable') return true;
  return extendedEligible(s);
}

/**
 * Сильный минус по более узкому надёжному срезу.
 * Обычная модель не отменяет срез с фоном: для Black / Onyx Black
 * цена задаётся фоном, флор модели её не блокирует.
 */
function strongNegative(
  s: ScopedLotEvaluation,
  chosen: ScopedLotEvaluation,
): 'hard' | 'soft' | null {
  if (s.verdict.evidence !== 'reliable' || s.verdict.action !== 'skip') {
    return null;
  }
  if (s.scope === 'collection+backdrop' && !isBackdropEnabledForAnalysis(s.backdrop)) {
    return null;
  }
  const chosenBackdrop =
    chosen.scope === 'collection+backdrop' || chosen.scope === 'model+backdrop';
  if (chosenBackdrop && (s.scope === 'model' || s.scope === 'collection')) {
    return null;
  }
  const narrower = SCOPE_SPECIFICITY[s.scope] > SCOPE_SPECIFICITY[chosen.scope];
  if (!narrower) return null;
  const { netMargin, discountVsMedian } = s.verdict.metrics;
  if (netMargin <= -0.2 || discountVsMedian <= -0.2) return 'hard';
  if (netMargin <= -0.1 || discountVsMedian <= -0.1) return 'soft';
  return null;
}

function withAction(
  s: ScopedLotEvaluation,
  action: 'buy' | 'watch' | 'skip',
  reason: string,
): ScopedLotEvaluation {
  return {
    ...s,
    verdict: { ...s.verdict, action, reason },
  };
}

export interface PrimaryLotPick {
  evaluation: ScopedLotEvaluation;
  confidence: StatsWithConfidence['confidence'];
  notes: string[];
}

function samples7of(s: ScopedLotEvaluation): number {
  return s.verdict.metrics.samples7 ?? s.verdict.metrics.samples;
}

/** 7д ≥ 10, либо extended: за 30д уже ≥ 10 и срез сам стал ориентиром. */
function premiumMarketSamples(s: ScopedLotEvaluation): number {
  const n7 = samples7of(s);
  if (n7 >= MIN_SAMPLES_TO_EVALUATE) return n7;
  const n30 = s.verdict.metrics.samples30 ?? 0;
  if (s.verdict.evidence === 'extended' && n30 >= MIN_SAMPLES_TO_EVALUATE) {
    return n30;
  }
  return n7;
}

function priceActionFromMetrics(
  s: ScopedLotEvaluation,
): 'buy' | 'watch' | 'skip' | null {
  const m = s.verdict.metrics;
  const n = m.samples7 ?? m.samples;
  if (!(m.referencePrice > 0) || n < 1) return null;
  if (s.verdict.reason.includes('медиана ненадёжна')) return null;
  const { buyMinDiscount, buyMinMargin, watchMinDiscount } =
    getSalesVerdictThresholds();
  const discount = m.discountVsMedian;
  const margin = m.netMargin;
  const bullish = m.trendStatus === 'bullish' || m.bullishDiscountApplied === true;
  const marginNeed = buyMinMargin + (bullish ? getBullishMarginPremium() : 0);
  const extendedPrice =
    s.verdict.evidence === 'extended' && !m.trendAdjusted && !bullish;
  const regularBuy = discount >= buyMinDiscount && margin >= marginNeed;
  const extendedBuy =
    discount >= buyMinDiscount + EXTENDED_BUY_EXTRA &&
    margin >= marginNeed + EXTENDED_BUY_EXTRA;
  if (extendedPrice ? extendedBuy : regularBuy) return 'buy';
  if (discount >= watchMinDiscount && margin > 0) return 'watch';
  return 'skip';
}

/**
 * Тонкий фоновый срез (меньше 10 продаж) всё равно задаёт цену.
 * Пороги buy/watch те же, confidence принудительно low.
 */
function promoteThinBackdropSlice(s: ScopedLotEvaluation): ScopedLotEvaluation {
  let next = s;
  if (s.verdict.action === 'insufficient') {
    const action = priceActionFromMetrics(s);
    if (action) {
      next = withAction(
        s,
        action,
        `${s.verdict.reason}; для премиального фона срез всё равно задаёт цену`,
      );
    }
  }
  if (next.verdict.metrics.confidence === 'low') return next;
  return {
    ...next,
    verdict: {
      ...next.verdict,
      metrics: { ...next.verdict.metrics, confidence: 'low' },
    },
  };
}

/**
 * Black / Onyx Black: носитель цены — фон, не флор модели.
 * ≥10 продаж коллекция+фон → этот срез и есть вердикт.
 * иначе ≥3 продаж модель+фон → он.
 * иначе оба < 3 → коллекция+фон с confidence low.
 */
function pickPremiumBackdropVerdict(
  scoped: ScopedLotEvaluation[],
): PrimaryLotPick | null {
  const collBd = scoped.find((s) => s.scope === 'collection+backdrop');
  if (!collBd || !isBackdropEnabledForAnalysis(collBd.backdrop)) return null;

  const modelBd = scoped.find((s) => s.scope === 'model+backdrop');
  const nColl = premiumMarketSamples(collBd);
  const nModel = modelBd ? samples7of(modelBd) : 0;
  const notes: string[] = [];

  let evaluation: ScopedLotEvaluation;
  if (nColl >= MIN_SAMPLES_TO_EVALUATE) {
    evaluation = collBd;
    notes.push(
      `для этого фона рынок — коллекция+фон (${nColl} продаж), модель вердикт не задаёт и не отменяет`,
    );
  } else if (modelBd && nModel >= PREMIUM_MODEL_BACKDROP_MIN) {
    evaluation =
      nModel >= MIN_SAMPLES_TO_EVALUATE ? modelBd : promoteThinBackdropSlice(modelBd);
    notes.push(
      `коллекция+фон: ${nColl} продаж (< ${MIN_SAMPLES_TO_EVALUATE}), итог по модели+фон (${nModel})`,
    );
  } else {
    evaluation = promoteThinBackdropSlice(collBd);
    notes.push(
      `мало продаж фона (коллекция+фон ${samples7of(collBd)}, модель+фон ${nModel}), confidence понижен`,
    );
  }

  const modelSlice = scoped.find((s) => s.scope === 'model');
  if (
    modelSlice &&
    evaluation.scope === 'collection+backdrop' &&
    nColl >= MIN_SAMPLES_TO_EVALUATE
  ) {
    const med = modelSlice.verdict.metrics.referencePrice;
    const n = samples7of(modelSlice);
    if (med > 0) {
      notes.push(
        `модель справочно: медиана ${med.toFixed(2)} TON (${n} за 7д), buy не блокирует`,
      );
    }
  }

  const med = evaluation.verdict.metrics.referencePrice;
  if (med > 0 && (evaluation.verdict.action === 'buy' || evaluation.verdict.action === 'watch')) {
    notes.unshift(
      `основной сигнал — фон: медиана ${scopeLabel(evaluation.scope)} ${med.toFixed(2)} TON`,
    );
  }

  return {
    evaluation,
    confidence: evaluation.verdict.metrics.confidence,
    notes,
  };
}

/** Обычный model+backdrop с ≥10 продажами за 7д — основной ориентир, не автоматический buy. */
function modelBackdropCanLead(s: ScopedLotEvaluation): boolean {
  if (s.scope !== 'model+backdrop') return false;
  if (isBackdropEnabledForAnalysis(s.backdrop)) return false;
  if (samples7of(s) < MIN_SAMPLES_TO_EVALUATE) return false;
  const shift = s.verdict.metrics.backdropShiftFactor;
  if (shift != null && shift < 1) return false;
  return usableForPrimary(s);
}

/**
 * Надёжный более узкий skip со свежим рынком (3д) отменяет широкий buy.
 * weak/insufficient и skip без trendAdjusted сюда не входят.
 */
function freshMarketSkip(
  s: ScopedLotEvaluation,
  chosen: ScopedLotEvaluation,
): boolean {
  if (s.verdict.evidence !== 'reliable' || s.verdict.action !== 'skip') return false;
  const status = s.verdict.metrics.trendStatus;
  const bearish =
    status != null
      ? status === 'bearish'
      : s.verdict.metrics.trendAdjusted === true;
  if (!bearish) return false;
  if (SCOPE_SPECIFICITY[s.scope] <= SCOPE_SPECIFICITY[chosen.scope]) return false;
  if (s.scope === 'collection+backdrop') return false;
  if (
    s.verdict.reason.includes('неликвид') ||
    s.verdict.reason.includes('мало продаж')
  ) {
    return false;
  }
  return true;
}

/** Коллекция+фон и тонкий model+backdrop в обычный primary не идут: фон либо лидер, либо поправка к модели. */
function usableOrdinaryScope(s: ScopedLotEvaluation): boolean {
  if (s.scope === 'model+backdrop' || s.scope === 'collection+backdrop') return false;
  return usableForPrimary(s);
}

function mergeBackdropDiag(
  evaluation: ScopedLotEvaluation,
  scoped: ScopedLotEvaluation[],
): ScopedLotEvaluation {
  if (evaluation.verdict.metrics.backdropSamples7 != null) return evaluation;
  const src =
    scoped.find((s) => s.scope === 'model') ??
    scoped.find((s) => s.scope === 'model+backdrop');
  const m = src?.verdict.metrics;
  if (m?.backdropSamples7 == null) return evaluation;
  return {
    ...evaluation,
    verdict: {
      ...evaluation.verdict,
      metrics: {
        ...evaluation.verdict.metrics,
        backdropMedian: m.backdropMedian,
        backdropSamples7: m.backdropSamples7,
        backdropSamples30: m.backdropSamples30,
        backdropRatio: m.backdropRatio,
        backdropRatioClamped: m.backdropRatioClamped,
        backdropTier: m.backdropTier,
        backdropShiftFactor: m.backdropShiftFactor,
        backdropAdjustment: m.backdropAdjustment,
        backdropAdjustmentApplied: m.backdropAdjustmentApplied,
      },
    },
  };
}

/**
 * Итог по лоту.
 * Black / Onyx Black — pickPremiumBackdropVerdict.
 * Иначе при ≥10 продажах model+backdrop этот срез и есть ориентир.
 * Дальше usable = reliable или стабильный extended, без срезов фона:
 * сначала buy, потом watch, потом skip, внутри — самый узкий.
 * Надёжный skip модели со свежим рынком (trendAdjusted) отменяет buy коллекции.
 * Сильный минус более узкого среза по-прежнему снижает buy.
 */
export function pickPrimaryLotVerdict(
  scoped: ScopedLotEvaluation[],
): PrimaryLotPick | null {
  const premium = pickPremiumBackdropVerdict(scoped);
  if (premium) return premium;

  const notes: string[] = [];
  const mb = scoped.find((s) => s.scope === 'model+backdrop');
  let picked: ScopedLotEvaluation | null = null;

  if (mb && modelBackdropCanLead(mb)) {
    picked = mb;
    notes.push(
      `основной сигнал — модель+фон (${samples7of(mb)} за 7д, медиана ${mb.verdict.metrics.referencePrice.toFixed(2)} TON)`,
    );
  } else {
    if (mb && !isBackdropEnabledForAnalysis(mb.backdrop)) {
      const n = samples7of(mb);
      const tier = mb.verdict.metrics.backdropTier;
      const shift = mb.verdict.metrics.backdropShiftFactor;
      if (tier && shift != null && shift < 1) {
        notes.push(
          `модель+фон ${tier}: сдвиг ${Math.round(shift * 100)}% отклонения (${n} за 7д), не полная замена модели`,
        );
      }
    }
    const usable = scoped.filter(usableOrdinaryScope);
    if (usable.length === 0) return null;
    const buys = usable.filter((s) => s.verdict.action === 'buy');
    const watches = usable.filter((s) => s.verdict.action === 'watch');
    const skips = usable.filter((s) => s.verdict.action === 'skip');
    picked = buys.length
      ? mostSpecific(buys)
      : watches.length
        ? mostSpecific(watches)
        : mostSpecific(skips);
  }

  let evaluation = picked;
  let veto: 'hard' | 'soft' | null = null;

  if (picked.verdict.action === 'buy' && picked.scope !== 'model+backdrop') {
    const freshSkips = scoped.filter((s) => freshMarketSkip(s, picked));
    if (freshSkips.length > 0) {
      const fresh = mostSpecific(freshSkips);
      const med = fresh.verdict.metrics.referencePrice;
      notes.push(
        `${scopeLabel(fresh.scope)} отменяет широкий buy: надёжная выборка и свежий рынок 3д` +
          (med > 0 ? ` (медиана ${med.toFixed(2)} TON)` : ''),
      );
      evaluation = fresh;
    } else {
      for (const s of scoped) {
        if (s.scope === picked.scope) continue;
        const level = strongNegative(s, picked);
        if (level === 'hard') veto = 'hard';
        else if (level === 'soft' && veto !== 'hard') veto = 'soft';
        if (!level) continue;
        const m = s.verdict.metrics;
        notes.push(
          `${scopeLabel(s.scope)} сильно ниже рынка лота: медиана ${m.referencePrice.toFixed(2)} TON, маржа ${Math.round(m.netMargin * 100)}%`,
        );
      }
      if (veto === 'hard') {
        evaluation = withAction(
          picked,
          'skip',
          `${picked.verdict.reason}; снижено до мимо: узкий срез с достаточной выборкой показывает сильный минус`,
        );
      } else if (veto === 'soft') {
        evaluation = withAction(
          picked,
          'watch',
          `${picked.verdict.reason}; снижено до смотреть: модель заметно дороже своего рынка`,
        );
      }
    }
  }

  for (const s of scoped) {
    if (s.scope === evaluation.scope) continue;
    if (
      s.scope === 'model+backdrop' &&
      !isBackdropEnabledForAnalysis(s.backdrop) &&
      samples7of(s) < MIN_SAMPLES_TO_EVALUATE
    ) {
      continue;
    }
    const ev = s.verdict.evidence;
    const n7 = s.verdict.metrics.samples7 ?? s.verdict.metrics.samples;
    if (ev === 'insufficient' || ev === 'weak') {
      const kind =
        n7 >= MIN_SAMPLES_TO_EVALUATE
          ? 'медиана ненадёжна'
          : n7 >= WEAK_SAMPLES
            ? 'слабая выборка'
            : 'мало данных';
      notes.push(`${scopeLabel(s.scope)} — ${kind} (${n7} за 7д)`);
      continue;
    }
    if (ev === 'extended' && !extendedEligible(s)) {
      const stab = s.verdict.metrics.priceStability;
      const pct = stab != null ? Math.round(stab * 100) : null;
      notes.push(
        `${scopeLabel(s.scope)} за 30д не итог${pct != null ? ` (расхождение ${pct}%)` : ''}`,
      );
    }
  }

  evaluation = mergeBackdropDiag(evaluation, scoped);
  return {
    evaluation,
    confidence: evaluation.verdict.metrics.confidence,
    notes,
  };
}

/** После оценки только по продажам: есть смысл тянуть стакан saling. */
export function isPotentiallyProfitableScoped(
  scoped: ScopedLotEvaluation[],
): boolean {
  return scoped.some(
    (s) => s.verdict.action === 'buy' || s.verdict.action === 'watch',
  );
}

export function analyzeLot(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
  activeListings?: ActiveListing[] | null,
) {
  const scopes = evaluateLotAllScopes(
    collection,
    model,
    backdrop,
    listingPrice,
    days,
    feeRate,
    activeListings,
  );
  const picked = pickPrimaryLotVerdict(scopes);
  return {
    scopes,
    primary: picked
      ? {
          scope: picked.evaluation.scope,
          action: picked.evaluation.verdict.action,
          evidence: picked.evaluation.verdict.evidence,
          confidence: picked.confidence,
          reason: picked.evaluation.verdict.reason,
          notes: picked.notes,
          metrics: {
            ...picked.evaluation.verdict.metrics,
            confidence: picked.confidence,
          },
        }
      : null,
  };
}

export function getPriceHistory(
  collection: string,
  model: string,
  days = 30,
): { ts: number; floor_nano: number | null }[] {
  const since = cutoffTs(days);
  return priceHistoryStmt.all(collection, model, since) as {
    ts: number;
    floor_nano: number | null;
  }[];
}

export function getCollectionPriceHistory(
  collection: string,
  days = 30,
): { ts: number; floor_nano: number | null }[] {
  const since = cutoffTs(days);
  return collectionPriceHistoryStmt.all(collection, since) as {
    ts: number;
    floor_nano: number | null;
  }[];
}

export interface SaleRow {
  id: string;
  collection_name: string;
  model_name: string;
  backdrop_name: string;
  amount_nano: number;
  ts: number;
}

export function getSaleById(id: string): SaleRow | undefined {
  return saleByIdStmt.get(id) as SaleRow | undefined;
}
