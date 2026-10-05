import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_FILE = resolve(process.cwd(), 'config.json');

export interface AppConfig {
  /** Токен MRKT (альтернатива MRKT_AUTH в .env) */
  mrktAuth?: string;
  telegram?: {
    apiId?: number;
    apiHash?: string;
    /** Сохраняется после первого ввода */
    phone?: string;
  };
}

const defaultConfig: AppConfig = {};

export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_FILE)) return { ...defaultConfig };
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return { ...defaultConfig, ...(JSON.parse(raw) as AppConfig) };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveConfig(patch: Partial<AppConfig>): void {
  const current = loadConfig();
  const next: AppConfig = {
    ...current,
    ...patch,
    telegram: {
      ...current.telegram,
      ...patch.telegram,
    },
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
}

export function getTelegramCredentials(): { apiId: number; apiHash: string } {
  const cfg = loadConfig();
  const apiId =
    cfg.telegram?.apiId ??
    (Number(process.env.TG_API_ID) || 0);
  const apiHash =
    cfg.telegram?.apiHash?.trim() ??
    process.env.TG_API_HASH?.trim() ??
    '';

  if (!apiId || !apiHash) {
    throw new Error(
      'Задай telegram.apiId и telegram.apiHash в config.json ' +
        '(см. config.example.json) или TG_API_ID / TG_API_HASH в .env',
    );
  }

  return { apiId, apiHash };
}

export function getMrktAuthFromConfig(): string | null {
  const token = loadConfig().mrktAuth?.trim();
  return token || null;
}
