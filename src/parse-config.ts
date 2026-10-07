import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './store.js';

export const PARSE_CONFIG_FILE = resolve(DATA_DIR, 'parse-config.json');

export interface ParserTiming {
  delayMs: number;
  feedPages: number;
  historyRoundMs: number;
}

export interface ParseConfig {
  version: 1;
  updatedAt: string;
  /**
   * null — явно не настроено, парсим все коллекции (обратная совместимость).
   * [] — ничего не парсим.
   */
  enabledCollections: string[] | null;
  /** parse --history: доп. POST /feed по фонам из HISTORY_FEED_BACKDROP_NAMES */
  historyFetchBackdrops: boolean;
  /** null — брать из env (PARSER_DELAY_MS и т.д.) */
  parserDelayMs: number | null;
  parserFeedPages: number | null;
  parserHistoryRoundMs: number | null;
  /** Параллельный опрос POST /gifts/saling и запись выгодных лотов в profit-deals.json */
  salingScannerEnabled: boolean;
  /** Доля комиссии MRKT при перепродаже (0–1). null → DEFAULT_FEE_RATE */
  feeRate: number | null;
  /** Пороги decideFromSales (доли 0–1). null → DEFAULT_SALES_VERDICT_THRESHOLDS */
  buyMinDiscount: number | null;
  buyMinMargin: number | null;
  watchMinDiscount: number | null;
  /** Добавка к buy-марже при trendStatus=bullish. null → 0.02 (+2 п.п.). */
  bullishMarginPremium: number | null;
  /** null → DEFAULT_BACKDROP_ADJUSTMENT */
  backdropAdjustment: BackdropAdjustmentConfig | null;
  /** Ручные связки коллекция+модель+фон с наценкой к цене модели. */
  styleCombos: StyleCombo[];
}

/** Ручное объявление: эта модель с этим фоном — отдельный рынок. Цена только из его продаж. */
export interface StyleCombo {
  collection: string;
  model: string;
  backdrop: string;
}

export interface BackdropTierBand {
  range: [number, number];
  shiftFactor: number;
}

export interface BackdropAdjustmentConfig {
  lowVolume: BackdropTierBand & { maxSales30: number; minSales7: number };
  midVolume: BackdropTierBand & { maxSales30: number; minSales7: number };
  highVolume: BackdropTierBand & { minSales30: number; minSales7: number };
}

export const DEFAULT_FEE_RATE = 0.02;

export interface SalesVerdictThresholds {
  buyMinDiscount: number;
  buyMinMargin: number;
  watchMinDiscount: number;
}

export const DEFAULT_SALES_VERDICT_THRESHOLDS: SalesVerdictThresholds = {
  buyMinDiscount: 0.08,
  buyMinMargin: 0.04,
  watchMinDiscount: 0.04,
};

/** На росте 3д buy требует эту добавку к марже. 0.02: было 4%, стало 6%. */
export const DEFAULT_BULLISH_MARGIN_PREMIUM = 0.02;

export const DEFAULT_BACKDROP_ADJUSTMENT: BackdropAdjustmentConfig = {
  lowVolume: {
    maxSales30: 14,
    minSales7: 0,
    range: [0.8, 1.2],
    shiftFactor: 0.5,
  },
  midVolume: {
    maxSales30: 29,
    minSales7: 3,
    range: [0.65, 1.4],
    shiftFactor: 0.75,
  },
  highVolume: {
    minSales30: 30,
    minSales7: 7,
    range: [0.5, 2],
    shiftFactor: 1,
  },
};

/** При включённом saling-сканере пауза между запросами каталога/history */
export const SALING_SCANNER_MODEL_DELAY_MS = 5000;
/** Базовый интервал опроса saling */
export const SALING_SCANNER_INTERVAL_MS = 3000;
/** Случайный разброс ± jitter к интервалу saling */
export const SALING_SCANNER_JITTER_MS = 1000;

/** Фоны для доп. запросов history (не весь catalog.json). */
export const HISTORY_FEED_BACKDROP_NAMES = ['Black', 'Onyx Black'] as const;

