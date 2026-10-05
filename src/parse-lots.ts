import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initClient,
  fetchAllSaling,
  makeDefaultSalingRequest,
} from './client.js';
import type { Gift } from './types.js';
import { formatTon } from './types.js';

const OUT_DIR = resolve(process.cwd(), 'data');
const OUT_FILE = resolve(OUT_DIR, 'lots.json');

export interface LotRow {
  id: string;
  giftId: string;
  collection: string;
  model: string;
  backdrop: string;
  symbol: string;
  number: number;
  priceNano: number;
  priceTon: string;
  floorCollectionNano: number | null;
  floorBackdropModelNano: number | null;
  luckyBuy: boolean;
  isPremarket: boolean;
  url: string;
}

export interface LotsExport {
  fetchedAt: string;
  totalOnMarket: number;
  parsed: number;
  filters: {
    collectionNames: string[];
    modelNames: string[];
    ordering: string;
    lowToHigh: boolean;
    maxPages: number;
  };
  lots: LotRow[];
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function argList(flag: string): string[] {
  const v = argValue(flag);
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function toLotRow(g: Gift): LotRow {
  const collection = g.collectionTitle || g.title;
  const model = g.modelTitle || g.modelName;
  return {
    id: g.id,
    giftId: g.giftIdString,
    collection,
    model,
    backdrop: g.backdropName,
    symbol: g.symbolName,
    number: g.number,
    priceNano: g.salePrice,
    priceTon: formatTon(g.salePrice, 4),
    floorCollectionNano: g.floorPriceNanoTONsByCollection,
    floorBackdropModelNano: g.floorPriceNanoTONsByBackdropModel,
    luckyBuy: g.luckyBuy,
    isPremarket: g.premarketStatus !== 'None' && g.premarketStatus !== '',
    url: `https://t.me/mrkt/app?startapp=gift_${g.giftIdString}`,
  };
}

async function main(): Promise<void> {
  const collectionNames = argList('--collection');
  const modelNames = argList('--model');
  const maxPages = Number(argValue('--max-pages') ?? '50');
  const count = Number(argValue('--count') ?? '50');
  const ordering = argValue('--order') ?? 'Price';
  const lowToHigh = process.argv.includes('--asc');

  console.log('=== Парсинг лотов MRKT ===');
  console.log('[lots] авторизация (MRKT_AUTH / config / auth.json)...');
  await initClient();

  const filters = makeDefaultSalingRequest({
    count,
    collectionNames,
    modelNames,
    ordering,
    lowToHigh,
    removeSelfSales: true,
  });

  console.log(
    `[lots] запрос: collections=${collectionNames.length || 'все'}, ` +
      `models=${modelNames.length || 'все'}, order=${ordering}, ` +
      `pageSize=${count}, maxPages=${maxPages}`,
  );

  const { gifts, total } = await fetchAllSaling(filters, {
    maxPages,
    delayMs: 300,
    onPage: (page, batch, marketTotal, cursor) => {
      console.log(
        `[lots] стр. ${page}: +${batch} лотов, на маркете ~${marketTotal}, cursor=${cursor ?? '—'}`,
      );
    },
  });

  const lots = gifts.map(toLotRow);
  const payload: LotsExport = {
    fetchedAt: new Date().toISOString(),
    totalOnMarket: total,
    parsed: lots.length,
    filters: {
      collectionNames,
      modelNames,
      ordering,
      lowToHigh,
      maxPages,
    },
    lots,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');

  console.log(`\n[lots] готово: ${lots.length} лотов → ${OUT_FILE}`);

  const preview = [...lots]
    .sort((a, b) => a.priceNano - b.priceNano)
    .slice(0, 5);
  if (preview.length > 0) {
    console.log('\nТоп-5 самых дешёвых в выборке:');
    for (const l of preview) {
      console.log(
        `  ${l.collection} / ${l.model} #${l.number} — ${l.priceTon} TON`,
      );
    }
  }
}

main().catch((err) => {
  console.error('[lots] fatal:', err);
  process.exit(1);
});
