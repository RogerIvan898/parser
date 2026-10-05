import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLiquidity } from '@/api/client';
import type { LiquidItemRow, LiquidityResponse } from '@/api/types';
import StickerThumb from '@/components/StickerThumb';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';
import { useCatalog } from '@/hooks/useCatalog';
import { mrktStickerUrl } from '@/lib/images';
import { useSettings } from '@/store/settings';

function fmtTrend(trend: number | null): string {
  if (trend === null) return '—';
  const pct = (trend * 100).toFixed(0);
  return trend > 0 ? `+${pct}%` : `${pct}%`;
}

function trendClass(trend: number | null): string {
  if (trend === null) return 'gray';
  if (trend > 0.1) return 'green';
  if (trend < -0.1) return 'red';
  return 'gray';
}

function confidenceBadge(c: LiquidItemRow['confidence']) {
  const cls =
    c === 'high' ? 'green' : c === 'medium' ? 'yellow' : 'gray';
  return <span className={`badge ${cls}`}>{c}</span>;
}

function freshnessLabel(f: LiquidItemRow['freshness']): string {
  if (f === 'hot') return 'горячая';
  if (f === 'warm') return 'тёплая';
  return 'остывает';
}

export function Liquidity() {
  const { defaultDays } = useSettings();
  const catalog = useCatalog();
  const [days, setDays] = useState(defaultDays);

  const query = useQuery<LiquidityResponse>({
    queryKey: ['liquidity', days],
    queryFn: () => getLiquidity(days),
  });

  const thumbs = catalog.data?.modelThumbnails ?? {};

  return (
    <div>
      <h1>Ликвидные модели</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
        Частые недавние продажи со стабильной ценой. Сортировка: уверенность, затем
        оборот.
      </p>

      <div className="card">
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-field">
            <label>Окно, дней</label>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || defaultDays)}
              style={{ width: 88 }}
            />
          </div>
          {query.data && (
            <span style={{ color: 'var(--text-dim)', fontSize: 14 }}>
              В списке: <b>{query.data.count}</b>
            </span>
          )}
        </div>
      </div>

      {query.isError && <ErrorBox error={query.error} />}
      {query.isLoading && <Loading />}

      {query.data && (
        <>
          {query.data.items.length === 0 ? (
            <div className="card">
              <p style={{ color: 'var(--text-dim)', margin: 0 }}>
                Нет пар под текущие пороги (свежесть, IQR, оборот по цене).
                Накопи историю: <code>npm run parse -- --history</code>
              </p>
            </div>
          ) : (
            <div className="card liquidity-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 48 }} />
                    <th>Коллекция / модель</th>
                    <th>Продаж</th>
                    <th>В день</th>
                    <th>Последняя</th>
                    <th>Медиана</th>
                    <th>IQR</th>
                    <th>Тренд</th>
                    <th>Уверенность</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((row) => (
                    <tr key={`${row.collection}::${row.model}`}>
                      <td>
                        <StickerThumb
                          src={mrktStickerUrl(
                            thumbs[row.collection]?.[row.model],
                          )}
                          alt=""
                          size={36}
                        />
                      </td>
                      <td>
                        <div>{row.collection}</div>
                        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                          {row.model}
                        </div>
                      </td>
                      <td>{row.samples}</td>
                      <td>
                        <b>{row.salesPerDay.toFixed(2)}</b>
                      </td>
                      <td>
                        <div>{row.lastSaleAgeDays.toFixed(1)} дн.</div>
                        <div
                          style={{ color: 'var(--text-dim)', fontSize: 12 }}
                          title={freshnessLabel(row.freshness)}
                        >
                          {row.lastSaleTon > 0
                            ? `${row.lastSaleTon.toFixed(2)} TON`
                            : '—'}
                        </div>
                      </td>
                      <td>
                        {row.medianTon > 0 ? row.medianTon.toFixed(2) : '—'}
                      </td>
                      <td>
                        {row.iqrRatio != null
                          ? row.iqrRatio.toFixed(2)
                          : '—'}
                      </td>
                      <td>
                        <span className={`badge ${trendClass(row.trend)}`}>
                          {fmtTrend(row.trend)}
                        </span>
                      </td>
                      <td>{confidenceBadge(row.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <details className="card liquidity-criteria liquidity-criteria--folded">
            <summary>Как считаем ликвидность</summary>
            <p style={{ margin: '12px 0' }}>{query.data.criteria.summary}</p>
            <ul className="liquidity-criteria__list">
              <li>
                <b>Данные:</b> {query.data.criteria.dataSource}
              </li>
              <li>
                <b>Срез:</b> {query.data.criteria.scope}
              </li>
              <li>
                <b>Окно:</b> {query.data.criteria.windowDays} дн.
              </li>
              <li>
                <b>Мин. продаж:</b> {query.data.criteria.minSamples}
              </li>
              <li>
                <b>Макс. возраст последней продажи:</b>{' '}
                {query.data.criteria.maxLastSaleAgeDays} дн.
              </li>
              <li>
                <b>Макс. IQR/median:</b> {query.data.criteria.maxIqrRatio}
              </li>
              <li>
                <b>Мин. продаж/день:</b> {query.data.criteria.salesPerDayByPrice}
              </li>
              <li>
                <b>Свежесть:</b> {query.data.criteria.freshnessLabels}
              </li>
              <li>
                <b>Уверенность:</b> {query.data.criteria.confidenceRules}
              </li>
              <li>
                <b>Тренд:</b> медиана цены во 2-й половине окна vs 1-й; &gt;10%
                рост, &lt;−10% падение
              </li>
              <li>
                <b>Сортировка:</b> {query.data.criteria.ranking}
              </li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
