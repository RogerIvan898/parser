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
  };
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
