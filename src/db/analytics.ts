import {
  getSalesVerdictThresholds,
  isBackdropEnabledForAnalysis,
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
  };
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

/**
 * Вердикт одного среза.
 * Мало продаж — insufficient/weak, не skip: срез ничего не доказал.
 * Skip только когда выборка достаточна и по ней лот покупать не стоит.
 * Если за `days` (обычно 7) меньше 10 продаж, медиана 30д может стать ориентиром
 * (evidence=extended, confidence=low), пока медианы не разъехались больше чем на 30%.
 */
export function decideFromSales(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
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

  const referencePrice = priced.median;
  const discount = discountVsMedian(listingPrice, referencePrice);
  const margin = netMargin(listingPrice, referencePrice, feeRate);
  const salesPerDay = windowDays > 0 ? priced.samples / windowDays : 0;
  const confidence: Confidence =
    evidence === 'extended' ? 'low' : confidenceFromSamples(priced.samples);

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
    windowDays,
    samples7: stats7.samples,
    samples30,
    priceStability: stability,
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
  const windowLabel =
    evidence === 'extended' ? `${slice}, ${windowDays}д` : slice;
  const { buyMinDiscount, buyMinMargin, watchMinDiscount } =
    getSalesVerdictThresholds();
  const iqr = iqrRatioOf(priced);
  const regularBuy =
    discount >= buyMinDiscount && margin >= buyMinMargin;
  const extendedBuy =
    discount >= buyMinDiscount + EXTENDED_BUY_EXTRA &&
    margin >= buyMinMargin + EXTENDED_BUY_EXTRA;
  const priceOk = evidence === 'extended' ? extendedBuy : regularBuy;
  const extendedShort =
    evidence === 'extended' && regularBuy && !extendedBuy;

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
    return {
      action: 'buy',
      evidence,
      scope: stats7.scope,
      reason: `дешевле медианы (${windowLabel}) на ${pct}%, после комиссии ${feePct}% маржа ~${marginPct}%${stabilityNote}`,
      metrics,
    };
  }
  if (discount >= watchMinDiscount && margin > 0) {
    const short =
      extendedShort
        ? `; для buy по 30д нужен запас +${Math.round(EXTENDED_BUY_EXTRA * 100)} п.п. к порогам`
        : '';
    return {
      action: 'watch',
      evidence,
      scope: stats7.scope,
      reason: `дисконт к медиане (${windowLabel}) ${pct}%, маржа после ${feePct}% — ${marginPct}%${stabilityNote}${short}`,
      metrics,
    };
  }
  if (discount < -0.05) {
    return {
      action: 'skip',
      evidence,
      scope: stats7.scope,
      reason: `дороже медианы продаж (${windowLabel}) на ${pct}%${stabilityNote}`,
      metrics,
    };
  }
  if (margin < 0) {
    return {
      action: 'skip',
      evidence,
      scope: stats7.scope,
      reason: `после комиссии ${feePct}% перепродажа в минус (маржа ${marginPct}%)${stabilityNote}`,
      metrics,
    };
  }
  return {
    action: 'skip',
    evidence,
    scope: stats7.scope,
    reason: `цена около медианы продаж (${windowLabel})${stabilityNote}`,
    metrics,
  };
}

export interface ScopedLotEvaluation {
  scope: StatsWithConfidence['scope'];
  model: string | null;
  backdrop: string | null;
  verdict: DealVerdict & { scope: StatsWithConfidence['scope'] };
}

/**
 * Четыре явных среза по одному лоту (без отката getStatsSmart):
 * коллекция; кол+модель; кол+фон и кол+модель+фон — только для Black / Onyx Black.
 */
