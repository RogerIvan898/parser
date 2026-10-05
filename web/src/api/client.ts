import axios from 'axios';
import { useSettings } from '@/store/settings';

export const api = axios.create({
  timeout: 15_000,
});

// Каждый раз подставляем актуальный apiBase из стора
api.interceptors.request.use((config) => {
  const base = useSettings.getState().apiBase || '/api';
  config.baseURL = base;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg =
      err.response?.data?.error ||
      err.message ||
      'Неизвестная ошибка';
    return Promise.reject(new Error(msg));
  },
);

export async function checkHealth(): Promise<{ ok: boolean }> {
  const { data } = await api.get('/health');
  return data;
}

export interface CatalogBackdrop {
  collectionName: string;
  backdropName: string;
  colorsCenterColor: number;
  colorsEdgeColor: number;
  rarityPerMille: number;
  rarityName: string | null;
  floorNanoTons: number;
}

export interface CatalogResponse {
  collections: string[];
  models: Record<string, string[]>;
  collectionThumbnails: Record<string, string>;
  modelThumbnails: Record<string, Record<string, string>>;
  backdrops: Record<string, CatalogBackdrop[]>;
  /** true, если каталог пуст и bootstrap с MRKT не сработал */
  needsMrktAuth?: boolean;
}

export async function getCatalog(): Promise<CatalogResponse> {
  const { data } = await api.get('/catalog');
  
  return {
    collections: data.collections ?? [],
    models: data.models ?? {},
    collectionThumbnails: data.collectionThumbnails ?? {},
    modelThumbnails: data.modelThumbnails ?? {},
    backdrops: data.backdrops ?? {},
    needsMrktAuth: data.needsMrktAuth === true,
  };
}

export async function getStats(
  collection: string,
  model: string,
  backdrop: string | null,
  days: number,
) {
  const path = backdrop ? '/stats/backdrop' : '/stats';
  const params: Record<string, unknown> = { collection, model, days };
  if (backdrop) params.backdrop = backdrop;
  const { data } = await api.get(path, { params });
  return data;
}

export async function getHistory(
  collection: string,
  days: number,
  model?: string | null,
) {
  const params: Record<string, unknown> = { collection, days };
  if (model) params.model = model;
  const { data } = await api.get('/history', { params });
  return data;
}

export async function evaluateListing(payload: {
  collection: string;
  model: string;
  backdrop?: string | null;
  price: number;
  days?: number;
  feeRate?: number;
}) {
  const { data } = await api.post('/evaluate', payload);
  return data;
}

export interface ParserTimingResponse {
  delayMs: number;
  feedPages: number;
  historyRoundMs: number;
}

export interface ParseConfigResponse {
  collections: string[];
  /** null = парсить все (ещё не сохраняли выбор) */
  enabledCollections: string[] | null;
  historyFetchBackdrops: boolean;
  historyFeedBackdropNames: string[];
  parserDelayMs: number;
  parserFeedPages: number;
  parserHistoryRoundMs: number;
  parserEnvDefaults?: ParserTimingResponse;
  salingScannerEnabled: boolean;
  salingScannerTiming?: {
    modelDelayMs: number;
    intervalMs: number;
    jitterMs: number;
  };
  feeRate: number;
  defaultFeeRate?: number;
}

export async function getLiquidity(days: number) {
  const { data } = await api.get('/liquidity', { params: { days } });
  return data;
}

export async function getParseConfig(): Promise<ParseConfigResponse> {
  const { data } = await api.get('/parse-config');
  return {
    collections: data.collections ?? [],
    enabledCollections: data.enabledCollections ?? null,
    historyFetchBackdrops: data.historyFetchBackdrops !== false,
    historyFeedBackdropNames: data.historyFeedBackdropNames ?? [
      'Black',
      'Onyx Black',
    ],
    parserDelayMs: Number(data.parserDelayMs) || 400,
    parserFeedPages: Number(data.parserFeedPages) || 5,
    parserHistoryRoundMs: Number(data.parserHistoryRoundMs) || 1200,
    parserEnvDefaults: data.parserEnvDefaults,
    salingScannerEnabled: data.salingScannerEnabled === true,
    salingScannerTiming: data.salingScannerTiming,
    feeRate: Number(data.feeRate) || 0.02,
    defaultFeeRate: Number(data.defaultFeeRate) || 0.02,
  };
}

export async function saveParseConfig(payload: {
  enabledCollections: string[];
  historyFetchBackdrops: boolean;
  parserDelayMs?: number;
  parserFeedPages?: number;
  parserHistoryRoundMs?: number;
  salingScannerEnabled?: boolean;
  feeRate?: number;
}) {
  const { data } = await api.put('/parse-config', payload);
  return data;
}

export async function decide(payload: {
  collection: string;
  model?: string | null;
  backdrop?: string | null;
  price: number;
  days?: number;
  feeRate?: number;
}) {
  const { data } = await api.post('/decide', payload);
  return data;
}
