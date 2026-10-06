import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { analyzeLot, getParseConfig } from '@/api/client';
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
        Тот же разбор, что у сканера saling. Коллекция и модель считаются всегда.
        Срезы по фону только для <b>Black</b> и <b>Onyx Black</b>: если у коллекции
        с этим фоном ≥10 продаж, вердикт берётся оттуда, модель его не отменяет.
        Остальные цвета пока не учитываются (остаются коллекция и модель).
        Окно 7 дней, при нехватке продаж на срезе смотрим 30. Комиссия из настроек.
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
            ? `, фон ${backdropTrim}${backdropSlices ? ' (+ срезы по фону)' : ' (без срезов по фону)'}`
            : ''}
          .
        </p>
      </div>

      {mutation.isError && <ErrorBox error={mutation.error} />}

      {mutation.data && (
        <>
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
                          ? ` (${(s.verdict.metrics.trend * 100).toFixed(0)}%${s.verdict.metrics.trendAdjusted ? ', защита' : ''})`
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
