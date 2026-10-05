import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStats } from '@/api/client';
import type { StatsWithConfidence } from '@/api/types';
import CollectionModelSelect from '@/components/CollectionModelSelect';
import BackdropSelect from '@/components/BackdropSelect';
import StatCard from '@/components/StatCard';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';
import { useSettings } from '@/store/settings';
import { useCatalog } from '@/hooks/useCatalog';

function fmt(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(3);
}

export function Stats() {
  const { defaultDays } = useSettings();
  const catalog = useCatalog();
  const [collection, setCollection] = useState('');
  const [model, setModel] = useState('');
  const [backdrop, setBackdrop] = useState('');
  const [days, setDays] = useState(defaultDays);

  const [params, setParams] = useState<{
    collection: string;
    model: string;
    backdrop: string | null;
    days: number;
  } | null>(null);

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

  const query = useQuery<StatsWithConfidence>({
    queryKey: ['stats', params],
    queryFn: () =>
      getStats(params!.collection, params!.model, params!.backdrop, params!.days),
    enabled: !!params?.collection && !!params?.model,
  });

  function run() {
    if (!collection || !model) return;
    setParams({
      collection,
      model,
      backdrop: backdrop.trim() || null,
      days,
    });
  }

  return (
    <div>
      <h1>Статистика продаж</h1>

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
            <label>Дней</label>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 7)}
              style={{ width: 80 }}
            />
          </div>
          <button
            onClick={run}
            disabled={query.isFetching || !collection || !model}
          >
            {query.isFetching ? '...' : 'Загрузить'}
          </button>
        </div>
      </div>

      {query.isError && <ErrorBox error={query.error} />}
      {query.isFetching && <Loading />}

      {query.data && (
        <>
          <div className="card">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>
                scope: <b>{query.data.scope}</b>
              </span>
              <span>
                confidence:{' '}
                <span
                  className={`badge ${
                    query.data.confidence === 'high'
                      ? 'green'
                      : query.data.confidence === 'medium'
                      ? 'yellow'
                      : 'gray'
                  }`}
                >
                  {query.data.confidence}
                </span>
              </span>
              <span>
                samples: <b>{query.data.samples}</b>
              </span>
            </div>
          </div>

          {query.data.samples === 0 ? (
            <div className="card">
              <p style={{ color: 'var(--text-dim)', margin: 0 }}>
                Нет продаж в БД за выбранный период. Сначала накопи историю:
                <code> npm run parse -- --history</code>
              </p>
            </div>
          ) : (
            <div className="card-row">
              <StatCard label="Мин" value={fmt(query.data.min)} />
              <StatCard label="P25" value={fmt(query.data.p25)} />
              <StatCard label="Медиана" value={fmt(query.data.median)} />
              <StatCard label="Среднее" value={fmt(query.data.avg)} />
              <StatCard label="P75" value={fmt(query.data.p75)} />
              <StatCard label="Макс" value={fmt(query.data.max)} />
              <StatCard label="Последняя" value={fmt(query.data.last)} />
            </div>
          )}

          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Цены в TON (таблица sales в mrkt.db).
          </p>
        </>
      )}
    </div>
  );
}
