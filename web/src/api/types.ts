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
  action: 'buy' | 'watch' | 'skip' | 'insufficient';
  evidence?: 'insufficient' | 'weak' | 'extended' | 'reliable';
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
    windowDays?: number;
    samples7?: number;
    samples30?: number | null;
    priceStability?: number | null;
    median7?: number;
    median3?: number | null;
    samples3?: number | null;
    trend?: number | null;
    trendDirection?: 'down' | 'up' | 'flat' | 'unknown';
    trendAdjusted?: boolean;
    recentBelowBaseRatio?: number | null;
    baseReferencePrice?: number;
  };
}

export interface LotAnalysisScope {
  scope: 'model+backdrop' | 'model' | 'collection' | 'collection+backdrop';
  model: string | null;
  backdrop: string | null;
  verdict: DealVerdict & {
    scope: 'model+backdrop' | 'model' | 'collection' | 'collection+backdrop';
  };
}

export interface LotAnalysis {
  scopes: LotAnalysisScope[];
  primary: {
    scope: LotAnalysisScope['scope'];
    action: 'buy' | 'watch' | 'skip' | 'insufficient';
    evidence?: DealVerdict['evidence'];
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    notes: string[];
    metrics: DealVerdict['metrics'];
  } | null;
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

// ============================================================
// Saling scanner (profit / radar)
// ============================================================

export interface SalingDealMetricsFull {
  listingPrice: number;
  referencePrice: number;
  floorPrice: number;
  discountVsMedian: number;
  discountVsFloor: number;
  netMargin: number;
  confidence: string;
  samples: number;
  salesPerDay: number;
  windowDays?: number;
  samples7?: number;
  samples30?: number | null;
  priceStability?: number | null;
  median7?: number;
  median3?: number | null;
  samples3?: number | null;
  trend?: number | null;
  trendDirection?: 'down' | 'up' | 'flat' | 'unknown';
  trendAdjusted?: boolean;
  recentBelowBaseRatio?: number | null;
  baseReferencePrice?: number;
}

export interface SalingScopeVerdict {
  scope: string;
  model: string | null;
  backdrop: string | null;
  action: string;
  evidence?: string;
  reason: string;
  metrics: SalingDealMetricsFull;
}

export interface SalingAnalysisThresholds {
  buyMinDiscount: number;
  buyMinMargin: number;
  watchMinDiscount: number;
  extendedBuyExtra: number;
  minSamplesReliable: number;
  weakSamples: number;
  extendedWindowDays: number;
  priceStabilityOk: number;
}

export interface SalingPrimaryVerdict {
  scope: string;
  action: 'buy' | 'watch';
  evidence?: string;
  reason: string;
  confidence: string;
  metrics: SalingDealMetricsFull;
}

export interface SalingAnalysisRecord {
  detectedAt: string;
  listingId: string;
  giftId: string;
  giftNumber: number | null;
  collection: string;
  model: string;
  backdrop: string;
  priceTon: number;
  analysisDays: number;
  feeRate: number;
  backdropSlicesEnabled: boolean;
  buyScopeCount: number;
  thresholds: SalingAnalysisThresholds;
  primary: SalingPrimaryVerdict;
  scopes: SalingScopeVerdict[];
  signals: string[];
}

export type SalingDealRecord = SalingAnalysisRecord;
export type RadarDealRecord = SalingAnalysisRecord;

export interface SalingDealsResponse {
  file: string;
  version?: number;
  updatedAt: string;
  total: number;
  deals: SalingAnalysisRecord[];
}

export interface RadarDealsResponse {
  file: string;
  version?: number;
  updatedAt: string;
  total: number;
  deals: SalingAnalysisRecord[];
}