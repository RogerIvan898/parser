import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './store.js';

export const HISTORY_PROGRESS_FILE = resolve(DATA_DIR, 'history-progress.json');

/** Следующая пара коллекция+модель, с которой надо продолжить круг. */
export interface HistoryProgress {
  version: 1;
  round: number;
  collectionName: string;
  modelName: string;
  updatedAt: string;
}

export function loadHistoryProgress(): HistoryProgress | null {
  if (!existsSync(HISTORY_PROGRESS_FILE)) return null;
  try {
    const raw = JSON.parse(
      readFileSync(HISTORY_PROGRESS_FILE, 'utf-8'),
    ) as Partial<HistoryProgress>;
    if (raw.version !== 1) return null;
    if (typeof raw.round !== 'number' || !Number.isFinite(raw.round) || raw.round < 1) {
      return null;
    }
    if (
      typeof raw.collectionName !== 'string' ||
      raw.collectionName.trim() === '' ||
      typeof raw.modelName !== 'string' ||
      raw.modelName.trim() === ''
    ) {
      return null;
    }
    return {
      version: 1,
      round: Math.floor(raw.round),
      collectionName: raw.collectionName,
      modelName: raw.modelName,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function saveHistoryProgress(
  progress: Pick<HistoryProgress, 'round' | 'collectionName' | 'modelName'>,
): void {
  const payload: HistoryProgress = {
    version: 1,
    round: progress.round,
    collectionName: progress.collectionName,
    modelName: progress.modelName,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(HISTORY_PROGRESS_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

export interface HistoryTask {
  collectionName: string;
  modelName: string;
}

/**
 * Индекс задачи, с которой продолжать.
 * Если пары уже нет в каталоге — первая пара, которая идёт после неё в том же порядке (A→Z).
 * Если после неё ничего нет, круг по сохранённой очереди закончен: 0.
 */
export function findResumeIndex(
  tasks: readonly HistoryTask[],
  progress: Pick<HistoryProgress, 'collectionName' | 'modelName'>,
): number {
  const exact = tasks.findIndex(
    (t) =>
      t.collectionName === progress.collectionName &&
      t.modelName === progress.modelName,
  );
  if (exact >= 0) return exact;

  const after = tasks.findIndex((t) => {
    if (t.collectionName > progress.collectionName) return true;
    if (t.collectionName < progress.collectionName) return false;
    return t.modelName > progress.modelName;
  });
  return after >= 0 ? after : 0;
}
