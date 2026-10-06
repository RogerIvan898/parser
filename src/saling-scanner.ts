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

interface DealsStore {
  version: 2;
  updatedAt: string;
  deals: ProfitDealRecord[];
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

function loadStore(file: string): DealsStore {
  if (!existsSync(file)) {
    return { version: 2, updatedAt: new Date().toISOString(), deals: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      deals?: unknown[];
    };
    const deals = (Array.isArray(raw.deals) ? raw.deals : [])
      .map((d) => slimDealRecord(d))
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

function slimDealRecord(raw: unknown): ProfitDealRecord | null {
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

function saveStore(file: string, store: DealsStore): void {
  mkdirSync(DATA_DIR, { recursive: true });
  store.version = 2;
  store.updatedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8');
}

function giftToRecord(
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

function upsertDeal(store: DealsStore, record: ProfitDealRecord): boolean {
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

  const profitStore = loadStore(PROFIT_DEALS_FILE);
  const radarStore = loadStore(RADAR_DEALS_FILE);
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

    const record = giftToRecord(gift, picked);
    if (action === 'buy') {
      buyLots++;
      if (upsertDeal(profitStore, record)) profitAdded++;
    } else if (action === 'watch') {
      watchLots++;
      if (upsertDeal(radarStore, record)) radarAdded++;
    }
  }

  if (profitAdded > 0) saveStore(PROFIT_DEALS_FILE, profitStore);
  if (radarAdded > 0) saveStore(RADAR_DEALS_FILE, radarStore);

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

export function loadProfitDeals(limit = 100): DealsStore & { count: number } {
  const store = loadStore(PROFIT_DEALS_FILE);
  const deals = store.deals.slice(0, Math.max(1, Math.min(limit, MAX_RECORDS)));
  return { ...store, deals, count: store.deals.length };
}

export function loadRadarDeals(limit = 100): DealsStore & { count: number } {
  const store = loadStore(RADAR_DEALS_FILE);
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
