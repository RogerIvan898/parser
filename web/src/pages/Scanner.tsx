import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  getParseConfig,
  getProfitDeals,
  getRadarDeals,
} from '@/api/client';
import type {
  RadarDealsResponse,
  SalingAnalysisRecord,
  SalingDealsResponse,
} from '@/api/types';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';

const REFRESH_MS = 12_000;

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function mrktGiftUrl(giftId: string): string {
  return `https://t.me/mrkt/app?startapp=gift_${giftId}`;
}

function confidenceBadge(c: string) {
  const cls =
    c === 'high' ? 'green' : c === 'medium' ? 'yellow' : 'gray';
  return <span className={`badge ${cls}`}>{c}</span>;
}

function scopeLabel(scope: string): string {
  const map: Record<string, string> = {
    collection: 'коллекция',
    model: 'модель',
    'collection+backdrop': 'колл.+фон',
    'model+backdrop': 'модель+фон',
  };
  return map[scope] ?? scope;
}

function AnalysisDealsTable({
  deals,
  kind,
}: {
  deals: SalingAnalysisRecord[];
  kind: 'buy' | 'watch';
}) {
  if (deals.length === 0) {
    return (
      <p style={{ color: 'var(--text-dim)', margin: 0 }}>
        Пока пусто. Включи сканер saling в{' '}
        <Link to="/settings">настройках</Link> и дождись лотов с вердиктом{' '}
        <code>{kind}</code>.
      </p>
    );
  }

  return (
    <div className="liquidity-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Время</th>
            <th>Лот / итог</th>
            <th>Цена</th>
            <th>Медиана</th>
            <th>Δ</th>
            <th>Маржа</th>
            <th>Срез</th>
            <th>7д / 30д</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => {
            const m = d.primary.metrics;
            return (
              <Fragment key={d.listingId}>
                <tr>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                    {fmtTime(d.detectedAt)}
                  </td>
                  <td>
                    <div>{d.collection}</div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                      {d.model || '—'} · {d.backdrop || '—'}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-dim)' }}>
                      {d.primary.reason}
                    </div>
                    {d.signals.length > 0 && (
                      <div style={{ fontSize: 11, marginTop: 4 }}>
                        {d.signals.join(' · ')}
                      </div>
                    )}
                  </td>
                  <td>
                    <b>{d.priceTon.toFixed(3)}</b> TON
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {m.referencePrice > 0
                      ? `${m.referencePrice.toFixed(2)} (${m.windowDays ?? d.analysisDays}д)`
                      : '—'}
                  </td>
                  <td className={m.discountVsMedian >= 0 ? 'green' : 'red'}>
                    {pct(m.discountVsMedian)}
                  </td>
                  <td>{pct(m.netMargin)}</td>
                  <td style={{ fontSize: 12 }}>
                    {scopeLabel(d.primary.scope)}
                    <br />
                    {d.primary.evidence ?? '—'}{' '}
                    {confidenceBadge(d.primary.confidence)}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {m.samples7 ?? '—'} / {m.samples30 ?? '—'}
                  </td>
                  <td>
                    <a
                      href={mrktGiftUrl(d.giftId)}
                      target="_blank"
                      rel="noreferrer"
                      className="nav-link"
                      style={{ display: 'inline-block', padding: '4px 8px' }}
                    >
                      MRKT
                    </a>
                  </td>
                </tr>
                <tr>
                  <td colSpan={9} style={{ paddingTop: 0, paddingBottom: 16 }}>
                    <details>
                      <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                        Все срезы ({d.scopes.length}) · buy-срезов {d.buyScopeCount} ·
                        fee {pct(d.feeRate)} · пороги buy{' '}
                        {pct(d.thresholds.buyMinDiscount)}/
                        {pct(d.thresholds.buyMinMargin)}
                      </summary>
                      <table style={{ marginTop: 8, fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th>Срез</th>
                            <th>Действие</th>
                            <th>Доказ.</th>
                            <th>7д</th>
                            <th>30д</th>
                            <th>Медиана</th>
                            <th>Δ</th>
                            <th>Маржа</th>
                            <th>3д</th>
                            <th>Тренд</th>
                            <th>пр/день</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.scopes.map((s) => (
                            <tr key={s.scope}>
                              <td>{scopeLabel(s.scope)}</td>
                              <td>{s.action}</td>
                              <td>{s.evidence ?? '—'}</td>
                              <td>{s.metrics.samples7 ?? s.metrics.samples}</td>
                              <td>{s.metrics.samples30 ?? '—'}</td>
                              <td>
                                {s.metrics.referencePrice > 0
                                  ? s.metrics.referencePrice.toFixed(2)
                                  : '—'}
                              </td>
                              <td>{pct(s.metrics.discountVsMedian)}</td>
                              <td>{pct(s.metrics.netMargin)}</td>
                              <td>
                                {s.metrics.median3 != null
                                  ? `${s.metrics.median3.toFixed(2)} (n=${s.metrics.samples3 ?? '—'})`
                                  : '—'}
                              </td>
                              <td>
                                {s.metrics.trend != null
                                  ? `${pct(s.metrics.trend)}${s.metrics.trendAdjusted ? ' · защита' : ''}`
                                  : '—'}
                              </td>
                              <td>{s.metrics.salesPerDay.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function collectionPulse(
  deals: { collection: string; detectedAt: string }[],
  windowHours: number,
): { collection: string; count: number }[] {
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  for (const d of deals) {
    const t = new Date(d.detectedAt).getTime();
    if (Number.isNaN(t) || t < since) continue;
    counts.set(d.collection, (counts.get(d.collection) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([collection, count]) => ({ collection, count }))
    .sort((a, b) => b.count - a.count);
}

type Tab = 'radar' | 'profit';

export function Scanner() {
  const [tab, setTab] = useState<Tab>('radar');
  const [limit, setLimit] = useState(80);
  const [pulseHours, setPulseHours] = useState(2);

  const configQuery = useQuery({
    queryKey: ['parse-config-scanner'],
    queryFn: getParseConfig,
  });

  const profitQuery = useQuery<SalingDealsResponse>({
    queryKey: ['profit-deals', limit],
    queryFn: () => getProfitDeals(limit),
    refetchInterval: REFRESH_MS,
  });

  const radarQuery = useQuery<RadarDealsResponse>({
    queryKey: ['radar-deals', limit],
    queryFn: () => getRadarDeals(limit),
    refetchInterval: REFRESH_MS,
  });

  const activeQuery = tab === 'radar' ? radarQuery : profitQuery;
  const radarPulse = useMemo(
    () => collectionPulse(radarQuery.data?.deals ?? [], pulseHours),
    [radarQuery.data?.deals, pulseHours],
  );

  const scannerOn = configQuery.data?.salingScannerEnabled === true;

  return (
    <div>
      <h1>Сканер saling</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 0, maxWidth: 720 }}>
        Лента <code>POST /gifts/saling</code> (20 недавних лотов). По каждому лоту —
        4 среза. Для <b>Black</b> и <b>Onyx Black</b> цену задаёт фон: при ≥10
        продажах коллекции с этим фоном модель вердикт не отменяет. <code>buy</code> — только в{' '}
        <code>profit-deals.json</code> (для авто-бая). <code>watch</code> — в{' '}
        <code>profit-deals.json</code> и <code>radar-deals.json</code> (v4): один формат —
        итог, все срезы с reason, пороги, signals.
      </p>

      <div className="card">
        <div className="form-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            className={`badge ${scannerOn ? 'green' : 'gray'}`}
            style={{ marginRight: 8 }}
          >
            сканер {scannerOn ? 'вкл' : 'выкл'}
          </span>
          {!scannerOn && (
            <Link to="/settings" style={{ fontSize: 13 }}>
              Включить в настройках
            </Link>
          )}
          <div className="form-field" style={{ marginLeft: 'auto' }}>
            <label>Строк в ответе API</label>
            <input
              type="number"
              min={10}
              max={400}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 80)}
              style={{ width: 72 }}
            />
          </div>
        </div>
      </div>

      {tab === 'radar' && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 15 }}>Пульс коллекций (radar)</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            Сколько <code>watch</code>-записей попало в выборку за окно — если одна
            коллекция резко выросла, возможен дамп или активная торговля.
          </p>
          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-field">
              <label>Окно, ч</label>
              <input
                type="number"
                min={1}
                max={48}
                value={pulseHours}
                onChange={(e) => setPulseHours(Number(e.target.value) || 2)}
                style={{ width: 64 }}
              />
            </div>
          </div>
          {radarPulse.length === 0 ? (
            <p style={{ color: 'var(--text-dim)', margin: 0, fontSize: 13 }}>
              Нет radar-лотов в загруженной порции за {pulseHours} ч (увеличь лимит
              или подожди сканер).
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {radarPulse.map((row) => (
                <li key={row.collection}>
                  <b>{row.collection}</b> — {row.count}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card">
        <div
          className="form-row"
          style={{ marginBottom: 16, gap: 8 }}
        >
          <button
            type="button"
            className={tab === 'radar' ? '' : 'btn-ghost'}
            onClick={() => setTab('radar')}
          >
            Радар (watch)
            {radarQuery.data != null && (
              <span style={{ marginLeft: 6, opacity: 0.8 }}>
                {radarQuery.data.total}
              </span>
            )}
          </button>
          <button
            type="button"
            className={tab === 'profit' ? '' : 'btn-ghost'}
            onClick={() => setTab('profit')}
          >
            Profit (buy)
            {profitQuery.data != null && (
              <span style={{ marginLeft: 6, opacity: 0.8 }}>
                {profitQuery.data.total}
              </span>
            )}
          </button>
          {activeQuery.data && (
            <span
              style={{
                color: 'var(--text-dim)',
                fontSize: 13,
                marginLeft: 'auto',
              }}
            >
              обновлено: {fmtTime(activeQuery.data.updatedAt)}
            </span>
          )}
        </div>

        {activeQuery.isError && <ErrorBox error={activeQuery.error} />}
        {activeQuery.isLoading && <Loading />}
        {tab === 'radar' && radarQuery.data && (
          <AnalysisDealsTable deals={radarQuery.data.deals} kind="watch" />
        )}
        {tab === 'profit' && profitQuery.data && (
          <AnalysisDealsTable deals={profitQuery.data.deals} kind="buy" />
        )}
      </div>
    </div>
  );
}
