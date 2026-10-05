import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DATABASE_PATH ?? resolve(DATA_DIR, 'mrkt.db');

mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf8'));
