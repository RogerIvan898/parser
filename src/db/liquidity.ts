import { NANO } from '../types.js';
import { db } from './index.js';
import { getModelPriceStats } from './analytics.js';
import { nowTs } from './storage.js';

export type LiquidityConfidence = 'high' | 'medium' | 'low';
export type LiquidityFreshness = 'hot' | 'warm' | 'cooling';

/** Пороги по умолчанию (позже — настройки). */
export const LIQUIDITY_DEFAULTS = {
  minSamples: 3,
  maxLastSaleAgeDays: 5,
  maxIqrRatio: 0.5,
};

export interface LiquidityCriteriaInfo {
  summary: string;
  dataSource: string;
  scope: string;
  windowDays: number;
  minSamples: number;
  maxLastSaleAgeDays: number;
  maxIqrRatio: number;
  salesPerDayByPrice: string;
  confidenceRules: string;
  ranking: string;
  freshnessLabels: string;
  configurableLater: string[];
}

export interface LiquidItemRow {
  collection: string;
  model: string;
  samples: number;
  salesPerDay: number;
  lastSaleAgeDays: number;
  lastSaleTon: number;
  medianTon: number;
  iqrRatio: number | null;
  trend: number | null;
  confidence: LiquidityConfidence;
  freshness: LiquidityFreshness;
}

const pairAggStmt = db.prepare(`
  SELECT
    collection_name,
    model_name,
    COUNT(*) AS samples,
    MAX(ts) AS last_ts
  FROM sales
  WHERE ts >= ?
  GROUP BY collection_name, model_name
  HAVING COUNT(*) >= ?
`);

const salesInWindowStmt = db.prepare(`
  SELECT amount_nano, ts FROM sales
  WHERE collection_name = ? AND model_name = ? AND ts >= ?
  ORDER BY ts ASC
`);

function nanoToTon(nano: number): number {
  return nano / NANO;
}

function medianSorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Мин. продаж/день от медианной цены (TON). */
export function minSalesPerDayForMedian(medianTon: number): number {
  if (medianTon <= 0) return 0.2;
  if (medianTon < 10) return 0.5;
  if (medianTon <= 100) return 0.2;
  return 0.05;
}

export function freshnessFromAge(ageDays: number): LiquidityFreshness {
  if (ageDays <= 2) return 'hot';
  if (ageDays <= 5) return 'warm';
  return 'cooling';
}

export function liquidityConfidence(
  samples: number,
  lastSaleAgeDays: number,
  iqrRatio: number | null,
): LiquidityConfidence {
  const iqr = iqrRatio ?? 1;
  if (samples >= 10 && lastSaleAgeDays <= 2 && iqr <= 0.3) return 'high';
  if (samples >= 5 && lastSaleAgeDays <= 4 && iqr <= 0.5) return 'medium';
  return 'low';
}

const CONFIDENCE_RANK: Record<LiquidityConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function confidenceMeetsMinimum(
  level: LiquidityConfidence,
  min: LiquidityConfidence | null,
): boolean {
  if (!min) return true;
  return CONFIDENCE_RANK[level] >= CONFIDENCE_RANK[min];
}

function computeTrend(
  collection: string,
  model: string,
  since: number,
): number | null {
  const rows = salesInWindowStmt.all(collection, model, since) as {
    amount_nano: number;
    ts: number;
  }[];
  if (rows.length < 4) return null;

  const now = nowTs();
  const midpoint = since + (now - since) / 2;
  const first: number[] = [];
  const second: number[] = [];
  for (const r of rows) {
    const ton = nanoToTon(r.amount_nano);
    if (r.ts < midpoint) first.push(ton);
    else second.push(ton);
  }
  if (first.length === 0 || second.length === 0) return null;

  const m1 = medianSorted([...first].sort((a, b) => a - b));
  const m2 = medianSorted([...second].sort((a, b) => a - b));
  if (m1 <= 0) return null;
  return m2 / m1 - 1;
}

