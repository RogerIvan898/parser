import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gp-plain-bg-')), 't.db');

const { analyzeLot } = await import('./analytics.js');
const { db } = await import('./index.js');
const { NANO } = await import('../types.js');

const insert = db.prepare(
  `INSERT INTO sales (id, collection_name, model_name, backdrop_name, amount_nano, ts)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

function addSale(
  collection: string,
  model: string,
  backdrop: string,
  ton: number,
  ts: number,
  id: string,
): void {
  insert.run(id, collection, model, backdrop, Math.round(ton * NANO), ts);
}

test('обычный фон не поднимает model SKIP до collection BUY', () => {
  const now = Math.floor(Date.now() / 1000);
  const collection = 'Spring Basket';
  const model = 'Bear Market';
  const backdrop = 'Hunter Green';
  let i = 0;
  for (let n = 0; n < 12; n++) {
    addSale(collection, model, backdrop, 5.4417, now - 5 * 86400, `bm7-${i++}`);
  }
  for (let n = 0; n < 6; n++) {
    addSale(collection, model, backdrop, 5.25, now - 86400, `bm3-${i++}`);
  }
  for (let n = 0; n < 20; n++) {
    addSale(collection, 'Other', '', 6.12, now - 2 * 86400, `coll-${i++}`);
  }

  const result = analyzeLot(collection, model, backdrop, 5.2122, 7, 0.02);
  assert.deepEqual(
    result.scopes.map((s) => s.scope).sort(),
    ['collection', 'model'],
  );

  const modelSlice = result.scopes.find((s) => s.scope === 'model');
  const collectionSlice = result.scopes.find((s) => s.scope === 'collection');
  assert.ok(modelSlice);
  assert.ok(collectionSlice);
  assert.equal(modelSlice.verdict.metrics.trendAdjusted, true);
  assert.equal(modelSlice.verdict.metrics.trendStatus, 'bearish');
  assert.ok(Math.abs(modelSlice.verdict.metrics.referencePrice - 5.25) < 0.02);
  assert.equal(modelSlice.verdict.action, 'skip');
  assert.equal(collectionSlice.verdict.action, 'buy');
  assert.ok(result.primary);
  assert.equal(result.primary.scope, 'model');
  assert.equal(result.primary.action, 'skip');
});

test('collection BUY не повышает model WATCH', () => {
  const now = Math.floor(Date.now() / 1000);
  const collection = 'Watch Basket';
  const model = 'Plain';
  let i = 0;
  for (let n = 0; n < 15; n++) {
    addSale(collection, model, 'Azure', 5.44, now - 4 * 86400, `w-${i++}`);
  }
  for (let n = 0; n < 30; n++) {
    addSale(collection, 'Other', '', 6.12, now - 2 * 86400, `wc-${i++}`);
  }

  const result = analyzeLot(collection, model, 'Azure', 5.15, 7, 0.02);
  const modelSlice = result.scopes.find((s) => s.scope === 'model');
  const collectionSlice = result.scopes.find((s) => s.scope === 'collection');
  assert.equal(modelSlice?.verdict.action, 'watch');
  assert.equal(collectionSlice?.verdict.action, 'buy');
  assert.equal(result.primary?.scope, 'model');
  assert.equal(result.primary?.action, 'watch');
});

test('Black по-прежнему считает срезы с фоном', () => {
  const result = analyzeLot('Prem Coll', 'M', 'Black', 1, 7, 0.02);
  assert.ok(result.scopes.some((s) => s.scope === 'collection+backdrop'));
  assert.ok(result.scopes.some((s) => s.scope === 'model+backdrop'));
});
