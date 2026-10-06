import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  fetchSalingWithRetry,
  makeSalingScannerFeedRequest,
} from './client.js';
import type { Gift } from './types.js';
import { nanoToTon } from './types.js';
import {
  evaluateLotAllScopes,
  pickPrimaryLotVerdict,
  EXTENDED_BUY_EXTRA,
  EXTENDED_WINDOW_DAYS,
  MIN_SAMPLES_TO_EVALUATE,
  PRICE_STABILITY_OK,
  WEAK_SAMPLES,
  type DealVerdict,
  type PrimaryLotPick,
  type ScopedLotEvaluation,
} from './db/analytics.js';
import {
  isSalingScannerEnabled,
  isCollectionEnabledForParse,
  isBackdropEnabledForAnalysis,
  SALING_SCANNER_INTERVAL_MS,
  SALING_SCANNER_JITTER_MS,
  getParseFeeRate,
  getSalesVerdictThresholds,
} from './parse-config.js';
import { DATA_DIR } from './store.js';

export const PROFIT_DEALS_FILE = resolve(DATA_DIR, 'profit-deals.json');
export const RADAR_DEALS_FILE = resolve(DATA_DIR, 'radar-deals.json');
/** CSV: цена, коллекция, модель, фон, listing id — каждый новый buy в profit-deals */
export const SALING_BUYS_CSV = resolve(DATA_DIR, 'saling-buys.csv');

const ANALYSIS_DAYS = 7;
const MAX_RECORDS = 400;
const DEALS_STORE_VERSION = 4;

/**
 * POST /api/v1/gifts/saling с пустыми фильтрами и ordering `None` —
 * в ответе порция **недавно выставленных** лотов (как лента в MRKT), не «топ дешёвых».
 * Тело совпадает с `makeSalingScannerFeedRequest()` в client.ts (count: 20).
 */

/** Полные метрики среза (как в decideFromSales / оценке в UI). */
export interface StoredDealMetrics {
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
}

export interface StoredScopeVerdict {
  scope: string;
  model: string | null;
  backdrop: string | null;
  action: string;
  evidence?: string;
  reason: string;
  metrics: StoredDealMetrics;
}

export interface StoredAnalysisThresholds {
  buyMinDiscount: number;
  buyMinMargin: number;
  watchMinDiscount: number;
  extendedBuyExtra: number;
  minSamplesReliable: number;
  weakSamples: number;
  extendedWindowDays: number;
  priceStabilityOk: number;
}

export interface StoredPrimaryVerdict {
  scope: string;
  action: 'buy' | 'watch';
  evidence?: string;
  reason: string;
  confidence: string;
  metrics: StoredDealMetrics;
}

/** profit-deals.json / radar-deals.json v4 — полный «мыслительный» снимок. */
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
  thresholds: StoredAnalysisThresholds;
  primary: StoredPrimaryVerdict;
  scopes: StoredScopeVerdict[];
  signals: string[];
}

export type ProfitDealRecord = SalingAnalysisRecord;
export type RadarDealRecord = SalingAnalysisRecord;

interface ProfitDealsStore {
  version: number;
  updatedAt: string;
  deals: SalingAnalysisRecord[];
}

