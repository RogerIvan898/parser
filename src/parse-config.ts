import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './store.js';

export const PARSE_CONFIG_FILE = resolve(DATA_DIR, 'parse-config.json');

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
}

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
  };
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
}

export function saveParseConfig(input: SaveParseConfigInput): void {
  const prev = loadParseConfig();
  const unique = [
    ...new Set(input.enabledCollections.map((s) => s.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'ru'));
  writeParseConfig({
    ...prev,
    enabledCollections: unique,
    historyFetchBackdrops:
      input.historyFetchBackdrops ?? prev.historyFetchBackdrops,
  });
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
