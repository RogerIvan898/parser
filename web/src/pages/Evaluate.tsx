import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { decide } from '@/api/client';
import type { DealVerdict } from '@/api/types';
import CollectionModelSelect from '@/components/CollectionModelSelect';
import BackdropSelect from '@/components/BackdropSelect';
import ErrorBox from '@/components/ErrorBox';
import { useCatalog } from '@/hooks/useCatalog';
import { useSettings } from '@/store/settings';

const SCOPE_LABEL: Record<string, string> = {
  collection: 'вся коллекция',
  model: 'модель',
  'model+backdrop': 'модель и фон',
  'collection+backdrop': 'коллекция и фон',
};

export function Evaluate() {
  const { defaultDays, defaultFeeRate } = useSettings();
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
    setModel('');
  }, [catalog.data, collection]);

  useEffect(() => {
    setBackdrop('');
  }, [collection]);

  const mutation = useMutation<DealVerdict, Error>({
    mutationFn: () =>
      decide({
        collection,
        model: model.trim() || null,
        backdrop: backdrop.trim() || null,
        price: Number(price),
        days: defaultDays,
        feeRate: defaultFeeRate,
      }),
  });

  const priceOk = typeof price === 'number' && price > 0;

  return (
    <div>
      <h1>Оценка лота</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
        Цена сравнивается с продажами из истории. Без модели — по всей коллекции,
        с моделью — только по ней, с фоном — ещё и по фону.
      </p>

      <div className="card">
        <div className="form-row">
          <CollectionModelSelect
            collection={collection}
            model={model}
            onCollectionChange={setCollection}
            onModelChange={setModel}
            modelOptional
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
            disabled={mutation.isPending || !collection || !priceOk}
          >
            {mutation.isPending ? '...' : 'Оценить'}
          </button>
        </div>
      </div>

      {mutation.isError && <ErrorBox error={mutation.error} />}

      {mutation.data && (
        <div className="card">
          <h2>
            Вердикт:{' '}
            <span
              className={`badge ${
                mutation.data.action === 'buy'
                  ? 'green'
                  : mutation.data.action === 'watch'
                  ? 'yellow'
                  : 'red'
              }`}
            >
              {mutation.data.action === 'buy'
                ? 'БРАТЬ'
                : mutation.data.action === 'watch'
                ? 'СМОТРЕТЬ'
                : 'МИМО'}
            </span>
          </h2>
          <p style={{ color: 'var(--text-dim)' }}>{mutation.data.reason}</p>
          {mutation.data.scope && (
            <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              Срез: {SCOPE_LABEL[mutation.data.scope] ?? mutation.data.scope}
            </p>
          )}

          <div className="card-row">
            <Metric
              label="Медиана продаж"
              value={
                mutation.data.metrics.referencePrice
                  ? `${mutation.data.metrics.referencePrice.toFixed(2)} TON`
                  : '—'
              }
            />
            <Metric
              label="К медиане"
              value={`${(mutation.data.metrics.discountVsMedian * 100).toFixed(1)}%`}
            />
            <Metric
              label="Продаж в выборке"
              value={String(mutation.data.metrics.samples)}
            />
            <Metric
              label="Продаж в день"
              value={mutation.data.metrics.salesPerDay.toFixed(2)}
            />
            <Metric
              label="Маржа после комиссии"
              value={`${(mutation.data.metrics.netMargin * 100).toFixed(1)}%`}
            />
          </div>
        </div>
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
