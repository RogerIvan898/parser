import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fetchSalingWithRetry,
  makeSalingScannerFeedRequest,
} from './client.js';
import type { Gift } from './types.js';
import { nanoToTon, formatTon } from './types.js';
import { decide, type DealVerdict } from './db/analytics.js';
import { getModelLiquiditySnapshot } from './db/liquidity.js';
import {
  isSalingScannerEnabled,
  isCollectionEnabledForParse,
  SALING_SCANNER_INTERVAL_MS,
  SALING_SCANNER_JITTER_MS,
  getParseFeeRate,
} from './parse-config.js';
import { DATA_DIR } from './store.js';

export const PROFIT_DEALS_FILE = resolve(DATA_DIR, 'profit-deals.json');

const ANALYSIS_DAYS = 7;
const MAX_RECORDS = 400;

/**
 * POST /api/v1/gifts/saling с пустыми фильтрами и ordering `None` —
 * в ответе порция **недавно выставленных** лотов (как лента в MRKT), не «топ дешёвых».
 * Тело совпадает с `makeSalingScannerFeedRequest()` в client.ts (count: 20).
 */

export interface ProfitDealLiquidity {
  samples: number;
  salesPerDay: number;
  medianTon: number;
  confidence: string;
  freshness: string;
  lastSaleAgeDays: number;
  iqrRatio: number | null;
  trend: number | null;
}

export interface ProfitDealRecord {
  detectedAt: string;
  listingId: string;
  giftId: string;
  url: string;
  collection: string;
  model: string;
  backdrop: string;
  symbol: string;
  number: number;
  priceTon: number;
  priceFormatted: string;
  verdict: {
    action: DealVerdict['action'];
    reason: string;
    metrics: DealVerdict['metrics'];
  };
  liquidity: ProfitDealLiquidity | null;
}

interface ProfitDealsStore {
  version: 1;
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

function loadStore(): ProfitDealsStore {
  if (!existsSync(PROFIT_DEALS_FILE)) {
    return { version: 1, updatedAt: new Date().toISOString(), deals: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(PROFIT_DEALS_FILE, 'utf-8')) as ProfitDealsStore;
    return {
      version: 1,
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      deals: Array.isArray(raw.deals) ? raw.deals : [],
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), deals: [] };
  }
}

function saveStore(store: ProfitDealsStore): void {
  mkdirSync(DATA_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  writeFileSync(PROFIT_DEALS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function giftToRecord(gift: Gift, verdict: DealVerdict): ProfitDealRecord {
  const collection = gift.collectionName || gift.collectionTitle || gift.title;
  const model = gift.modelName || gift.modelTitle;
  const listingTon = nanoToTon(gift.salePrice);
  const liq = getModelLiquiditySnapshot(collection, model, ANALYSIS_DAYS);

  return {
    detectedAt: new Date().toISOString(),
    listingId: gift.id,
    giftId: gift.giftIdString,
    url: `https://t.me/mrkt/app?startapp=gift_${gift.giftIdString}`,
    collection,
    model,
    backdrop: gift.backdropName ?? '',
    symbol: gift.symbolName ?? '',
    number: gift.number,
    priceTon: listingTon,
    priceFormatted: formatTon(gift.salePrice, 4),
    verdict: {
      action: verdict.action,
      reason: verdict.reason,
      metrics: verdict.metrics,
    },
    liquidity: liq
      ? {
          samples: liq.samples,
          salesPerDay: liq.salesPerDay,
          medianTon: liq.medianTon,
          confidence: liq.confidence,
          freshness: liq.freshness,
          lastSaleAgeDays: liq.lastSaleAgeDays,
          iqrRatio: liq.iqrRatio,
          trend: liq.trend,
        }
      : null,
  };
}

function upsertDeal(store: ProfitDealsStore, record: ProfitDealRecord): boolean {
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
  /** Вердикт buy (не все попадут в JSON — дедуп) */
  buyVerdicts: number;
  added: number;
  totalInFile: number;
}

export async function scanSalingOnce(): Promise<SalingScanStats> {
  const res = await fetchSalingWithRetry(makeSalingScannerFeedRequest(), {
    retries: 2,
    timeoutMs: 25_000,
  });

  const { newVsPrevious, repeatVsPrevious } = diffVsPreviousScan(res.gifts);

  const store = loadStore();
  let added = 0;
  let analyzed = 0;
  let buyVerdicts = 0;

  for (const gift of res.gifts) {
    const collection = gift.collectionName || gift.title;
    if (!collection || !isCollectionEnabledForParse(collection)) continue;

    const model = gift.modelName;
    if (!model) continue;

    analyzed++;
    const listingTon = nanoToTon(gift.salePrice);
    const floorNano =
      gift.floorPriceNanoTONsByBackdropModel ??
      gift.floorPriceNanoTONsByCollection;
    const floorTon = floorNano != null ? nanoToTon(floorNano) : 0;

    const verdict = decide(
      collection,
      model,
      gift.backdropName,
      listingTon,
      floorTon,
      ANALYSIS_DAYS,
      getParseFeeRate(),
    );

    if (verdict.action !== 'buy') continue;

    buyVerdicts++;
    const record = giftToRecord(gift, verdict);
    if (upsertDeal(store, record)) added++;
  }

  if (added > 0) saveStore(store);

  return {
    scanned: res.gifts.length,
    newVsPreviousScan: newVsPrevious,
    repeatVsPreviousScan: repeatVsPrevious,
    analyzed,
    buyVerdicts,
    added,
    totalInFile: store.deals.length,
  };
}

export function loadProfitDeals(limit = 100): ProfitDealsStore & { count: number } {
  const store = loadStore();
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
          `~${SALING_SCANNER_INTERVAL_MS}ms ±${SALING_SCANNER_JITTER_MS}ms → ${PROFIT_DEALS_FILE}`,
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
      console.log(
        `[saling] лента ${s.scanned} → новых vs прошлый опрос: ${s.newVsPreviousScan}` +
          `, повтор: ${s.repeatVsPreviousScan}` +
          ` | анализ ${s.analyzed}, buy ${s.buyVerdicts}` +
          (s.added > 0 ? `, +${s.added} в JSON` : '') +
          ` | в файле: ${s.totalInFile}`,
      );
    } catch (err) {
      console.error('[saling] ошибка запроса:', err);
    }

    await sleep(salingPauseMs());
  }
}