export function getHistoryFeedBackdropNames(): readonly string[] {
  return HISTORY_FEED_BACKDROP_NAMES;
}

/** Срезы collection+backdrop / model+backdrop в оценке и saling — только эти фоны. */
export function isBackdropEnabledForAnalysis(
  backdrop: string | null | undefined,
): boolean {
  const name = backdrop?.trim();
  if (!name) return false;
  return (HISTORY_FEED_BACKDROP_NAMES as readonly string[]).includes(name);
}

function emptyConfig(): ParseConfig {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    enabledCollections: null,
    historyFetchBackdrops: true,
    parserDelayMs: null,
    parserFeedPages: null,
    parserHistoryRoundMs: null,
    salingScannerEnabled: false,
    feeRate: null,
    buyMinDiscount: null,
    buyMinMargin: null,
    watchMinDiscount: null,
    bullishMarginPremium: null,
    backdropAdjustment: null,
    styleCombos: [],
  };
}

function parseFeeRateConfig(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 1) return null;
  return n;
}

export function getParseFeeRate(): number {
  const cfg = loadParseConfig();
  return cfg.feeRate ?? DEFAULT_FEE_RATE;
}

function parseThresholdFraction(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 1) return null;
  return n;
}

/** Пороги buy/watch для saling и «Оценки» — читаются на каждый лот. */
export function getSalesVerdictThresholds(): SalesVerdictThresholds {
  const cfg = loadParseConfig();
  const d = DEFAULT_SALES_VERDICT_THRESHOLDS;
  return {
    buyMinDiscount: cfg.buyMinDiscount ?? d.buyMinDiscount,
    buyMinMargin: cfg.buyMinMargin ?? d.buyMinMargin,
    watchMinDiscount: cfg.watchMinDiscount ?? d.watchMinDiscount,
  };
}

function parseOptionalPositiveInt(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  if (v < min || v > max) return null;
  return v;
}

/** Дефолты из переменных окружения (при старте контейнера). */
export function getParserEnvDefaults(): ParserTiming {
  const delayMs = Number(process.env.PARSER_DELAY_MS) || 400;
  return {
    delayMs,
    feedPages: Number(process.env.PARSER_FEED_PAGES) || 5,
    historyRoundMs: Number(process.env.PARSER_HISTORY_ROUND_MS) || delayMs * 3,
  };
}

/** Актуальные значения: env + переопределение из data/parse-config.json (читается на каждый sleep). */
export function getParserTiming(): ParserTiming {
  const env = getParserEnvDefaults();
  const cfg = loadParseConfig();
  return {
    delayMs: cfg.parserDelayMs ?? env.delayMs,
    feedPages: cfg.parserFeedPages ?? env.feedPages,
    historyRoundMs: cfg.parserHistoryRoundMs ?? env.historyRoundMs,
  };
}

export function isSalingScannerEnabled(): boolean {
  return loadParseConfig().salingScannerEnabled === true;
}

/** Пауза парсера моделей/history: в режиме saling фиксированно 5 с. */
export function getEffectiveParserDelayMs(): number {
  if (isSalingScannerEnabled()) return SALING_SCANNER_MODEL_DELAY_MS;
  return getParserTiming().delayMs;
}

function normalizeConfig(raw: Partial<ParseConfig>): ParseConfig {
  return {
    version: 1,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    enabledCollections:
      raw.enabledCollections === undefined
        ? null
        : Array.isArray(raw.enabledCollections)
          ? raw.enabledCollections.filter(
              (n) => typeof n === 'string' && n.trim().length > 0,
            )
          : null,
    historyFetchBackdrops: raw.historyFetchBackdrops !== false,
    parserDelayMs: parseOptionalPositiveInt(raw.parserDelayMs, 50, 60_000),
    parserFeedPages: parseOptionalPositiveInt(raw.parserFeedPages, 1, 50),
    parserHistoryRoundMs: parseOptionalPositiveInt(
      raw.parserHistoryRoundMs,
      0,
      3_600_000,
    ),
    salingScannerEnabled: raw.salingScannerEnabled === true,
    feeRate: parseFeeRateConfig(raw.feeRate),
    buyMinDiscount: parseThresholdFraction(raw.buyMinDiscount),
    buyMinMargin: parseThresholdFraction(raw.buyMinMargin),
    watchMinDiscount: parseThresholdFraction(raw.watchMinDiscount),
    bullishMarginPremium: parseThresholdFraction(raw.bullishMarginPremium),
    backdropAdjustment: parseBackdropAdjustment(raw.backdropAdjustment),
    styleCombos: parseStyleCombos(raw.styleCombos),
  };
}

