import { getSalesVerdictThresholds } from '../parse-config.js';
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

export interface DealVerdict {
  action: 'buy' | 'watch' | 'skip';
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

/** Ниже этого срез не оцениваем (вердикт skip, не buy/watch). */
export const MIN_SAMPLES_TO_EVALUATE = 10;

/**
 * Уверенность только от размера выборки, не от типа среза.
 * < 10 — данных нет, вызывающий код должен ставить skip.
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

/** Мин. продаж/день от медианы среза (как на странице ликвидности). */
function minSalesPerDayForSlice(medianTon: number): number {
  if (medianTon <= 0) return 0.2;
  if (medianTon < 10) return 0.5;
  if (medianTon <= 100) return 0.2;
  return 0.05;
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

/** Вердикт по продажам из истории (медиана + комиссия при перепродаже). */
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
  const stats = getStatsExact(collection, modelTrimmed, backdropTrimmed, days);
  const referencePrice = stats.median;
  const discount = discountVsMedian(listingPrice, referencePrice);
  const margin = netMargin(listingPrice, referencePrice, feeRate);
  const since = cutoffTs(days);
  const salesPerDay =
    salesCountExact(collection, modelTrimmed, backdropTrimmed, since) / days;
  const slice = scopeLabel(stats.scope);
  const feePct = Math.round(feeRate * 1000) / 10;

  const metrics: DealVerdict['metrics'] = {
    listingPrice,
    referencePrice,
    floorPrice: 0,
    discountVsMedian: discount,
    discountVsFloor: 0,
    netMargin: margin,
    confidence: stats.confidence,
    samples: stats.samples,
    salesPerDay,
  };

  if (stats.samples < MIN_SAMPLES_TO_EVALUATE) {
    return {
      action: 'skip',
      scope: stats.scope,
      reason: `мало данных по срезу «${slice}» (${stats.samples} продаж, нужно ≥ ${MIN_SAMPLES_TO_EVALUATE})`,
      metrics,
    };
  }

  const pct = Math.round(Math.abs(discount) * 100);
  const marginPct = Math.round(margin * 100);
  const { buyMinDiscount, buyMinMargin, watchMinDiscount } =
    getSalesVerdictThresholds();
  const iqr = iqrRatioOf(stats);
  const priceOk = discount >= buyMinDiscount && margin >= buyMinMargin;
  if (priceOk && iqr !== null && iqr > 0.5) {
    return {
      action: 'skip',
      scope: stats.scope,
      reason: `разброс цен по срезу «${slice}» слишком большой (IQR/median ${iqr.toFixed(2)})`,
      metrics,
    };
  }
  const minPerDay = minSalesPerDayForSlice(referencePrice);
  if (priceOk && salesPerDay < minPerDay) {
    return {
      action: 'skip',
      scope: stats.scope,
      reason: `неликвидный срез «${slice}»: ${salesPerDay.toFixed(2)} продаж/день, нужно ≥ ${minPerDay}`,
      metrics,
    };
  }
  if (priceOk) {
    return {
      action: 'buy',
      scope: stats.scope,
      reason: `дешевле медианы (${slice}) на ${pct}%, после комиссии ${feePct}% маржа ~${marginPct}%`,
      metrics,
    };
  }
  if (discount >= watchMinDiscount && margin > 0) {
    return {
      action: 'watch',
      scope: stats.scope,
      reason: `дисконт к медиане (${slice}) ${pct}%, маржа после ${feePct}% — ${marginPct}%`,
      metrics,
    };
  }
  if (discount < -0.05) {
    return {
      action: 'skip',
      scope: stats.scope,
      reason: `дороже медианы продаж (${slice}) на ${pct}%`,
      metrics,
    };
  }
  if (margin < 0) {
    return {
      action: 'skip',
      scope: stats.scope,
      reason: `после комиссии ${feePct}% перепродажа в минус (маржа ${marginPct}%)`,
      metrics,
    };
  }
  return {
    action: 'skip',
    scope: stats.scope,
    reason: `цена около медианы продаж (${slice})`,
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
 * коллекция; кол+модель; кол+фон (если есть фон); кол+модель+фон.
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
  if (backdropTrimmed) {
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