export function evaluateLotAllScopes(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
): ScopedLotEvaluation[] {
  const modelTrimmed = model?.trim() ?? '';
  const backdropTrimmed = backdrop?.trim() ?? '';
  const slices: { model: string | null; backdrop: string | null }[] = [
    { model: null, backdrop: null },
  ];
  if (modelTrimmed) {
    slices.push({ model: modelTrimmed, backdrop: null });
  }
  if (backdropTrimmed && isBackdropEnabledForAnalysis(backdropTrimmed)) {
    slices.push({ model: null, backdrop: backdropTrimmed });
    if (modelTrimmed) {
      slices.push({ model: modelTrimmed, backdrop: backdropTrimmed });
    }
  }

  return slices.map((s) => {
    const verdict = decideFromSales(
      collection,
      s.model,
      s.backdrop,
      listingPrice,
      days,
      feeRate,
    );
    return {
      scope: verdict.scope,
      model: s.model,
      backdrop: s.backdrop,
      verdict,
    };
  });
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
 * Сильный минус по модели (или более узкому надёжному срезу).
 * «Около медианы» сюда не входит — фон может быть дороже модели.
 */
function strongNegative(
  s: ScopedLotEvaluation,
  chosen: ScopedLotEvaluation,
): 'hard' | 'soft' | null {
  if (s.verdict.evidence !== 'reliable' || s.verdict.action !== 'skip') {
    return null;
  }
  const narrower = SCOPE_SPECIFICITY[s.scope] > SCOPE_SPECIFICITY[chosen.scope];
  const modelAxis = s.scope === 'model' || s.scope === 'model+backdrop';
  if (!narrower && !modelAxis) return null;
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

/**
 * Итог по лоту.
 * usable = reliable (7д ≥ 10) или extended (30д ≥ 10 и расхождение медиан ≤ 15%).
 * Сначала buy, потом watch, потом skip. Внутри — самый узкий срез.
 * insufficient / weak итог не выбирают.
 * Надёжный сильный минус по модели снижает buy (до watch или skip).
 */
export function pickPrimaryLotVerdict(
  scoped: ScopedLotEvaluation[],
): PrimaryLotPick | null {
  const usable = scoped.filter(usableForPrimary);
  if (usable.length === 0) return null;

  const buys = usable.filter((s) => s.verdict.action === 'buy');
  const watches = usable.filter((s) => s.verdict.action === 'watch');
  const skips = usable.filter((s) => s.verdict.action === 'skip');
  const picked = buys.length
    ? mostSpecific(buys)
    : watches.length
      ? mostSpecific(watches)
      : mostSpecific(skips);

  const notes: string[] = [];
  let evaluation = picked;
  let veto: 'hard' | 'soft' | null = null;

  if (picked.verdict.action === 'buy') {
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

  const action = evaluation.verdict.action;
  const backdropPremium =
    picked.scope === 'collection+backdrop' || picked.scope === 'model+backdrop';
  if (backdropPremium && (action === 'buy' || action === 'watch') && !veto) {
    const med = picked.verdict.metrics.referencePrice;
    if (med > 0) {
      notes.push(
        `основной сигнал — фон: медиана ${scopeLabel(picked.scope)} ${med.toFixed(2)} TON`,
      );
    }
  }

  const modelSlice = scoped.find((s) => s.scope === 'model');
  if (
    modelSlice &&
    modelSlice.scope !== picked.scope &&
    modelSlice.verdict.evidence === 'reliable' &&
    modelSlice.verdict.action === 'skip' &&
    !veto &&
    backdropPremium &&
    (action === 'buy' || action === 'watch')
  ) {
    const med = modelSlice.verdict.metrics.referencePrice;
    if (med > 0) {
      notes.push(
        `модель не подтверждает премию: медиана модели ${med.toFixed(2)} TON`,
      );
    }
  }

  for (const s of scoped) {
    if (s.scope === picked.scope) continue;
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

  return {
    evaluation,
    confidence: evaluation.verdict.metrics.confidence,
    notes,
  };
}

export function analyzeLot(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
  listingPrice: number,
  days = 7,
  feeRate = 0.05,
) {
  const scopes = evaluateLotAllScopes(
    collection,
    model,
    backdrop,
    listingPrice,
    days,
    feeRate,
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
