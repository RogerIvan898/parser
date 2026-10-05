/**
 * Первая команда контейнера. Пишет на диск до загрузки сервера:
 * панель Bothost при мгновенном падении часто показывает «Логи пусты».
 */
import { appendFileSync, existsSync, mkdirSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const logFile = '/app/data/boot.log';

function log(line) {
  const text = `${line}\n`;
  try {
    writeSync(1, text);
  } catch {
    /* stdout может быть закрыт */
  }
  try {
    writeSync(2, text);
  } catch {
    /* stderr */
  }
  try {
    mkdirSync('/app/data', { recursive: true });
    appendFileSync(logFile, text);
  } catch (err) {
    try {
      writeSync(2, `[boot] не записал ${logFile}: ${err}\n`);
    } catch {
      /* ignore */
    }
  }
}

log(`[boot] ${new Date().toISOString()} node ${process.version} pid ${process.pid}`);
log(`[boot] cwd=${process.cwd()} PORT=${process.env.PORT ?? ''} DATA_DIR=${process.env.DATA_DIR ?? ''}`);

const candidates = [
  resolve(here, 'dist', 'server.js'),
  '/usr/src/app/dist/server.js',
];
const entry = candidates.find((path) => existsSync(path));

if (!entry) {
  log(`[boot] нет dist/server.js. Искал: ${candidates.join(', ')}`);
  process.exit(1);
}

log(`[boot] entry ${entry}`);

try {
  await import(pathToFileURL(entry).href);
  log('[boot] сервер загружен, процесс держит порт');
} catch (err) {
  const text = err instanceof Error ? (err.stack || err.message) : String(err);
  log(`[boot] fatal:\n${text}`);
  process.exit(1);
}
