import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getStyleCombos,
  saveStyleCombos,
  type StyleCombo,
} from '@/api/client';
import BackdropSelect from '@/components/BackdropSelect';
import CollectionModelSelect from '@/components/CollectionModelSelect';
import ErrorBox from '@/components/ErrorBox';

export function Combos() {
  const queryClient = useQueryClient();
  const combos = useQuery({
    queryKey: ['style-combos'],
    queryFn: getStyleCombos,
  });
  const [collection, setCollection] = useState('');
  const [model, setModel] = useState('');
  const [backdrop, setBackdrop] = useState('');

  const save = useMutation({
    mutationFn: saveStyleCombos,
    onSuccess: (next) => {
      queryClient.setQueryData(['style-combos'], next);
    },
  });

  const list = combos.data ?? [];
  const premiumBackdrop = backdrop === 'Black' || backdrop === 'Onyx Black';
  const canAdd = Boolean(collection.trim() && model.trim() && backdrop.trim() && !premiumBackdrop);

  function upsert() {
    if (!canAdd) return;
    const next: StyleCombo = {
      collection: collection.trim(),
      model: model.trim(),
      backdrop: backdrop.trim(),
    };
    const without = list.filter(
      (row) =>
        !(
          row.collection === next.collection &&
          row.model === next.model &&
          row.backdrop === next.backdrop
        ),
    );
    save.mutate([...without, next]);
  }

  function remove(row: StyleCombo) {
    save.mutate(
      list.filter(
        (item) =>
          !(
            item.collection === row.collection &&
            item.model === row.model &&
            item.backdrop === row.backdrop
          ),
      ),
    );
  }

  return (
    <div>
      <h1>Комбинации</h1>
      <p style={{ color: 'var(--text-dim)', maxWidth: 720 }}>
        Сохранённая связка объявляет модель с этим фоном отдельным рынком.
        Если по ней достаточно продаж, цена берётся из этих сделок.
        Если продаж мало, фон снова не влияет на цену: итог по модели, затем по коллекции.
        Black и Onyx Black сюда не добавляются — у них своя премиальная ветка.
      </p>

      <div className="card">
        <CollectionModelSelect
          collection={collection}
          model={model}
          onCollectionChange={setCollection}
          onModelChange={setModel}
        />
        <div className="form-row">
          <BackdropSelect
            collection={collection}
            value={backdrop}
            onChange={setBackdrop}
          />
          <button type="button" disabled={!canAdd || save.isPending} onClick={upsert}>
            Сохранить
          </button>
        </div>
        {premiumBackdrop ? (
          <p style={{ color: 'var(--yellow)' }}>
            Black и Onyx Black уже считаются премиальным фоном.
          </p>
        ) : null}
        {save.isError ? <ErrorBox error={save.error} /> : null}
      </div>

      {combos.isError ? <ErrorBox error={combos.error} /> : null}

      <div className="card">
        {list.length === 0 ? (
          <p style={{ color: 'var(--text-dim)' }}>Пока нет сохранённых комбинаций.</p>
        ) : (
          <div className="liquidity-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Коллекция</th>
                <th>Модель</th>
                <th>Фон</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={`${row.collection}|${row.model}|${row.backdrop}`}>
                  <td>{row.collection}</td>
                  <td>{row.model}</td>
                  <td>{row.backdrop}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={save.isPending}
                      onClick={() => remove(row)}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