interface RadarDealsStore {
  version: number;
  updatedAt: string;
  deals: SalingAnalysisRecord[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function salingPauseMs(): number {
  const jitter =
    Math.floor(Math.random() * (SALING_SCANNER_JITTER_MS * 2 + 1)) -
    SALING_SCANNER_JITTER_MS;
  return SALING_SCANNER_INTERVAL_MS + jitter;
}

function loadProfitStore(): ProfitDealsStore {
  return loadAnalysisStore(PROFIT_DEALS_FILE);
}

function loadRadarStore(): RadarDealsStore {
  return loadAnalysisStore(RADAR_DEALS_FILE);
}

function loadAnalysisStore(file: string): ProfitDealsStore {
  if (!existsSync(file)) {
    return {
      version: DEALS_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      deals: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      deals?: unknown[];
    };
    const deals = (Array.isArray(raw.deals) ? raw.deals : [])
      .map((d) => parseAnalysisRecord(d))
      .filter((d): d is SalingAnalysisRecord => d !== null);
    return {
      version: DEALS_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      deals,
    };
  } catch {
    return {
      version: DEALS_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      deals: [],
    };
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function metricsFromRaw(
  metrics: Record<string, unknown>,
  confidenceOverride?: string,
): StoredDealMetrics {
  return {
    listingPrice: num(metrics.listingPrice),
    referencePrice: num(metrics.referencePrice),
    floorPrice: num(metrics.floorPrice),
    discountVsMedian: num(metrics.discountVsMedian),
    discountVsFloor: num(metrics.discountVsFloor),
    netMargin: num(metrics.netMargin),
    confidence: confidenceOverride ?? String(metrics.confidence ?? 'low'),
    samples: num(metrics.samples),
    salesPerDay: num(metrics.salesPerDay),
    windowDays:
      metrics.windowDays !== undefined ? num(metrics.windowDays) : undefined,
    samples7:
      metrics.samples7 !== undefined ? num(metrics.samples7) : undefined,
    samples30:
      metrics.samples30 === null || metrics.samples30 === undefined
        ? metrics.samples30 === null
          ? null
          : undefined
        : num(metrics.samples30),
    priceStability:
      metrics.priceStability === null || metrics.priceStability === undefined
        ? metrics.priceStability === null
          ? null
          : undefined
        : num(metrics.priceStability),
  };
}

function metricsFromVerdict(
  m: DealVerdict['metrics'],
  confidence: string,
): StoredDealMetrics {
  return {
    listingPrice: m.listingPrice,
    referencePrice: m.referencePrice,
    floorPrice: m.floorPrice,
    discountVsMedian: m.discountVsMedian,
    discountVsFloor: m.discountVsFloor,
    netMargin: m.netMargin,
    confidence,
    samples: m.samples,
    salesPerDay: m.salesPerDay,
    windowDays: m.windowDays,
    samples7: m.samples7,
    samples30: m.samples30,
    priceStability: m.priceStability,
  };
}

function scopeFromEval(s: ScopedLotEvaluation): StoredScopeVerdict {
  return {
    scope: s.scope,
    model: s.model,
    backdrop: s.backdrop,
    action: s.verdict.action,
    evidence: s.verdict.evidence,
    reason: s.verdict.reason,
    metrics: metricsFromVerdict(s.verdict.metrics, s.verdict.metrics.confidence),
  };
}

function currentThresholds(): StoredAnalysisThresholds {
  const t = getSalesVerdictThresholds();
  return {
    buyMinDiscount: t.buyMinDiscount,
    buyMinMargin: t.buyMinMargin,
    watchMinDiscount: t.watchMinDiscount,
    extendedBuyExtra: EXTENDED_BUY_EXTRA,
    minSamplesReliable: MIN_SAMPLES_TO_EVALUATE,
    weakSamples: WEAK_SAMPLES,
    extendedWindowDays: EXTENDED_WINDOW_DAYS,
    priceStabilityOk: PRICE_STABILITY_OK,
  };
}

function parseScopesFromRaw(o: Record<string, unknown>): StoredScopeVerdict[] {
  if (!Array.isArray(o.scopes)) return [];
  return o.scopes.flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const row = s as Record<string, unknown>;
    const sm = row.metrics as Record<string, unknown> | undefined;
    if (!sm || typeof row.scope !== 'string') return [];
    const out: StoredScopeVerdict = {
      scope: row.scope,
      model:
        row.model === null || typeof row.model === 'string' ? row.model : null,
      backdrop:
        row.backdrop === null || typeof row.backdrop === 'string'
          ? row.backdrop
          : null,
      action: String(row.action ?? 'skip'),
      reason: String(row.reason ?? ''),
      metrics: metricsFromRaw(sm),
    };
    if (typeof row.evidence === 'string') out.evidence = row.evidence;
    return [out];
  });
}

function parsePrimaryFromRaw(
  o: Record<string, unknown>,
  fallbackAction: 'buy' | 'watch',
): StoredPrimaryVerdict | null {
  const legacyVerdict = o.verdict as Record<string, unknown> | undefined;
  const primaryRaw = (o.primary ?? legacyVerdict) as
    | Record<string, unknown>
    | undefined;
  if (!primaryRaw || typeof primaryRaw !== 'object') return null;
  const pm = (primaryRaw.metrics ?? o.metrics) as
    | Record<string, unknown>
    | undefined;
  if (!pm) return null;
  const rawAction = primaryRaw.action ?? legacyVerdict?.action ?? o.action;
  const action: 'buy' | 'watch' =
    rawAction === 'buy' ? 'buy' : rawAction === 'watch' ? 'watch' : fallbackAction;
  const confidence = String(
    primaryRaw.confidence ?? pm.confidence ?? 'low',
  );
  const primary: StoredPrimaryVerdict = {
    scope: String(primaryRaw.scope ?? legacyVerdict?.scope ?? ''),
    action,
    reason: String(primaryRaw.reason ?? legacyVerdict?.reason ?? ''),
    confidence,
    metrics: metricsFromRaw(pm, confidence),
  };
  const ev = primaryRaw.evidence ?? legacyVerdict?.evidence;
  if (typeof ev === 'string') primary.evidence = ev;
  return primary;
}

function parseAnalysisRecord(raw: unknown): SalingAnalysisRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.listingId !== 'string' || typeof o.giftId !== 'string') {
    return null;
  }

