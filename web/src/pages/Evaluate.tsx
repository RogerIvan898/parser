import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  analyzeLot,
  getParseConfig,
  type SalesVerdictThresholdsResponse,
} from '@/api/client';
import type { LotAnalysis } from '@/api/types';
import CollectionModelSelect from '@/components/CollectionModelSelect';
import BackdropSelect from '@/components/BackdropSelect';
import ErrorBox from '@/components/ErrorBox';
import { useCatalog } from '@/hooks/useCatalog';
import { useSettings } from '@/store/settings';

const SCOPE_LABEL: Record<string, string> = {
  collection: 'коллекция',
  model: 'модель',
  'model+backdrop': 'модель + фон',
  'collection+backdrop': 'коллекция + фон',
};

const EVIDENCE_LABEL: Record<string, string> = {
  reliable: '7д, надёжно',
  extended: '30д, расширенно',
  weak: 'слабо, не само решает',
  insufficient: 'мало данных',
};

function actionBadge(action: string) {
  if (action === 'buy') return { cls: 'green', text: 'БРАТЬ' };
  if (action === 'watch') return { cls: 'yellow', text: 'СМОТРЕТЬ' };
  if (action === 'insufficient') return { cls: 'gray', text: 'МАЛО ДАННЫХ' };
  return { cls: 'red', text: 'МИМО' };
}

