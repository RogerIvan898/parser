import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BACKDROP_ADJUSTMENT } from '../parse-config.js';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gp-ratio-')), 't.db');

const { selectBackdropTier, softClampRatio } = await import('./analytics.js');

test('soft clamp затухает за верхней границей, а не обрезает ступенькой', () => {
  const raw = 1.5;
  const clamped = softClampRatio(raw, 0.8, 1.2);
  const expected = 1.2 + Math.log(1 + (1.5 - 1.2));
  assert.ok(Math.abs(clamped - expected) < 1e-9);
  assert.ok(clamped > 1.2);
  assert.ok(clamped < raw);
});

test('soft clamp затухает ниже нижней границы', () => {
  const clamped = softClampRatio(0.5, 0.8, 1.2);
  const expected = 0.8 - Math.log(1 + (0.8 - 0.5));
  assert.ok(Math.abs(clamped - expected) < 1e-9);
  assert.ok(clamped < 0.8);
  assert.ok(clamped > 0.5);
});

test('внутри коридора ratio не меняется', () => {
  assert.equal(softClampRatio(1.1, 0.8, 1.2), 1.1);
});

test('объём 30д/7д выбирает коридор', () => {
  const cfg = DEFAULT_BACKDROP_ADJUSTMENT;
  assert.equal(selectBackdropTier(2, 40, cfg).id, 'low');
  assert.equal(selectBackdropTier(10, 10, cfg).id, 'low');
  assert.deepEqual(selectBackdropTier(10, 10, cfg).shiftFactor, 0.5);

  const mid = selectBackdropTier(5, 20, cfg);
  assert.equal(mid.id, 'mid');
  assert.deepEqual([mid.min, mid.max], [0.65, 1.4]);
  assert.equal(mid.shiftFactor, 0.75);

  const gap = selectBackdropTier(5, 40, cfg);
  assert.equal(gap.id, 'mid');

  const high = selectBackdropTier(8, 40, cfg);
  assert.equal(high.id, 'high');
  assert.deepEqual([high.min, high.max], [0.5, 2]);
  assert.equal(high.shiftFactor, 1);
});
