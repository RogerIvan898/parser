import { TelegramClient } from '@mtcute/node';
import { input } from '@inquirer/prompts';
import { resolve } from 'node:path';
import {
  getTelegramCredentials,
  loadConfig,
  saveConfig,
} from './config.js';

const SESSION_FILE = resolve(process.cwd(), 'tg.session');

let client: TelegramClient | null = null;

function extractInitDataFromWebViewUrl(url: string): string {
  const match = url.match(/tgWebAppData=([^&#]+)/);
  if (!match) {
    throw new Error('[tg] в URL webview нет tgWebAppData: ' + url.slice(0, 120));
  }
  return decodeURIComponent(match[1]);
}

async function ensureTelegramCredentialsInConfig(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.telegram?.apiId && cfg.telegram?.apiHash) return;

  console.log('[tg] Нужны API ID и API Hash с https://my.telegram.org/apps');
  const apiIdRaw = await input({
    message: 'API ID:',
    default: process.env.TG_API_ID ?? '',
  });
  const apiHash = await input({
    message: 'API Hash:',
    default: process.env.TG_API_HASH ?? '',
  });
  const apiId = Number(apiIdRaw);
  if (!apiId || !apiHash.trim()) {
    throw new Error('[tg] некорректные API ID / API Hash');
  }

  saveConfig({
    telegram: { apiId, apiHash: apiHash.trim() },
  });
  console.log('[tg] учётные данные Telegram сохранены в config.json');
}

export async function getTgClient(): Promise<TelegramClient> {
  if (client) return client;

  await ensureTelegramCredentialsInConfig();
  const { apiId, apiHash } = getTelegramCredentials();

  client = new TelegramClient({
    apiId,
    apiHash,
    storage: SESSION_FILE,
  });

  const cfg = loadConfig();
  let phone = cfg.telegram?.phone?.trim();

  await client.start({
    phone: async () => {
      if (phone) return phone;
      phone = (await input({ message: 'Номер телефона (+7...):' })).trim();
      saveConfig({ telegram: { phone } });
      return phone;
    },
    code: async () => await input({ message: 'Код из Telegram:' }),
    password: async () =>
      await input({ message: 'Пароль 2FA (если есть, иначе Enter):' }),
  });

  console.log('[tg] сессия:', SESSION_FILE);
  return client;
}

/**
 * Запрашивает initData у бота @mrkt через RequestAppWebView.
 */
export async function fetchInitData(): Promise<string> {
  const tg = await getTgClient();

  const webView = await tg.openWebview({
    bot: 'mrkt',
    webview: {
      type: 'from_link',
      shortName: 'app',
      fireAndForget: true,
    },
    platform: 'android',
  });

  return extractInitDataFromWebViewUrl(webView.url);
}

export async function closeTg(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
  }
}