export function Evaluate() {
  const { defaultFeeRate } = useSettings();
  const parseCfg = useQuery({
    queryKey: ['parse-config'],
    queryFn: getParseConfig,
  });
  const feeRate = parseCfg.data?.feeRate ?? defaultFeeRate;
  const catalog = useCatalog();
  const [collection, setCollection] = useState('');
  const [model, setModel] = useState('');
  const [backdrop, setBackdrop] = useState('');
  const [price, setPrice] = useState<number | ''>('');

  useEffect(() => {
    if (!catalog.data || collection) return;
    const c = catalog.data.collections[0];
    if (!c) return;
    setCollection(c);
    setModel(catalog.data.models[c]?.[0] ?? '');
  }, [catalog.data, collection]);

  useEffect(() => {
    setBackdrop('');
  }, [collection]);

  const mutation = useMutation<LotAnalysis, Error>({
    mutationFn: () =>
      analyzeLot({
        collection,
        model: model.trim() || null,
        backdrop: backdrop.trim() || null,
        price: Number(price),
        days: 7,
        feeRate,
      }),
  });

  const priceOk = typeof price === 'number' && price > 0;
  const backdropTrim = backdrop.trim();
  const backdropSlices =
    backdropTrim === 'Black' || backdropTrim === 'Onyx Black';

  return (
    <div>
      <h1>Оценка лота</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 0, maxWidth: 720 }}>
        Тот же разбор, что у сканера saling. Коллекция и модель считаются всегда,
        срезы по фону — для любого цвета. Премия фона к модели не зажата в
        0.80–1.20: коридор и доля сдвига зависят от продаж за 30 и 7 дней. При
        большом объёме и ≥10 продажах за 7д <b>модель+фон</b> задаёт цену. Для{' '}
        <b>Black</b> и <b>Onyx Black</b> по-прежнему: если у
        коллекции с этим фоном ≥10 продаж, вердикт берётся от фона и модель его не
        отменяет. Надёжный свежий рынок модели (3 дня) отменяет buy по всей коллекции.
        Окно 7 дней, при нехватке продаж на срезе смотрим 30. Если по продажам есть
        buy или watch, сервер сам запрашивает стакан{' '}
        <code>POST /gifts/saling</code> по коллекции, модели и фону и пересчитывает
        лот. Комиссия из настроек.
      </p>

      <div className="card">
        <div className="form-row">
          <CollectionModelSelect
            collection={collection}
            model={model}
            onCollectionChange={setCollection}
            onModelChange={setModel}
          />
          <BackdropSelect
            collection={collection}
            value={backdrop}
            onChange={setBackdrop}
            optional
          />
          <div className="form-field">
            <label>Цена (TON)</label>
            <input
              type="number"
              step="0.001"
              min={0}
              value={price}
              placeholder="0"
              onChange={(e) => {
                const v = e.target.value;
                setPrice(v === '' ? '' : Number(v));
              }}
            />
          </div>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !collection || !model.trim() || !priceOk}
          >
            {mutation.isPending ? '...' : 'Оценить'}
          </button>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '4px 0 0' }}>
          Срезы: коллекция, {model.trim() || 'модель'}
          {backdropTrim
            ? `, фон ${backdropTrim}${backdropSlices ? ' (премиальный)' : ''}`
            : ''}
          .
        </p>
      </div>

      {mutation.isError && <ErrorBox error={mutation.error} />}

      {mutation.data && (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 12,
              justifyContent: 'flex-end',
              marginBottom: 8,
            }}
          >
            <button
              type="button"
              onClick={() =>
                downloadLotAnalysisLog({
                  collection,
                  model: model.trim(),
                  backdrop: backdropTrim,
                  price: Number(price),
                  days: 7,
                  feeRate,
                  thresholds: parseCfg.data?.salesVerdictThresholds,
                  premiumBackdrops:
                    parseCfg.data?.historyFeedBackdropNames ?? [
                      'Black',
                      'Onyx Black',
                    ],
                  result: mutation.data,
                })
              }
            >
              Скачать лог анализа (JSON)
            </button>
          </div>
          <div className="card">
            {mutation.data.primary ? (
              <>
                <h2>
                  Вердикт:{' '}
                  <span
                    className={`badge ${actionBadge(mutation.data.primary.action).cls}`}
                  >
                    {actionBadge(mutation.data.primary.action).text}
                  </span>
                </h2>
                <p style={{ color: 'var(--text-dim)' }}>
                  {mutation.data.primary.reason}
                </p>
                <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  Основной срез:{' '}
                  {SCOPE_LABEL[mutation.data.primary.scope] ??
                    mutation.data.primary.scope}
                  {' · '}
                  {mutation.data.primary.evidence ?? '—'}
                  {' · уверенность '}
                  {mutation.data.primary.confidence}
                </p>
                {mutation.data.primary.notes.length > 0 && (
                  <ul style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                    {mutation.data.primary.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                <div className="card-row">
                  <Metric
                    label="Медиана продаж"
                    value={
                      mutation.data.primary.metrics.referencePrice
                        ? `${mutation.data.primary.metrics.referencePrice.toFixed(2)} TON`
                        : '—'
                    }
                  />
                  <Metric
                    label="К медиане"
                    value={`${(mutation.data.primary.metrics.discountVsMedian * 100).toFixed(1)}%`}
                  />
                  <Metric
                    label="Продаж в окне"
                    value={String(mutation.data.primary.metrics.samples)}
                  />
                  <Metric
                    label="Окно"
                    value={`${mutation.data.primary.metrics.windowDays ?? 7} д`}
                  />
                  <Metric
                    label="Маржа после комиссии"
                    value={`${(mutation.data.primary.metrics.netMargin * 100).toFixed(1)}%`}
                  />
                </div>
                {mutation.data.primary.metrics.backdropSamples7 != null && (
                  <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 0 }}>
                    Фон: медиана{' '}
                    {mutation.data.primary.metrics.backdropMedian != null
                      ? `${mutation.data.primary.metrics.backdropMedian.toFixed(2)} TON`
                      : '—'}
                    {`, продаж 7д ${mutation.data.primary.metrics.backdropSamples7}`}
                    {mutation.data.primary.metrics.backdropSamples30 != null
                      ? `, 30д ${mutation.data.primary.metrics.backdropSamples30}`
                      : ''}
                    {mutation.data.primary.metrics.backdropRatio != null
                      ? `, ratio ${mutation.data.primary.metrics.backdropRatio.toFixed(3)}`
                      : ''}
                    {mutation.data.primary.metrics.backdropRatioClamped != null
                      ? ` → ${mutation.data.primary.metrics.backdropRatioClamped.toFixed(3)}`
                      : ''}
                    {mutation.data.primary.metrics.backdropTier
                      ? `, ${mutation.data.primary.metrics.backdropTier}`
                      : ''}
                    {mutation.data.primary.metrics.backdropAdjustmentApplied
                      ? `, сдвиг ${((mutation.data.primary.metrics.backdropAdjustment ?? 0) * 100).toFixed(1)}%`
                      : ', цену не сдвигал'}
                  </p>
                )}
                {mutation.data.orderBook && (
                  <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                    {mutation.data.orderBook.fetched
                      ? `Стакан с MRKT: ${mutation.data.orderBook.asks} лотов`
                      : mutation.data.orderBook.error
                        ? `Стакан не загрузился: ${mutation.data.orderBook.error}`
                        : mutation.data.orderBook.skippedReason === 'not_promising'
                          ? 'Стакан не запрашивали: по продажам нет buy/watch'
                          : 'Стакан не запрашивали'}
                  </p>
                )}
                {mutation.data.primary.metrics.orderBookMetrics && (
                  <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                    Стакан: флор{' '}
                    {mutation.data.primary.metrics.orderBookMetrics.activeFloor.toFixed(2)}{' '}
                    TON, дешевле или вровень{' '}
                    {mutation.data.primary.metrics.orderBookMetrics.cheaperListingsCount}
                    , ниже цели продажи{' '}
                    {mutation.data.primary.metrics.orderBookMetrics.listingsBelowTarget}
                    {mutation.data.primary.metrics.orderBookMetrics.liquidityOverhangDays !=
                    null
                      ? `, очередь ${mutation.data.primary.metrics.orderBookMetrics.liquidityOverhangDays.toFixed(1)} д`
                      : ''}
                    {mutation.data.primary.metrics.orderBookMetrics.referenceCapped
                      ? ', медиана обрезана флором'
                      : ''}
                  </p>
                )}
              </>
            ) : (
              <>
                <h2>
                  Вердикт: <span className="badge gray">МАЛО ДАННЫХ</span>
                </h2>
                <p style={{ color: 'var(--text-dim)' }}>
                  Ни один срез не набрал надёжную или расширенную выборку. Это не
                  отказ от лота — по имеющимся продажам оценку дать нельзя.
                </p>
              </>
            )}
          </div>

          <h2>По срезам</h2>
          <div className="card liquidity-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Срез</th>
                  <th>Действие</th>
                  <th>Доказательство</th>
                  <th>7д</th>
                  <th>30д</th>
                  <th>Медиана</th>
                  <th>К медиане</th>
                  <th>Маржа</th>
                  <th>3д / тренд</th>
                  <th>Уверенность</th>
                </tr>
              </thead>
              <tbody>
                {mutation.data.scopes.map((s) => {
                  const badge = actionBadge(s.verdict.action);
                  const ev = s.verdict.evidence ?? '';
                  const isPrimary = mutation.data.primary?.scope === s.scope;
                  return (
                    <tr key={s.scope}>
                      <td>
                        {SCOPE_LABEL[s.scope] ?? s.scope}
                        {isPrimary ? ' · итог' : ''}
                      </td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.text}</span>
                      </td>
                      <td>{EVIDENCE_LABEL[ev] ?? (ev || '—')}</td>
                      <td>{s.verdict.metrics.samples7 ?? s.verdict.metrics.samples}</td>
                      <td>{s.verdict.metrics.samples30 ?? '—'}</td>
                      <td>
                        {s.verdict.metrics.referencePrice
                          ? `${s.verdict.metrics.referencePrice.toFixed(2)} (${s.verdict.metrics.windowDays ?? 7}д)`
                          : '—'}
                      </td>
                      <td>
                        {(s.verdict.metrics.discountVsMedian * 100).toFixed(1)}%
                      </td>
                      <td>
                        {(s.verdict.metrics.netMargin * 100).toFixed(1)}%
                      </td>
                      <td>
                        {s.verdict.metrics.median3 != null
                          ? `${s.verdict.metrics.median3.toFixed(2)}`
                          : '—'}
                        {s.verdict.metrics.trend != null
                          ? ` (${(s.verdict.metrics.trend * 100).toFixed(0)}%${
                              s.verdict.metrics.trendStatus === 'bullish'
                                ? ', рост'
                                : s.verdict.metrics.trendAdjusted
                                  ? ', защита'
                                  : ''
                            })`
                          : ''}
                      </td>
                      <td>{s.verdict.metrics.confidence}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ul style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 0 }}>
              {mutation.data.scopes.map((s) => (
                <li key={`${s.scope}-reason`}>
                  <b>{SCOPE_LABEL[s.scope] ?? s.scope}.</b> {s.verdict.reason}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

const ANALYSIS_LOG_KIND = 'gift-parser/lot-analysis-log';
const ANALYSIS_LOG_VERSION = 1;

export interface LotAnalysisLogFile {
  kind: typeof ANALYSIS_LOG_KIND;
  version: typeof ANALYSIS_LOG_VERSION;
  generatedAt: string;
  pipeline: string[];
  input: {
    collection: string;
    model: string;
    backdrop: string | null;
    priceTon: number;
    days: number;
    feeRate: number;
  };
  thresholds: SalesVerdictThresholdsResponse | null;
  rules: {
    minSamplesReliable: number;
    weakSamples: number;
    extendedWindowDays: number;
    recentWindowDays: number;
    extendedBuyExtra: number;
    backdropSupportMin: number;
    backdropPartialWeight: number;
    backdropAdjustment: {
      low: { range: [number, number]; shiftFactor: number };
      mid: { range: [number, number]; shiftFactor: number };
      high: { range: [number, number]; shiftFactor: number };
    };
    premiumBackdrops: string[];
    orderBookFloorSpread: number;
    orderBookFloorCap: number;
    orderBookWallListings: number;
    orderBookOverhangWatchDays: number;
    orderBookOverhangSkipDays: number;
  };
  result: LotAnalysis;
}

function slugFilePart(value: string): string {
  const s = value
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'lot';
}

function downloadLotAnalysisLog(params: {
  collection: string;
  model: string;
  backdrop: string;
  price: number;
  days: number;
  feeRate: number;
  thresholds?: SalesVerdictThresholdsResponse;
  premiumBackdrops: string[];
  result: LotAnalysis;
}): void {
  const payload: LotAnalysisLogFile = {
    kind: ANALYSIS_LOG_KIND,
    version: ANALYSIS_LOG_VERSION,
    generatedAt: new Date().toISOString(),
    pipeline: [
      'evaluateLotAllScopes → decideFromSales по каждому срезу',
      'обычный фон не входит в цену и не фильтрует стакан',
      'pickPrimaryLotVerdict (премиум-фон, иначе модель, иначе коллекция)',
    ],
    input: {
      collection: params.collection,
      model: params.model,
      backdrop: params.backdrop.trim() || null,
      priceTon: params.price,
      days: params.days,
      feeRate: params.feeRate,
    },
    thresholds: params.thresholds ?? null,
    rules: {
      minSamplesReliable: 10,
      weakSamples: 5,
      extendedWindowDays: 30,
      recentWindowDays: 3,
      extendedBuyExtra: 0.02,
      backdropSupportMin: 5,
      backdropPartialWeight: 0.5,
      backdropAdjustment: {
        low: { range: [0.8, 1.2], shiftFactor: 0.5 },
        mid: { range: [0.65, 1.4], shiftFactor: 0.75 },
        high: { range: [0.5, 2], shiftFactor: 1 },
      },
      premiumBackdrops: params.premiumBackdrops,
      orderBookFloorSpread: 0.005,
      orderBookFloorCap: 1.03,
      orderBookWallListings: 3,
      orderBookOverhangWatchDays: 2,
      orderBookOverhangSkipDays: 5,
    },
    result: params.result,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = [
    'lot-analysis',
    slugFilePart(params.collection),
    slugFilePart(params.model),
    params.backdrop.trim() ? slugFilePart(params.backdrop) : null,
    stamp,
  ]
    .filter(Boolean)
    .join('-');

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