  const hasPrimary = o.primary != null || o.verdict != null;
  if (!hasPrimary) return null;

  const legacyVerdict = o.verdict as Record<string, unknown> | undefined;
  const legacyAction = legacyVerdict?.action ?? o.action;
  const fallback: 'buy' | 'watch' = legacyAction === 'buy' ? 'buy' : 'watch';
  const primary = parsePrimaryFromRaw(o, fallback);
  if (!primary) return null;

  const scopes = parseScopesFromRaw(o);
  const stubFromPrimary = (): StoredScopeVerdict[] =>
    scopes.length > 0
      ? scopes
      : [
          {
            scope: primary.scope,
            model: String(o.model ?? '') || null,
            backdrop: String(o.backdrop ?? '') || null,
            action: primary.action,
            evidence: primary.evidence,
            reason: primary.reason,
            metrics: primary.metrics,
          },
        ];

  const thrRaw = o.thresholds as Record<string, unknown> | undefined;
  const thresholds: StoredAnalysisThresholds = thrRaw
    ? {
        buyMinDiscount: num(thrRaw.buyMinDiscount) || 0.08,
        buyMinMargin: num(thrRaw.buyMinMargin) || 0.04,
        watchMinDiscount: num(thrRaw.watchMinDiscount) || 0.04,
        extendedBuyExtra: num(thrRaw.extendedBuyExtra) || EXTENDED_BUY_EXTRA,
        minSamplesReliable:
          num(thrRaw.minSamplesReliable) || MIN_SAMPLES_TO_EVALUATE,
        weakSamples: num(thrRaw.weakSamples) || WEAK_SAMPLES,
        extendedWindowDays:
          num(thrRaw.extendedWindowDays) || EXTENDED_WINDOW_DAYS,
        priceStabilityOk: num(thrRaw.priceStabilityOk) || PRICE_STABILITY_OK,
      }
    : currentThresholds();

  const signals = Array.isArray(o.signals)
    ? o.signals.filter((s): s is string => typeof s === 'string')
    : [];

  return {
    detectedAt:
      typeof o.detectedAt === 'string'
        ? o.detectedAt
        : new Date().toISOString(),
    listingId: o.listingId,
    giftId: o.giftId,
    giftNumber:
      typeof o.giftNumber === 'number' && Number.isFinite(o.giftNumber)
        ? o.giftNumber
        : null,
    collection: String(o.collection ?? ''),
    model: String(o.model ?? ''),
    backdrop: String(o.backdrop ?? ''),
    priceTon: num(o.priceTon),
    analysisDays: num(o.analysisDays) || ANALYSIS_DAYS,
    feeRate: num(o.feeRate),
    backdropSlicesEnabled:
      o.backdropSlicesEnabled === true ||
      isBackdropEnabledForAnalysis(String(o.backdrop ?? '')),
    buyScopeCount: num(o.buyScopeCount),
    thresholds,
    primary,
    scopes: stubFromPrimary(),
    signals,
  };
}

