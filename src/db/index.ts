import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE =
  process.env.DATABASE_PATH ?? resolve(process.cwd(), 'data', 'mrkt.db');

mkdirSync(resolve(process.cwd(), 'data'), { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf8'));
