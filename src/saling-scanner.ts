import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  type DealVerdict,
  type PrimaryLotPick,
  type ScopedLotEvaluation,
} from './db/analytics.js';
import {
  isSalingScannerEnabled,
  isCollectionEnabledForParse,
  SALING_SCANNER_INTERVAL_MS,
  SALING_SCANNER_JITTER_MS,
  getParseFeeRate,
} from './parse-config.js';
import { DATA_DIR } from './store.js';

export const PROFIT_DEALS_FILE = resolve(DATA_DIR, 'profit-deals.json');
export const RADAR_DEALS_FILE = resolve(DATA_DIR, 'radar-deals.json');

const ANALYSIS_DAYS = 7;
const MAX_RECORDS = 400;

/**
 * POST /api/v1/gifts/saling с пустыми фильтрами и ordering `None` —
 * в ответе порция **недавно выставленных** лотов (как лента в MRKT), не «топ дешёвых».
 * Тело совпадает с `makeSalingScannerFeedRequest()` в client.ts (count: 20).
 */

export interface ProfitDealRecord {
  detectedAt: string;
  listingId: string;
  giftId: string;
  collection: string;
  model: string;
  backdrop: string;
  priceTon: number;
  verdict: {
    action: 'buy' | 'watch' | 'skip';
    scope: string;
    metrics: {
      netMargin: number;
      discountVsMedian: number;
      samples: number;
      confidence: string;
    };
  };
  /** Соседние срезы, которые не стали вердиктом (мало данных, слабая выборка). */
  signals?: string[];
}

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

/** radar-deals.json v3 — весь разбор лота для ручного снайпинга. */
export interface RadarDealRecord {
  detectedAt: string;
  listingId: string;
  giftId: string;
  collection: string;
  model: string;
  backdrop: string;
  priceTon: number;
  analysisDays: number;
  feeRate: number;
  primary: {
    scope: string;
    action: 'watch';
    evidence?: string;
    reason: string;
    confidence: string;
    metrics: StoredDealMetrics;
  };
  scopes: StoredScopeVerdict[];
  signals?: string[];
}

interface ProfitDealsStore {
  version: 2;
  updatedAt: string;
  deals: ProfitDealRecord[];
}

interface RadarDealsStore {
  version: 3;
  updatedAt: string;
  deals: RadarDealRecord[];
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
  if (!existsSync(PROFIT_DEALS_FILE)) {
    return { version: 2, updatedAt: new Date().toISOString(), deals: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(PROFIT_DEALS_FILE, 'utf-8')) as {
      deals?: unknown[];
    };
    const deals = (Array.isArray(raw.deals) ? raw.deals : [])
      .map((d) => slimProfitDealRecord(d))
      .filter((d): d is ProfitDealRecord => d !== null);
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      deals,
    };
  } catch {
    return { version: 2, updatedAt: new Date().toISOString(), deals: [] };
  }
}

