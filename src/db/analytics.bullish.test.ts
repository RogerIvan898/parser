import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gp-bull-')), 't.db');

const { analyzeLot } = await import('./analytics.js');
const { db } = await import('./index.js');
const { NANO } = await import('../types.js');

test('рост 3д: лот 120 при медиане 7д 100 и 3д 150 становится buy', () => {
  const now = Math.floor(Date.now() / 1000);
  const collection = 'Bullish Basket';
  const model = 'Bear Market';
  const insert = db.prepare(
    `INSERT INTO sales (id, collection_name, model_name, backdrop_name, amount_nano, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let i = 0;
  const add = (name: string, ton: number, ts: number) => {
    insert.run(
      `${collection}-${i++}`,
      collection,
      name,
      '',
      Math.round(ton * NANO),
      ts,
    );
  };

  for (let n = 0; n < 20; n++) add(model, 100, now - 5 * 86400);
  for (let n = 0; n < 8; n++) add(model, 150, now - 86400);
  for (let n = 0; n < 40; n++) add('Other', 100, now - 2 * 86400);

  const result = analyzeLot(collection, model, null, 120, 7, 0.02);
  const modelSlice = result.scopes.find((s) => s.scope === 'model');
  assert.ok(modelSlice);
  assert.equal(modelSlice.verdict.metrics.trendStatus, 'bullish');
  assert.equal(modelSlice.verdict.metrics.trendAdjusted, false);
  assert.equal(modelSlice.verdict.metrics.bullishDiscountApplied, true);
  assert.ok(Math.abs((modelSlice.verdict.metrics.median7 ?? 0) - 100) < 0.01);
  assert.ok(Math.abs((modelSlice.verdict.metrics.rawMedian3 ?? 0) - 150) < 0.01);
  assert.ok(Math.abs(modelSlice.verdict.metrics.referencePrice - 135) < 0.01);
  assert.equal(modelSlice.verdict.action, 'buy');
  assert.equal(modelSlice.verdict.metrics.trendView?.status, 'bullish');
  assert.ok(Math.abs((modelSlice.verdict.metrics.trendView?.referenceUsed ?? 0) - 135) < 0.01);

  assert.ok(result.primary);
  assert.equal(result.primary.scope, 'model');
  assert.equal(result.primary.action, 'buy');
  assert.equal(result.primary.metrics.trendStatus, 'bullish');
});