function buildCriteriaInfo(days: number): LiquidityCriteriaInfo {
  return {
    summary:
      'Ликвидная пара — частые недавние продажи, предсказуемая цена и достаточная выборка. ' +
      '«Засыпающие» (последняя продажа > 5 дн. назад) в список не попадают.',
    dataSource: 'таблица sales в mrkt.db (npm run parse -- --history)',
    scope: 'коллекция + модель (все фоны в одной выборке)',
    windowDays: days,
    minSamples: LIQUIDITY_DEFAULTS.minSamples,
    maxLastSaleAgeDays: LIQUIDITY_DEFAULTS.maxLastSaleAgeDays,
    maxIqrRatio: LIQUIDITY_DEFAULTS.maxIqrRatio,
    salesPerDayByPrice:
      '< 10 TON → ≥ 0.5/день; 10–100 TON → ≥ 0.2/день; > 100 TON → ≥ 0.05/день',
    confidenceRules:
      'high: ≥10 продаж, последняя ≤2 дн., IQR/median ≤0.3; ' +
      'medium: ≥5, ≤4 дн., IQR ≤0.5; low: ≥3 продаж (минимум)',
    ranking: 'сначала confidence (high → low), затем продажи в день',
    freshnessLabels: 'hot ≤2 дн., warm ≤5 дн., cooling >5 дн. (исключаются)',
    configurableLater: [
      'пороги свежести и IQR',
      'диапазоны цены для min продаж/день',
      'минимальный confidence в выдаче',
      'срез модель+фон при нехватке данных по модели',
      'ограничение числа строк (сейчас — все прошедшие фильтры)',
    ],
  };
}

export interface ListLiquidOptions {
  limit?: number | null;
  minConfidence?: LiquidityConfidence | null;
  collectionFilter?: string | null;
}

export function listLiquidItems(
  days: number,
  limit?: number | null,
  collectionFilter?: string | null,
  minConfidence?: LiquidityConfidence | null,
): {
  criteria: LiquidityCriteriaInfo;
  days: number;
  count: number;
  items: LiquidItemRow[];
} {
  return getLiquidPairs(days, {
    limit,
    collectionFilter,
    minConfidence,
  });
}

export function getLiquidPairs(
  days: number,
  opts: ListLiquidOptions = {},
): {
  criteria: LiquidityCriteriaInfo;
  days: number;
  count: number;
  items: LiquidItemRow[];
} {
  const since = nowTs() - days * 86400;
  const now = nowTs();

  const rows = pairAggStmt.all(since, LIQUIDITY_DEFAULTS.minSamples) as {
    collection_name: string;
    model_name: string;
    samples: number;
    last_ts: number;
  }[];

  const candidates: LiquidItemRow[] = [];

  for (const r of rows) {
    if (opts.collectionFilter?.trim()) {
      if (r.collection_name !== opts.collectionFilter.trim()) continue;
    }

    const lastSaleAgeDays = (now - r.last_ts) / 86400;
    if (lastSaleAgeDays > LIQUIDITY_DEFAULTS.maxLastSaleAgeDays) continue;

    const stats = getModelPriceStats(r.collection_name, r.model_name, days);
    const medianTon = stats.median;
    const salesPerDay = r.samples / days;
    const minPerDay = minSalesPerDayForMedian(medianTon);
    if (salesPerDay < minPerDay) continue;

    const iqrRatio =
      medianTon > 0 ? (stats.p75 - stats.p25) / medianTon : null;
    if (iqrRatio !== null && iqrRatio > LIQUIDITY_DEFAULTS.maxIqrRatio) {
      continue;
    }

    const confidence = liquidityConfidence(
      r.samples,
      lastSaleAgeDays,
      iqrRatio,
    );
    if (!confidenceMeetsMinimum(confidence, opts.minConfidence ?? null)) {
      continue;
    }

    const trend = computeTrend(r.collection_name, r.model_name, since);

    candidates.push({
      collection: r.collection_name,
      model: r.model_name,
      samples: r.samples,
      salesPerDay,
      lastSaleAgeDays,
      lastSaleTon: stats.last,
      medianTon,
      iqrRatio,
      trend,
      confidence,
      freshness: freshnessFromAge(lastSaleAgeDays),
    });
  }

  candidates.sort((a, b) => {
    const cr = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (cr !== 0) return cr;
    return b.salesPerDay - a.salesPerDay;
  });

  const limit = opts.limit;
  const items =
    limit != null && limit > 0
      ? candidates.slice(0, Math.floor(limit))
      : candidates;

  return {
    criteria: buildCriteriaInfo(days),
    days,
    count: items.length,
    items,
  };
}
