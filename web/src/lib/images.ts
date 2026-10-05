const MRKT_CDN = 'https://cdn.tgmrkt.io';
const FRAGMENT_GIFT = 'https://nft.fragment.com/gift';

/** Ключ из API → полный URL cdn.tgmrkt.io */
export function mrktStickerUrl(stickerKey: string | null | undefined): string | null {
  if (!stickerKey?.trim()) return null;
  const key = stickerKey.trim();
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  const path = key.startsWith('/') ? key.slice(1) : key;
  return `${MRKT_CDN}/${path}`;
}

export type FragmentGiftImageSize = 'small' | 'medium' | 'large';

/** Конкретный NFT-лот на Fragment (рендер подарка с номером) */
export function fragmentGiftImageUrl(
  opts: {
    name?: string | null;
    collectionName?: string | null;
    number?: number | null;
  },
  size: FragmentGiftImageSize = 'medium',
): string | null {
  let slug = opts.name?.trim() || '';
  if (!slug && opts.collectionName && opts.number != null) {
    slug = `${opts.collectionName.replace(/\s+/g, '')}-${opts.number}`;
  }
  if (!slug) return null;
  slug = slug.replace(/\.(small|medium|large)\.jpg$/i, '');
  return `${FRAGMENT_GIFT}/${slug}.${size}.jpg`;
}

export interface GiftImageSource {
  name?: string | null;
  number?: number | null;
  collectionName?: string | null;
  modelName?: string | null;
  modelStickerThumbnailKey?: string | null;
}

/**
 * Превью лота: Fragment (если есть name/number), иначе стикер модели на CDN.
 */
export function giftPreviewUrl(
  gift: GiftImageSource,
  modelThumbKey?: string | null,
): string | null {
  const isConcreteLot =
    gift.number != null && (gift.name || gift.collectionName);
  if (isConcreteLot) {
    const fragment = fragmentGiftImageUrl({
      name: gift.name,
      collectionName: gift.collectionName,
      number: gift.number,
    });
    if (fragment) return fragment;
  }

  const key = gift.modelStickerThumbnailKey ?? modelThumbKey;
  return mrktStickerUrl(key);
}
