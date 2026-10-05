import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getHistory } from '@/api/client';
import type { HistoryResponse } from '@/api/types';
import CollectionModelSelect from '@/components/CollectionModelSelect';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';
import { useCatalog } from '@/hooks/useCatalog';

export function History() {
  const catalog = useCatalog();
  const [collection, setCollection] = useState('');
  const [model, setModel] = useState('');
  const [days, setDays] = useState(30);

  const [params, setParams] = useState<{
    collection: string;
    model: string | null;
    days: number;
  } | null>(null);

  useEffect(() => {
    if (!catalog.data || collection) return;
    const c = catalog.data.collections[0];
    if (!c) return;
    setCollection(c);
    setModel('');
  }, [catalog.data, collection]);

  const query = useQuery<HistoryResponse>({
    queryKey: ['history', params],
    queryFn: () =>
      getHistory(params!.collection, params!.days, params!.model),
    enabled: !!params?.collection,
  });

  function run() {
    if (!collection) return;
    setParams({
      collection,
      model: model.trim() || null,
      days,
    });
  }

  const scopeLabel = params?.model
    ? `${params.collection} / ${params.model}`
    : params?.collection ?? '';

  return (
    <div>
      <h1>История floor</h1>

      <div className="card">
        <div className="form-row">
          <CollectionModelSelect
            collection={collection}
            model={model}
            onCollectionChange={setCollection}
            onModelChange={setModel}
            modelOptional
          />
          <div className="form-field">
            <label>Дней</label>
            <input
              type="number"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 30)}
              style={{ width: 80 }}
            />
          </div>
          <button
            onClick={run}
            disabled={query.isFetching || !collection}
          >
            {query.isFetching ? '...' : 'Загрузить'}
          </button>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '12px 0 0' }}>
          Без модели — floor коллекции из <code>collection_prices</code>, с моделью —
          из <code>model_prices</code>.
        </p>
      </div>

      {query.isError && <ErrorBox error={query.error} />}
      {query.isFetching && <Loading />}

      {query.data && (
        <div className="card">
          <div style={{ marginBottom: 12 }}>
            <b>{scopeLabel}</b> — точек: <b>{query.data.points.length}</b>
          </div>
          {query.data.points.length === 0 ? (
            <p style={{ color: 'var(--text-dim)' }}>
              Нет снимков в mrkt.db. Нужен{' '}
              <code>data/market.json</code> (полный <code>npm run parse</code>),
              затем <code>npm run sync-db</code> или перезапуск{' '}
              <code>npm run server</code>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Floor (TON)</th>
                </tr>
              </thead>
              <tbody>
                {[...query.data.points].reverse().map((p) => (
                  <tr key={p.ts}>
                    <td>{new Date(p.ts * 1000).toLocaleString('ru-RU')}</td>
                    <td>
                      {p.floor_nano != null
                        ? (p.floor_nano / 1e9).toFixed(3)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
