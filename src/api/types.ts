// ============================================================
// Stats
// ============================================================

export interface PriceStats {
  collection: string;
  model: string;
  backdrop?: string | null;
  days: number;
  samples: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  last: number | null;
  lastTs: number | null;
}

export interface StatsWithConfidence extends PriceStats {
  scope: 'model+backdrop' | 'model' | 'collection';
  confidence: 'high' | 'medium' | 'low';
}

// ============================================================
// History
// ============================================================

export interface PricePoint {
  ts: number;
  floor_nano: number | null;
}

export interface HistoryResponse {
  collection: string;
  model: string | null;
  days: number;
  points: PricePoint[];
}

// ============================================================
// Evaluate / Decide
// ============================================================

export interface DealEvaluation {
  listingPrice: number;
  referencePrice: number;
  discount: number;
  verdict: 'buy' | 'fair' | 'expensive';
  confidence: 'high' | 'medium' | 'low';
  samples: number;
  salesPerDay: number;
  netMargin: number;
}

export interface DealVerdict {
  action: 'buy' | 'watch' | 'skip';
  reason: string;
  scope?: 'model+backdrop' | 'model' | 'collection' | 'collection+backdrop';
  metrics: {
    listingPrice: number;
    referencePrice: number;
    floorPrice: number;
    discountVsMedian: number;
    discountVsFloor: number;
    salesPerDay: number;
    netMargin: number;
    confidence: 'high' | 'medium' | 'low';
    samples: number;
  };
}

// ============================================================
// Liquidity
// ============================================================

export type LiquidityConfidence = 'high' | 'medium' | 'low';
export type LiquidityFreshness = 'hot' | 'warm' | 'cooling';

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

export interface LiquidityResponse {
  criteria: LiquidityCriteriaInfo;
  days: number;
  count: number;
  items: LiquidItemRow[];
}

// ============================================================
// Health
// ============================================================

export interface HealthResponse {
  ok: boolean;
}