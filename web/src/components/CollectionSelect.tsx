import { useMemo } from 'react';
import { useCatalog } from '@/hooks/useCatalog';
import { mrktStickerUrl } from '@/lib/images';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';
import ImageSelect from '@/components/ImageSelect';

interface Props {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  optional?: boolean;
  label?: string;
}

export default function CollectionSelect({
  value,
  onChange,
  disabled,
  optional = false,
  label = 'Коллекция',
}: Props) {
  const catalog = useCatalog();

  const options = useMemo(() => {
    const cols = catalog.data?.collections ?? [];
    const thumbs = catalog.data?.collectionThumbnails ?? {};
    const opts = cols.map((c) => ({
      value: c,
      label: c,
      imageUrl: mrktStickerUrl(thumbs[c]),
    }));
    if (optional) {
      return [{ value: '', label: 'Все коллекции', imageUrl: null }, ...opts];
    }
    return opts;
  }, [catalog.data, optional]);

  if (catalog.isLoading) return <Loading />;
  if (catalog.isError) return <ErrorBox error={catalog.error} />;

  return (
    <ImageSelect
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled || options.length === 0}
      placeholder={options.length === 0 ? 'Нет каталога' : '—'}
    />
  );
}
