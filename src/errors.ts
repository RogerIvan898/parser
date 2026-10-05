import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './store.js';

export type ParseErrorPhase =
  | 'collections'
  | 'models'
  | 'backdrops'
  | 'history'
  | 'io'
  | 'auth';

export interface ParseErrorRecord {
  at: string;
  phase: ParseErrorPhase;
  target: string;
  message: string;
}

const ERRORS_FILE = resolve(DATA_DIR, 'errors.json');

const records: ParseErrorRecord[] = [];

export function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function recordParseError(
  phase: ParseErrorPhase,
  target: string,
  err: unknown,
): void {
  const message = formatErr(err);
  records.push({
    at: new Date().toISOString(),
    phase,
    target,
    message,
  });
  console.error(`[error] [${phase}] ${target}: ${message}`);
}

export function getParseErrors(): readonly ParseErrorRecord[] {
  return records;
}

export function flushParseErrors(): void {
  if (records.length === 0) return;

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    ERRORS_FILE,
    JSON.stringify(
      {
        finishedAt: new Date().toISOString(),
        count: records.length,
        errors: records,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

export function printParseErrorSummary(): void {
  if (records.length === 0) {
    console.log('[parser] ошибок не было');
    return;
  }
  console.error(`\n[parser] итого ошибок: ${records.length} (см. data/errors.json)`);
}