function buildAnalysisRecord(
  gift: Gift,
  picked: PrimaryLotPick,
  scoped: ScopedLotEvaluation[],
  feeRate: number,
  analysisDays: number,
  buyScopeCount: number,
): SalingAnalysisRecord {
  const collection = gift.collectionName || gift.collectionTitle || gift.title;
  const model = gift.modelName || gift.modelTitle || '';
  const backdrop = gift.backdropName?.trim() ?? '';
  const best = picked.evaluation;
  const v = best.verdict;
  const action: 'buy' | 'watch' =
    v.action === 'buy' || v.action === 'watch' ? v.action : 'watch';

  return {
    detectedAt: new Date().toISOString(),
    listingId: gift.id,
    giftId: gift.giftIdString,
    giftNumber: Number.isFinite(gift.number) ? gift.number : null,
    collection,
    model,
    backdrop,
    priceTon: nanoToTon(gift.salePrice),
    analysisDays,
    feeRate,
    backdropSlicesEnabled: isBackdropEnabledForAnalysis(backdrop),
    buyScopeCount,
    thresholds: currentThresholds(),
    primary: {
      scope: best.scope,
      action,
      evidence: v.evidence,
      reason: v.reason,
      confidence: picked.confidence,
      metrics: metricsFromVerdict(v.metrics, picked.confidence),
    },
    scopes: scoped.map(scopeFromEval),
    signals: [...picked.notes],
  };
}

