import { useMemo } from 'react';
import { useCatalog } from '@/hooks/useCatalog';
import { mrktStickerUrl } from '@/lib/images';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';
import ImageSelect from '@/components/ImageSelect';

export interface CollectionModelSelectProps {
  collection: string;
  model: string;
  onCollectionChange: (name: string) => void;
  onModelChange: (name: string) => void;
  modelOptional?: boolean;
  disabled?: boolean;
}

export default function CollectionModelSelect({
  collection,
  model,
  onCollectionChange,
  onModelChange,
  modelOptional = false,
  disabled = false,
}: CollectionModelSelectProps) {
  const catalog = useCatalog();

  const collectionOptions = useMemo(() => {
    const cols = catalog.data?.collections ?? [];
    const thumbs = catalog.data?.collectionThumbnails ?? {};
    return cols.map((c) => ({
      value: c,
      label: c,
      imageUrl: mrktStickerUrl(thumbs[c]),
    }));
  }, [catalog.data]);

  const modelOptions = useMemo(() => {
    if (!catalog.data || !collection) return [];
    const names = catalog.data.models[collection] ?? [];
    const thumbs = catalog.data.modelThumbnails[collection] ?? {};
    const opts = names.map((m) => ({
      value: m,
      label: m,
      imageUrl: mrktStickerUrl(thumbs[m]),
    }));
    if (modelOptional) {
      const colThumb = catalog.data.collectionThumbnails[collection];
      return [
        {
          value: '',
          label: 'Вся коллекция',
          imageUrl: mrktStickerUrl(colThumb),
        },
        ...opts,
      ];
    }
    return opts;
  }, [catalog.data, collection, modelOptional]);

  if (catalog.isLoading) return <Loading />;
  if (catalog.isError) return <ErrorBox error={catalog.error} />;

  function handleCollection(next: string) {
    onCollectionChange(next);
    const list = catalog.data?.models[next] ?? [];
    if (!modelOptional) {
      onModelChange(list[0] ?? '');
    } else {
      onModelChange('');
    }
  }

  const emptyHint =
    catalog.data?.needsMrktAuth
      ? 'На сервере нет catalog.json. Укажи MRKT_AUTH в Bothost и перезапусти — коллекции подтянутся при открытии страницы.'
      : null;

  return (
    <>
      <ImageSelect
        label="Коллекция"
        value={collection}
        onChange={handleCollection}
        options={collectionOptions}
        disabled={disabled || collectionOptions.length === 0}
        placeholder={
          collectionOptions.length === 0
            ? 'Нет каталога — задай MRKT_AUTH на сервере или npm run parse -- --catalog'
            : '—'
        }
      />
      <ImageSelect
        label={modelOptional ? 'Модель (опц.)' : 'Модель'}
        value={model}
        onChange={onModelChange}
        options={modelOptions}
        disabled={
          disabled ||
          !collection ||
          (!modelOptional && modelOptions.length === 0)
        }
        placeholder="—"
      />
      {emptyHint ? (
        <p className="form-hint" style={{ marginTop: 8, gridColumn: '1 / -1' }}>
          {emptyHint}
        </p>
      ) : null}
    </>
  );
}