function loadRadarStore(): RadarDealsStore {
  if (!existsSync(RADAR_DEALS_FILE)) {
    return { version: 3, updatedAt: new Date().toISOString(), deals: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(RADAR_DEALS_FILE, 'utf-8')) as {
      deals?: unknown[];
    };
    const deals = (Array.isArray(raw.deals) ? raw.deals : [])
      .map((d) => parseRadarDealRecord(d))
      .filter((d): d is RadarDealRecord => d !== null);
    return {
      version: 3,
      updatedAt: new Date().toISOString(),
      deals,
    };
  } catch {
    return { version: 3, updatedAt: new Date().toISOString(), deals: [] };
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

function parseRadarDealRecord(raw: unknown): RadarDealRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.listingId !== 'string' || typeof o.giftId !== 'string') {
    return null;
  }

  const primaryRaw = o.primary as Record<string, unknown> | undefined;
  if (primaryRaw && typeof primaryRaw === 'object') {
    const pm = primaryRaw.metrics as Record<string, unknown> | undefined;
    if (!pm) return null;
    const scopes: StoredScopeVerdict[] = Array.isArray(o.scopes)
      ? o.scopes.flatMap((s) => {
          if (!s || typeof s !== 'object') return [];
          const row = s as Record<string, unknown>;
          const sm = row.metrics as Record<string, unknown> | undefined;
          if (!sm || typeof row.scope !== 'string') return [];
          const out: StoredScopeVerdict = {
            scope: row.scope,
            model:
              row.model === null || typeof row.model === 'string'
                ? row.model
                : null,
            backdrop:
              row.backdrop === null || typeof row.backdrop === 'string'
                ? row.backdrop
                : null,
            action: String(row.action ?? 'skip'),
            reason: String(row.reason ?? ''),
            metrics: metricsFromRaw(sm),
          };
          if (typeof row.evidence === 'string') {
            out.evidence = row.evidence;
          }
          return [out];
        })
      : [];

    return {
      detectedAt:
        typeof o.detectedAt === 'string'
          ? o.detectedAt
          : new Date().toISOString(),
      listingId: o.listingId,
      giftId: o.giftId,
      collection: String(o.collection ?? ''),
      model: String(o.model ?? ''),
      backdrop: String(o.backdrop ?? ''),
      priceTon: num(o.priceTon),
      analysisDays: num(o.analysisDays) || ANALYSIS_DAYS,
      feeRate: num(o.feeRate),
      primary: {
        scope: String(primaryRaw.scope ?? ''),
        action: 'watch',
        evidence:
          typeof primaryRaw.evidence === 'string'
            ? primaryRaw.evidence
            : undefined,
        reason: String(primaryRaw.reason ?? ''),
        confidence: String(primaryRaw.confidence ?? pm.confidence ?? 'low'),
        metrics: metricsFromRaw(
          pm,
          String(primaryRaw.confidence ?? pm.confidence ?? 'low'),
        ),
      },
      scopes,
      signals: Array.isArray(o.signals)
        ? o.signals.filter((s): s is string => typeof s === 'string')
        : undefined,
    };
  }

  const slim = slimProfitDealRecord(raw);
  if (!slim || slim.verdict.action !== 'watch') return null;
  const m = slim.verdict.metrics;
  const stubMetrics: StoredDealMetrics = {
    listingPrice: slim.priceTon,
    referencePrice: 0,
    floorPrice: 0,
    discountVsMedian: m.discountVsMedian,
    discountVsFloor: 0,
    netMargin: m.netMargin,
    confidence: m.confidence,
    samples: m.samples,
    salesPerDay: 0,
  };
  return {
    detectedAt: slim.detectedAt,
    listingId: slim.listingId,
    giftId: slim.giftId,
    collection: slim.collection,
    model: slim.model,
    backdrop: slim.backdrop,
    priceTon: slim.priceTon,
    analysisDays: ANALYSIS_DAYS,
    feeRate: 0,
    primary: {
      scope: slim.verdict.scope,
      action: 'watch',
      reason: '',
      confidence: m.confidence,
      metrics: stubMetrics,
    },
    scopes: [
      {
        scope: slim.verdict.scope,
        model: slim.model || null,
        backdrop: slim.backdrop || null,
        action: 'watch',
        reason: '',
        metrics: stubMetrics,
      },
    ],
    signals: slim.signals,
  };
}

function slimProfitDealRecord(raw: unknown): ProfitDealRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const listingId = o.listingId;
  const giftId = o.giftId;
  if (typeof listingId !== 'string' || typeof giftId !== 'string') return null;

  const legacyVerdict = o.verdict as Record<string, unknown> | undefined;
  const metrics = (legacyVerdict?.metrics ?? o.metrics) as
    | Record<string, unknown>
    | undefined;
  if (!metrics || typeof metrics !== 'object') return null;

  const scope =
    typeof legacyVerdict?.scope === 'string'
      ? legacyVerdict.scope
      : typeof o.scope === 'string'
        ? o.scope
        : '';
  const action = legacyVerdict?.action ?? o.action;
  if (action !== 'buy' && action !== 'watch' && action !== 'skip') return null;

  return {
    detectedAt:
      typeof o.detectedAt === 'string'
        ? o.detectedAt
        : new Date().toISOString(),
    listingId,
    giftId,
    collection: String(o.collection ?? ''),
    model: String(o.model ?? ''),
    backdrop: String(o.backdrop ?? ''),
    priceTon: Number(o.priceTon) || 0,
    verdict: {
      action,
      scope,
      metrics: {
        netMargin: Number(metrics.netMargin) || 0,
        discountVsMedian: Number(metrics.discountVsMedian) || 0,
        samples: Number(metrics.samples) || 0,
        confidence: String(metrics.confidence ?? 'low'),
      },
    },
    signals: Array.isArray(o.signals)
      ? o.signals.filter((s): s is string => typeof s === 'string')
      : undefined,
  };
}