function saveProfitStore(store: ProfitDealsStore): void {
  mkdirSync(DATA_DIR, { recursive: true });
  store.version = DEALS_STORE_VERSION;
  store.updatedAt = new Date().toISOString();
  writeFileSync(PROFIT_DEALS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function saveRadarStore(store: RadarDealsStore): void {
  mkdirSync(DATA_DIR, { recursive: true });
  store.version = DEALS_STORE_VERSION;
  store.updatedAt = new Date().toISOString();
  writeFileSync(RADAR_DEALS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function formatScopeEval(s: ScopedLotEvaluation): string {
  const n7 = s.verdict.metrics.samples7 ?? s.verdict.metrics.samples;
  const ev = s.verdict.evidence ?? s.verdict.action;
  if (s.verdict.action === 'insufficient') {
    const n30 = s.verdict.metrics.samples30;
    return `${s.scope}=${ev}(n7=${n7}${n30 != null ? ` n30=${n30}` : ''})`;
  }
  const d = Math.round(s.verdict.metrics.discountVsMedian * 100);
  const m = Math.round(s.verdict.metrics.netMargin * 100);
  const win = s.verdict.metrics.windowDays ?? 7;
  const c = s.verdict.metrics.confidence;
  return `${s.scope}=${s.verdict.action}/${ev}(Δ${d}% M${m}% n=${s.verdict.metrics.samples} ${win}д ${c} n7=${n7})`;
}

const SALING_BUYS_CSV_HEADER =
  'price_ton,collection,model,backdrop,listing_id\n';

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function appendBuyCsvLog(
  gift: Gift,
  collection: string,
  priceTon: number,
): void {
  const model = gift.modelName || gift.modelTitle || '';
  const backdrop = gift.backdropName?.trim() ?? '';
  const listingId = gift.id || gift.giftIdString;
  const line = [
    priceTon.toFixed(3),
    csvField(collection),
    csvField(model),
    csvField(backdrop),
    csvField(listingId),
  ].join(',');
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(SALING_BUYS_CSV)) {
    writeFileSync(SALING_BUYS_CSV, SALING_BUYS_CSV_HEADER, 'utf-8');
  }
  appendFileSync(SALING_BUYS_CSV, `${line}\n`, 'utf-8');
  console.log(`[saling] buy,${line}`);
}

function logSalingLotAnalysis(
  gift: Gift,
  collection: string,
  listingTon: number,
  scoped: ScopedLotEvaluation[],
): void {
  const model = gift.modelName || '—';
  const backdrop = gift.backdropName?.trim() || '—';
  const scopes = scoped.map(formatScopeEval).join(' | ');
  const picked = pickPrimaryLotVerdict(scoped);
  const tail = picked
    ? `[вердикт: ${picked.evaluation.scope} ${picked.evaluation.verdict.action} ${picked.confidence}` +
      (picked.notes.length ? ` | ${picked.notes.join('; ')}` : '') +
      ']'
    : '[вердикт: нет надёжного среза]';
  console.log(
    `[saling] анализ ${collection} / ${model} / ${backdrop} #${gift.number} ` +
      `${listingTon.toFixed(3)} TON id=${(gift.id || gift.giftIdString).slice(0, 12)} → ${scopes} ` +
      tail,
  );
}

function upsertAnalysisDeal(
  store: ProfitDealsStore | RadarDealsStore,
  record: SalingAnalysisRecord,
): boolean {
  const idx = store.deals.findIndex((d) => d.listingId === record.listingId);
  if (idx >= 0) {
    const prev = store.deals[idx]!;
    if (record.primary.metrics.netMargin <= prev.primary.metrics.netMargin) {
      return false;
    }
    store.deals[idx] = record;
    return true;
  }
  store.deals.unshift(record);
  if (store.deals.length > MAX_RECORDS) {
    store.deals.length = MAX_RECORDS;
  }
  return true;
}

export interface SalingScanStats {
  scanned: number;
  /** Лотов, которых не было в прошлом ответе saling (проверка «кеша»/той же ленты) */
  newVsPreviousScan: number;
  repeatVsPreviousScan: number;
  /** Прошли фильтр включённых коллекций */
  analyzed: number;
  /** Финальный вердикт (узкий срез) = buy */
  buyLots: number;
  /** Сколько срезов дали buy (может быть > buyLots) */
  buyScopeHits: number;
  /** Финальный вердикт = watch → radar-deals.json */
  watchLots: number;
  profitAdded: number;
  radarAdded: number;
  totalProfitInFile: number;
  totalRadarInFile: number;
}

export async function scanSalingOnce(): Promise<SalingScanStats> {
  const res = await fetchSalingWithRetry(makeSalingScannerFeedRequest(), {
    retries: 2,
    timeoutMs: 25_000,
  });

  const { newVsPrevious, repeatVsPrevious } = diffVsPreviousScan(res.gifts);

  const profitStore = loadProfitStore();
  const radarStore = loadRadarStore();
  let profitAdded = 0;
  let radarAdded = 0;
  let analyzed = 0;
  let buyLots = 0;
  let buyScopeHits = 0;
  let watchLots = 0;
  const feeRate = getParseFeeRate();

  for (const gift of res.gifts) {
    const collection = gift.collectionName || gift.title;
    if (!collection || !isCollectionEnabledForParse(collection)) continue;

    analyzed++;
    const listingTon = nanoToTon(gift.salePrice);
    const scoped = evaluateLotAllScopes(
      collection,
      gift.modelName,
      gift.backdropName,
      listingTon,
      ANALYSIS_DAYS,
      feeRate,
    );

    logSalingLotAnalysis(gift, collection, listingTon, scoped);

    const picked = pickPrimaryLotVerdict(scoped);
    const buyScopeCount = scoped.filter(
      (s) => s.verdict.action === 'buy',
    ).length;
    buyScopeHits += buyScopeCount;
    if (!picked) continue;

    const action = picked.evaluation.verdict.action;
    if (action !== 'buy' && action !== 'watch') continue;

    const record = buildAnalysisRecord(
      gift,
      picked,
      scoped,
      feeRate,
      ANALYSIS_DAYS,
      buyScopeCount,
    );

    if (action === 'buy') {
      buyLots++;
      if (upsertAnalysisDeal(profitStore, record)) {
        profitAdded++;
        appendBuyCsvLog(gift, collection, listingTon);
      }
    } else if (action === 'watch') {
      watchLots++;
      if (upsertAnalysisDeal(radarStore, record)) radarAdded++;
    }
  }

  if (profitAdded > 0) saveProfitStore(profitStore);
  if (radarAdded > 0) saveRadarStore(radarStore);

  return {
    scanned: res.gifts.length,
    newVsPreviousScan: newVsPrevious,
    repeatVsPreviousScan: repeatVsPrevious,
    analyzed,
    buyLots,
    buyScopeHits,
    watchLots,
    profitAdded,
    radarAdded,
    totalProfitInFile: profitStore.deals.length,
    totalRadarInFile: radarStore.deals.length,
  };
}

export function loadProfitDeals(
  limit = 100,
): ProfitDealsStore & { count: number } {
  const store = loadProfitStore();
  const deals = store.deals.slice(0, Math.max(1, Math.min(limit, MAX_RECORDS)));
  return { ...store, deals, count: store.deals.length };
}

export function loadRadarDeals(
  limit = 100,
): RadarDealsStore & { count: number } {
  const store = loadRadarStore();
  const deals = store.deals.slice(0, Math.max(1, Math.min(limit, MAX_RECORDS)));
  return { ...store, deals, count: store.deals.length };
}

/** ID лотов из прошлого ответа POST /saling (только in-memory). */
let previousSalingListingIds = new Set<string>();

function diffVsPreviousScan(
  gifts: Gift[],
): { newVsPrevious: number; repeatVsPrevious: number } {
  const ids = gifts.map((g) => g.id).filter(Boolean);
  if (previousSalingListingIds.size === 0) {
    previousSalingListingIds = new Set(ids);
    return { newVsPrevious: ids.length, repeatVsPrevious: 0 };
  }
  let newVsPrevious = 0;
  let repeatVsPrevious = 0;
  for (const id of ids) {
    if (previousSalingListingIds.has(id)) repeatVsPrevious++;
    else newVsPrevious++;
  }
  previousSalingListingIds = new Set(ids);
  return { newVsPrevious, repeatVsPrevious };
}

/** Фоновый цикл: опрос saling ~3 с ±1 с, пока включено в parse-config. */
export async function runSalingScannerLoop(): Promise<void> {
  let wasOn = false;

  for (;;) {
    const on = isSalingScannerEnabled();
    if (on && !wasOn) {
      previousSalingListingIds = new Set();
      console.log(
        `[saling] сканер включён (лента новых лотов, ordering=None, count=20): ` +
          `~${SALING_SCANNER_INTERVAL_MS}ms ±${SALING_SCANNER_JITTER_MS}ms → ` +
          `buy: ${PROFIT_DEALS_FILE} + ${SALING_BUYS_CSV}, watch: ${RADAR_DEALS_FILE}`,
      );
    }
    if (!on && wasOn) {
      previousSalingListingIds = new Set();
    }
    wasOn = on;

    if (!on) {
      await sleep(2000);
      continue;
    }

    try {
      const s = await scanSalingOnce();
      const fileBits: string[] = [];
      if (s.profitAdded > 0) fileBits.push(`+${s.profitAdded} buy`);
      if (s.radarAdded > 0) fileBits.push(`+${s.radarAdded} watch`);
      console.log(
        `[saling] лента ${s.scanned} → новых vs прошлый опрос: ${s.newVsPreviousScan}` +
          `, повтор: ${s.repeatVsPreviousScan}` +
          ` | анализ ${s.analyzed}, buy ${s.buyLots} (срезов ${s.buyScopeHits}), watch ${s.watchLots}` +
          (fileBits.length ? ` | ${fileBits.join(', ')}` : '') +
          ` | profit: ${s.totalProfitInFile}, radar: ${s.totalRadarInFile}`,
      );
    } catch (err) {
      console.error('[saling] ошибка запроса:', err);
    }

    await sleep(salingPauseMs());
  }
}
