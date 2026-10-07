import 'dotenv/config';
import { initClient } from './client.js';
import { runSalingScannerLoop } from './saling-scanner.js';

console.log('[saling-worker] отдельный поток: history его не останавливает');

try {
  await initClient();
  await runSalingScannerLoop();
} catch (err) {
  console.error('[saling-worker] остановка:', err);
  throw err;
}