function parseStyleCombos(value: unknown): StyleCombo[] {
  if (!Array.isArray(value)) return [];
  const out: StyleCombo[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const collection = String(item.collection ?? '').trim();
    const model = String(item.model ?? '').trim();
    const backdrop = String(item.backdrop ?? '').trim();
    if (!collection || !model || !backdrop) continue;
    const key = styleComboKey(collection, model, backdrop);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ collection, model, backdrop });
  }
  return out;
}

export function styleComboKey(
  collection: string,
  model: string,
  backdrop: string,
): string {
  return `${collection.trim()}\0${model.trim()}\0${backdrop.trim()}`;
}

export function listStyleCombos(): StyleCombo[] {
  return loadParseConfig().styleCombos;
}

export function findStyleCombo(
  collection: string,
  model: string | null | undefined,
  backdrop: string | null | undefined,
): StyleCombo | null {
  const modelName = model?.trim() ?? '';
  const backdropName = backdrop?.trim() ?? '';
  if (!collection.trim() || !modelName || !backdropName) return null;
  if (isBackdropEnabledForAnalysis(backdropName)) return null;
  const key = styleComboKey(collection, modelName, backdropName);
  return listStyleCombos().find(
    (row) => styleComboKey(row.collection, row.model, row.backdrop) === key,
  ) ?? null;
}

export function saveStyleCombos(combos: StyleCombo[]): StyleCombo[] {
  const prev = loadParseConfig();
  const styleCombos = parseStyleCombos(combos);
  writeParseConfig({ ...prev, styleCombos });
  return styleCombos;
}

