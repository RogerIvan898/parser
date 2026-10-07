import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

type ProbeResult = {
  ok: boolean;
  signal: NodeJS.Signals | null;
  detail: string;
};

/** Открытие в отдельном процессе: падение better-sqlite3 не роняет сервер. */
function probeDatabase(file: string): ProbeResult {
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { timeout: 3000 });
    db.pragma('journal_mode = DELETE');
    db.exec('select 1');
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', script, file], {
    cwd: process.cwd(),
    timeout: 8000,
    encoding: 'utf8',
  });
  if (result.status === 0) return { ok: true, signal: null, detail: '' };
  const detail = [
    result.signal ? `signal ${result.signal}` : `exit ${result.status}`,
    result.stderr?.trim(),
    result.stdout?.trim(),
    result.error?.message,
  ]
    .filter((part) => part && part.length > 0)
    .join(' | ');
  return { ok: false, signal: result.signal, detail };
}

function sideline(path: string): void {
  if (!existsSync(path)) return;
  const dest = `${path}.aside-${Date.now()}`;
  renameSync(path, dest);
  dbLog(`убрал в сторону ${path} → ${dest}`);
}

/**
 * Повторный старт на Bothost обрывается внутри new Database(), без JS-ошибки.
 * Так бывает, когда sqlite при открытии подхватывает битый -wal/-shm на томе.
 */
function prepareDatabaseFile(): void {
  sideline(`${DB_FILE}-wal`);
  sideline(`${DB_FILE}-shm`);
  if (!existsSync(DB_FILE)) return;

  const probe = probeDatabase(DB_FILE);
  if (probe.ok) {
    dbLog('проба базы успешна');
    return;
  }

  dbLog(`проба ${DB_FILE} не удалась: ${probe.detail}`);
  if (probe.signal === 'SIGKILL') {
    const mem = process.memoryUsage();
    throw new Error(
      `sqlite-проба убита SIGKILL (rss ${Math.round(mem.rss / 1024 / 1024)} МиБ). ` +
        'Похоже на нехватку памяти контейнера, файл базы не трогал.',
    );
  }

  const empty = resolve(tmpdir(), 'mrkt-open-probe.db');
  sideline(empty);
  const emptyProbe = probeDatabase(empty);
  try {
    if (existsSync(empty)) renameSync(empty, `${empty}.aside-${Date.now()}`);
  } catch {
    /* временный файл не важен */
  }
  if (!emptyProbe.ok) {
    throw new Error(
      `better-sqlite3 не открывает даже пустую базу: ${emptyProbe.detail}`,
    );
  }

  sideline(DB_FILE);
  dbLog('старая база повреждена или роняет процесс, создаю новую');
}

mkdirSync(dirname(DB_FILE), { recursive: true });
prepareDatabaseFile();

const mem = process.memoryUsage();
dbLog(
  `открываю ${DB_FILE} rss=${Math.round(mem.rss / 1024 / 1024)}MiB`,
);

export const db = new Database(DB_FILE, { timeout: 5000 });
db.pragma('journal_mode = DELETE');
db.pragma('foreign_keys = ON');

function tableExists(name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) as { x: number } | undefined;
  return row != null;
}

function salesColumns(): string[] {
  if (!tableExists('sales')) return [];
  return (
    db.prepare('PRAGMA table_info(sales)').all() as { name: string }[]
  ).map((c) => c.name);
}

const SALES_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sales_coll_model_ts
  ON sales(collection_name, model_name, ts);
CREATE INDEX IF NOT EXISTS idx_sales_coll_model_backdrop_ts
  ON sales(collection_name, model_name, backdrop_name, ts);
CREATE INDEX IF NOT EXISTS idx_sales_collection_ts
  ON sales(collection_name, ts);
`;

/**
 * Старые sales хранили весь подарок в raw_json. Аналитика читает только
 * коллекцию, модель, фон, цену и время — переписываем таблицу и отдаём место диску.
 */
function slimSalesTable(): void {
  const cols = salesColumns();
  if (!cols.includes('raw_json')) return;

  dbLog('сжимаю sales: оставляю коллекцию, модель, фон, цену и время');
  db.pragma('foreign_keys = OFF');
  const slim = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS sales_slim');
    db.exec(`
      CREATE TABLE sales_slim (
        id TEXT PRIMARY KEY,
        collection_name TEXT NOT NULL,
        model_name TEXT NOT NULL,
        backdrop_name TEXT NOT NULL DEFAULT '',
        amount_nano INTEGER NOT NULL,
        ts INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO sales_slim (
        id, collection_name, model_name, backdrop_name, amount_nano, ts
      )
      SELECT id, collection_name, model_name, backdrop_name, amount_nano, ts
      FROM sales
    `);
    db.exec('DROP TABLE sales');
    db.exec('ALTER TABLE sales_slim RENAME TO sales');
    db.exec(SALES_INDEXES);
  });
  slim();
  db.pragma('foreign_keys = ON');
}

if (!tableExists('sales') && tableExists('sales_slim')) {
  db.exec('ALTER TABLE sales_slim RENAME TO sales');
  db.exec(SALES_INDEXES);
  dbLog('дособрал sales после оборванного сжатия');
}

db.exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf8'));
slimSalesTable();
if (tableExists('sales')) {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const removed = db
    .prepare('DELETE FROM sales WHERE ts > 0 AND ts < ?')
    .run(cutoff);
  if (removed.changes > 0) {
    dbLog(`sales старше 30д по дате сделки: −${removed.changes}`);
  }
}
const freePages = db.pragma('freelist_count', { simple: true }) as number;
if (freePages >= 1000) {
  db.pragma('cache_size = -8000');
  dbLog(`vacuum mrkt.db: свободно ${freePages} страниц`);
  db.exec('VACUUM');
  dbLog('sales сжата');
}
dbLog('схема применена');