function saveProfitStore(store: ProfitDealsStore): void {
  mkdirSync(DATA_DIR, { recursive: true });
  store.version = 2;
  store.updatedAt = new Date().toISOString();
  writeFileSync(PROFIT_DEALS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function saveRadarStore(store: RadarDealsStore): void {
  mkdirSync(DATA_DIR, { recursive: true });
  store.version = 3;
  store.updatedAt = new Date().toISOString();
  writeFileSync(RADAR_DEALS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function giftToProfitRecord(
  gift: Gift,
  picked: PrimaryLotPick,
): ProfitDealRecord {
  const collection = gift.collectionName || gift.collectionTitle || gift.title;
  const model = gift.modelName || gift.modelTitle || '';
  const best = picked.evaluation;
  const m = best.verdict.metrics;
  const action = best.verdict.action;
  if (action !== 'buy' && action !== 'watch') {
    throw new Error('giftToRecord: только buy/watch');
  }

  return {
    detectedAt: new Date().toISOString(),
    listingId: gift.id,
    giftId: gift.giftIdString,
    collection,
    model,
    backdrop: gift.backdropName ?? '',
    priceTon: nanoToTon(gift.salePrice),
    verdict: {
      action,
      scope: best.scope,
      metrics: {
        netMargin: m.netMargin,
        discountVsMedian: m.discountVsMedian,
        samples: m.samples,
        confidence: picked.confidence,
      },
    },
    signals: picked.notes.length > 0 ? picked.notes : undefined,
  };
}

function giftToRadarRecord(
  gift: Gift,
  picked: PrimaryLotPick,
  scoped: ScopedLotEvaluation[],
  feeRate: number,
  analysisDays: number,
): RadarDealRecord {
  const collection = gift.collectionName || gift.collectionTitle || gift.title;
  const model = gift.modelName || gift.modelTitle || '';
  const best = picked.evaluation;
  const v = best.verdict;

  return {
    detectedAt: new Date().toISOString(),
    listingId: gift.id,
    giftId: gift.giftIdString,
    collection,
    model,
    backdrop: gift.backdropName ?? '',
    priceTon: nanoToTon(gift.salePrice),
    analysisDays,
    feeRate,
    primary: {
      scope: best.scope,
      action: 'watch',
      evidence: v.evidence,
      reason: v.reason,
      confidence: picked.confidence,
      metrics: metricsFromVerdict(v.metrics, picked.confidence),
    },
    scopes: scoped.map(scopeFromEval),
    signals: picked.notes.length > 0 ? picked.notes : undefined,
  };
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

function upsertProfitDeal(
  store: ProfitDealsStore,
  record: ProfitDealRecord,
): boolean {
  const idx = store.deals.findIndex((d) => d.listingId === record.listingId);
  if (idx >= 0) {
    const prev = store.deals[idx]!;
    if (record.verdict.metrics.netMargin <= prev.verdict.metrics.netMargin) {
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

function upsertRadarDeal(store: RadarDealsStore, record: RadarDealRecord): boolean {
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
    const buys = scoped.filter((s) => s.verdict.action === 'buy');
    buyScopeHits += buys.length;
    if (!picked) continue;

    const action = picked.evaluation.verdict.action;
    if (action !== 'buy' && action !== 'watch') continue;

    if (action === 'buy') {
      buyLots++;
      const record = giftToProfitRecord(gift, picked);
      if (upsertProfitDeal(profitStore, record)) profitAdded++;
    } else if (action === 'watch') {
      watchLots++;
      const record = giftToRadarRecord(
        gift,
        picked,
        scoped,
        feeRate,
        ANALYSIS_DAYS,
      );
      if (upsertRadarDeal(radarStore, record)) radarAdded++;
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
          `buy: ${PROFIT_DEALS_FILE}, watch: ${RADAR_DEALS_FILE}`,
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