function parseBandRange(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  const min = Number(value[0]);
  const max = Number(value[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
    return fallback;
  }
  return [min, max];
}

function parseShiftFactor(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function parseCount(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseBackdropAdjustment(value: unknown): BackdropAdjustmentConfig | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {
    lowVolume?: Record<string, unknown>;
    midVolume?: Record<string, unknown>;
    highVolume?: Record<string, unknown>;
  };
  const d = DEFAULT_BACKDROP_ADJUSTMENT;
  const low = raw.lowVolume ?? {};
  const mid = raw.midVolume ?? {};
  const high = raw.highVolume ?? {};
  return {
    lowVolume: {
      maxSales30: parseCount(low.maxSales30, d.lowVolume.maxSales30),
      minSales7: parseCount(low.minSales7, d.lowVolume.minSales7),
      range: parseBandRange(low.range, d.lowVolume.range),
      shiftFactor: parseShiftFactor(low.shiftFactor, d.lowVolume.shiftFactor),
    },
    midVolume: {
      maxSales30: parseCount(mid.maxSales30, d.midVolume.maxSales30),
      minSales7: parseCount(mid.minSales7, d.midVolume.minSales7),
      range: parseBandRange(mid.range, d.midVolume.range),
      shiftFactor: parseShiftFactor(mid.shiftFactor, d.midVolume.shiftFactor),
    },
    highVolume: {
      minSales30: parseCount(high.minSales30, d.highVolume.minSales30),
      minSales7: parseCount(high.minSales7, d.highVolume.minSales7),
      range: parseBandRange(high.range, d.highVolume.range),
      shiftFactor: parseShiftFactor(high.shiftFactor, d.highVolume.shiftFactor),
    },
  };
}

export function getBackdropAdjustmentConfig(): BackdropAdjustmentConfig {
  return loadParseConfig().backdropAdjustment ?? DEFAULT_BACKDROP_ADJUSTMENT;
}

export function getBullishMarginPremium(): number {
  const cfg = loadParseConfig();
  return cfg.bullishMarginPremium ?? DEFAULT_BULLISH_MARGIN_PREMIUM;
}

export function loadParseConfig(): ParseConfig {
  if (!existsSync(PARSE_CONFIG_FILE)) return emptyConfig();
  try {
    const raw = JSON.parse(readFileSync(PARSE_CONFIG_FILE, 'utf-8')) as ParseConfig;
    return normalizeConfig(raw);
  } catch {
    return emptyConfig();
  }
}

function writeParseConfig(cfg: ParseConfig): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    PARSE_CONFIG_FILE,
    JSON.stringify(
      { ...cfg, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
    'utf-8',
  );
}

export interface SaveParseConfigInput {
  enabledCollections: string[];
  historyFetchBackdrops?: boolean;
  parserDelayMs?: number | null;
  parserFeedPages?: number | null;
  parserHistoryRoundMs?: number | null;
  salingScannerEnabled?: boolean;
  feeRate?: number | null;
  buyMinDiscount?: number | null;
  buyMinMargin?: number | null;
  watchMinDiscount?: number | null;
}

export function saveParseConfig(input: SaveParseConfigInput): void {
  const prev = loadParseConfig();
  const unique = [
    ...new Set(input.enabledCollections.map((s) => s.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'ru'));
  const next: ParseConfig = {
    ...prev,
    enabledCollections: unique,
    historyFetchBackdrops:
      input.historyFetchBackdrops ?? prev.historyFetchBackdrops,
  };
  if (input.parserDelayMs !== undefined) {
    next.parserDelayMs =
      input.parserDelayMs === null
        ? null
        : parseOptionalPositiveInt(input.parserDelayMs, 50, 60_000);
  }
  if (input.parserFeedPages !== undefined) {
    next.parserFeedPages =
      input.parserFeedPages === null
        ? null
        : parseOptionalPositiveInt(input.parserFeedPages, 1, 50);
  }
  if (input.parserHistoryRoundMs !== undefined) {
    next.parserHistoryRoundMs =
      input.parserHistoryRoundMs === null
        ? null
        : parseOptionalPositiveInt(input.parserHistoryRoundMs, 0, 3_600_000);
  }
  if (input.salingScannerEnabled !== undefined) {
    next.salingScannerEnabled = Boolean(input.salingScannerEnabled);
  }
  if (input.feeRate !== undefined) {
    next.feeRate =
      input.feeRate === null
        ? null
        : parseFeeRateConfig(input.feeRate);
  }
  if (input.buyMinDiscount !== undefined) {
    next.buyMinDiscount =
      input.buyMinDiscount === null
        ? null
        : parseThresholdFraction(input.buyMinDiscount);
  }
  if (input.buyMinMargin !== undefined) {
    next.buyMinMargin =
      input.buyMinMargin === null
        ? null
        : parseThresholdFraction(input.buyMinMargin);
  }
  if (input.watchMinDiscount !== undefined) {
    next.watchMinDiscount =
      input.watchMinDiscount === null
        ? null
        : parseThresholdFraction(input.watchMinDiscount);
  }
  writeParseConfig(next);
}

export function isCollectionEnabledForParse(collectionName: string): boolean {
  const cfg = loadParseConfig();
  if (cfg.enabledCollections === null) return true;
  return cfg.enabledCollections.includes(collectionName);
}

export function isHistoryFetchBackdropsEnabled(): boolean {
  return loadParseConfig().historyFetchBackdrops;
}

export function countEnabledForParse(catalogCollectionNames: string[]): {
  enabled: number;
  total: number;
  parseAll: boolean;
} {
  const cfg = loadParseConfig();
  const total = catalogCollectionNames.length;
  if (cfg.enabledCollections === null) {
    return { enabled: total, total, parseAll: true };
  }
  const set = new Set(cfg.enabledCollections);
  const enabled = catalogCollectionNames.filter((n) => set.has(n)).length;
  return { enabled, total, parseAll: false };
}
