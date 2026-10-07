import { existsSync } from 'node:fs';
import { HISTORY_DB_FILE, openHistoryDb, pruneHistorySalesOlderThan } from '../history-db.js';
import { pruneSalesOlderThanHistory, SALE_HISTORY_DAYS } from './storage.js';

/** Как часто удалять сделки старше SALE_HISTORY_DAYS (по дате покупки). */
export const SALE_HISTORY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let retentionLoopStarted = false;

export function runSalesHistoryRetention(): { mrkt: number; history: number } {
  const mrkt = pruneSalesOlderThanHistory();
  let history = 0;
  if (existsSync(HISTORY_DB_FILE)) {
    const database = openHistoryDb();
    history = pruneHistorySalesOlderThan(database);
  }
  return { mrkt, history };
}

/** Первый проход сразу, дальше по интервалу. Повторный вызов не создаёт второй таймер. */
export function startSalesHistoryRetentionLoop(
  intervalMs = SALE_HISTORY_PRUNE_INTERVAL_MS,
): void {
  if (retentionLoopStarted) return;
  retentionLoopStarted = true;

  const tick = (): void => {
    try {
      const { mrkt, history } = runSalesHistoryRetention();
      if (mrkt > 0 || history > 0) {
        console.log(
          `[retention] продажи старше ${SALE_HISTORY_DAYS}д по дате сделки: ` +
            `mrkt.db −${mrkt}, history.db −${history}`,
        );
      }
    } catch (err) {
      console.error('[retention] ошибка очистки sales:', err);
    }
  };

  console.log(
    `[retention] автоочистка sales каждые ${Math.round(intervalMs / 3600_000)}ч ` +
      `(окно ${SALE_HISTORY_DAYS}д, дата покупки)`,
  );
  tick();
  setInterval(tick, intervalMs);
}
