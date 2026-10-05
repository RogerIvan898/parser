import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuthRequest, AuthResponse } from './types.js';
import { getMrktAuthFromConfig } from './config.js';

const BASE_URL = 'https://api.tgmrkt.io';
const AUTH_FILE = resolve(process.cwd(), 'auth.json');
const ENV_FILE = resolve(process.cwd(), '.env');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// Payload для /api/v1/auth
// ============================================================

/**
 * Собирает AuthRequest из initData и опционального фото.
 *
 * initData — это строка, которую отдаёт Telegram.WebApp.initData.
 * Внутри неё уже есть query_id, user, auth_date, hash и signature.
 */
export function buildAuthRequest(
  initData: string,
  photo: string | null = null,
  appId: string | null = null,
): AuthRequest {
  return {
    data: initData,
    photo,
    appId,
  };
}

// ============================================================
// POST /api/v1/auth
// ============================================================

export async function authenticate(
  initData: string,
  photo: string | null = null,
  appId: string | null = null,
): Promise<AuthResponse> {
  const body = buildAuthRequest(initData, photo, appId);

  const res = await fetch(`${BASE_URL}/api/v1/auth`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'accept-language': 'ru,en;q=0.9',
      'content-type': 'application/json',
      origin: 'https://cdn.tgmrkt.io',
      referer: 'https://cdn.tgmrkt.io/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      // cookie: access_token= — пустой, как в браузере до логина
      cookie: 'access_token=',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `[auth] HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as AuthResponse;

  if (!json.token) {
    throw new Error('[auth] в ответе нет поля token');
  }

  return json;
}

// ============================================================
// Сохранение / загрузка токена
// ============================================================

interface SavedAuth {
  token: string;
  savedAt: string;
}

export function saveToken(token: string): void {
  const data: SavedAuth = {
    token,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[auth] токен сохранён в ${AUTH_FILE}`);
}

export function loadToken(): string | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    const raw = readFileSync(AUTH_FILE, 'utf-8');
    const data = JSON.parse(raw) as SavedAuth;
    if (!data.token) return null;
    if (data.savedAt) {
      const age = Date.now() - new Date(data.savedAt).getTime();
      if (age > TOKEN_TTL_MS) {
        console.log('[auth] токен в auth.json старше 30 дней — обновим');
        return null;
      }
    }
    return data.token;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  if (existsSync(AUTH_FILE)) {
    writeFileSync(AUTH_FILE, '{}', 'utf-8');
    console.log('[auth] токен удалён');
  }
}

// ============================================================
// Главная функция: получить рабочий токен
// ============================================================

/**
 * Логика:
 * 1. MRKT_AUTH из .env или config.json
 * 2. auth.json (токен, не старше 30 дней)
 * 3. TG_INIT_DATA из .env (ручной initData)
 * 4. Telegram-клиент → initData → /auth
 */
export async function ensureToken(): Promise<string> {
  const envToken = process.env.MRKT_AUTH?.trim();
  if (envToken) {
    console.log('[auth] используем MRKT_AUTH из .env');
    return envToken;
  }

  const configToken = getMrktAuthFromConfig();
  if (configToken) {
    console.log('[auth] используем mrktAuth из config.json');
    return configToken;
  }

  const saved = loadToken();
  if (saved) {
    console.log('[auth] используем сохранённый токен из auth.json');
    return saved;
  }

  const initData = process.env.TG_INIT_DATA?.trim();
  if (initData) {
    console.log('[auth] логинимся через TG_INIT_DATA...');
    const res = await authenticate(initData);
    saveToken(res.token);
    return res.token;
  }

  const useTelegram =
    process.env.MRKT_USE_TELEGRAM === '1' ||
    process.env.MRKT_USE_TELEGRAM === 'true';

  if (!useTelegram) {
    throw new Error(
      '[auth] нет токена MRKT.\n' +
        `  1) Создай файл ${ENV_FILE}\n` +
        '  2) Добавь строку: MRKT_AUTH=твой_токен\n' +
        '     (из MRKT: DevTools → Network → api.tgmrkt.io → ' +
        'authorization или cookie access_token)\n' +
        '  Либо положи mrktAuth в config.json, или MRKT_USE_TELEGRAM=1 для входа через Telegram.',
    );
  }

  console.log('[auth] логинимся через Telegram-клиент...');
  const { fetchInitData, closeTg } = await import('./tg.js');
  const tgInitData = await fetchInitData();
  const res = await authenticate(tgInitData);
  saveToken(res.token);
  await closeTg();

  return res.token;
}

// ============================================================
// Утилита: разобрать initData на поля
// ============================================================

export interface ParsedInitData {
  queryId: string | null;
  authDate: number | null;
  hash: string | null;
  signature: string | null;
  user: {
    id: number;
    first_name: string;
    last_name: string;
    username: string;
    language_code: string;
    allows_write_to_pm: boolean;
    photo_url: string;
  } | null;
}

export function parseInitData(initData: string): ParsedInitData {
  const params = new URLSearchParams(initData);

  const userRaw = params.get('user');
  let user: ParsedInitData['user'] = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      user = null;
    }
  }

  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : null;

  return {
    queryId: params.get('query_id'),
    authDate,
    hash: params.get('hash'),
    signature: params.get('signature'),
    user,
  };
}