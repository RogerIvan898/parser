import Database from 'better-sqlite3';
import { appendFileSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DATABASE_PATH ?? resolve(DATA_DIR, 'mrkt.db');

function dbLog(line: string): void {
  const text = `[db] ${line}\n`;
  try {
    writeSync(1, text);
  } catch {
    /* ignore */
  }
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    appendFileSync(resolve(dirname(DB_FILE), 'boot.log'), text);
  } catch {
    /* ignore */
  }
}

mkdirSync(dirname(DB_FILE), { recursive: true });
dbLog(`открываю ${DB_FILE}`);

export const db = new Database(DB_FILE);
try {
  db.pragma('journal_mode = WAL');
} catch (err) {
  dbLog(`WAL недоступен, journal_mode=DELETE: ${err instanceof Error ? err.message : err}`);
  db.pragma('journal_mode = DELETE');
}
db.pragma('foreign_keys = ON');
db.exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf8'));
dbLog('схема применена');
