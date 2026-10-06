import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  getParseConfig,
  getProfitDeals,
  getRadarDeals,
} from '@/api/client';
import type { SalingDealRecord, SalingDealsResponse } from '@/api/types';
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

function DealsTable({
  deals,
  kind,
}: {
  deals: SalingDealRecord[];
  kind: 'buy' | 'watch';
}) {
  if (deals.length === 0) {
    return (
      <p style={{ color: 'var(--text-dim)', margin: 0 }}>
        Пока пусто. Включи сканер saling в{' '}
        <Link to="/settings">настройках</Link> и дождись лотов с вердиктом{' '}
        <code>{kind}</code> по узкому срезу.
      </p>
    );
  }

  return (
    <div className="liquidity-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Время</th>
            <th>Коллекция / модель</th>
            <th>Фон</th>
            <th>Цена</th>
            <th>Δ медиана</th>
            <th>Маржа</th>
            <th>Срез</th>
            <th>n</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => (
            <tr key={d.listingId}>
              <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                {fmtTime(d.detectedAt)}
              </td>
              <td>
                <div>{d.collection}</div>
                <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  {d.model || '—'}
                </div>
                {d.signals && d.signals.length > 0 && (
                  <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
                    {d.signals.join(' · ')}
                  </div>
                )}
              </td>
              <td style={{ fontSize: 12 }}>{d.backdrop || '—'}</td>
              <td>
                <b>{d.priceTon.toFixed(3)}</b> TON
              </td>
              <td className={d.verdict.metrics.discountVsMedian >= 0 ? 'green' : 'red'}>
                {pct(d.verdict.metrics.discountVsMedian)}
              </td>
              <td>{pct(d.verdict.metrics.netMargin)}</td>
              <td style={{ fontSize: 12 }}>{scopeLabel(d.verdict.scope)}</td>
              <td>
                {d.verdict.metrics.samples}{' '}
                {confidenceBadge(d.verdict.metrics.confidence)}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

function collectionPulse(
  deals: SalingDealRecord[],
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

  const radarQuery = useQuery<SalingDealsResponse>({
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
        4 среза анализа; в файл попадает <b>самый узкий</b> срез с ≥10 продаж за 7
        дней. <code>buy</code> — только в{' '}
        <code>profit-deals.json</code> (для авто-бая). <code>watch</code> — в{' '}
        <code>radar-deals.json</code>: «чуть не дотянул» до buy, удобно для ручного
        снайпинга и заметки всплесков по коллекциям.
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
        {activeQuery.data && (
          <DealsTable deals={activeQuery.data.deals} kind={tab === 'radar' ? 'watch' : 'buy'} />
        )}
      </div>
    </div>
  );
}
