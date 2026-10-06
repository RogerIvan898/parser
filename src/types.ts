// ============================================================
// Константы
// ============================================================

export const NANO = 1_000_000_000;

export function nanoToTon(nano: number): number {
  return nano / NANO;
}

export function formatTon(nano: number, digits = 9): string {
  return nanoToTon(nano)
    .toFixed(digits)
    .replace(/\.?0+$/, '');
}

// ============================================================
// Аутентификация
// ============================================================

export interface AuthRequest {
  data: string;
  photo: string | null;
  appId: string | null;
}

export interface AuthResponse {
  token: string;
  isFirstTime: boolean;
  giftId: string | null;
  stickerId: string | null;
  gameItemId: string | null;
  giveawayId: string | null;
  profile: unknown | null;
  feedItemId: string | null;
  stickerFeedItemId: string | null;
  gameItemFeedItemId: string | null;
  pageToOpen: string | null;
  channelId: string | null;
  channelFeedItemId: string | null;
  giftCollectionId: string | null;
  giftCollectionFeedItemId: string | null;
  lootboxName: string | null;
  lootboxCreatorId: string | null;
  stickerCollectionId: string | null;
  pulseEventId: string | null;
  pageName: string | null;
}

// ============================================================
// Баланс
// ============================================================

export interface Balance {
  soft: number;
  hard: number;
  totalHard: number;
  stars: number;
  starsFotWithdraw: number;
  spices: number;
  friendsCount: number;
  luckyBuyCards: number;
  hardLocked: number;
  stackingPoints: number;
  spaceMonkeysPoints: number;
  nanoUSDs: number;
  nanoUSDsLocked: number;
  giftStakingPoints: number;
  bonus: number;
}

// ============================================================
// Коллекции
// ============================================================

export interface Collection {
  name: string;
  title: string;
  modelStickerThumbnailKey: string;
  originalImageKey: string;
  thumbnailImageKey: string;
  createdAt: string;
  floorPriceNanoTons: number | null;
  floorPriceForGamesNanoTons: number | null;
  previousDayFloorPriceNanoTons: number | null;
  volume: number;
  isNew: boolean;
  isNewDate: string;
  cashbackCoef: number | null;
  spiceConvertPrice: number;
  spaceMonkeyPoints: number | null;
  disabledCraftFrom: boolean;
  craftable: boolean;
  isHidden: boolean;
  tgCraftable: boolean;
}

// ============================================================
// Модели
// ============================================================

export interface Model {
  collectionName: string;
  collectionTitle: string;
  modelName: string;
  modelTitle: string;
  modelStickerThumbnailKey: string;
  createdAt: string;
  rarityPerMille: number;
  rarityName: string | null;
  volume: number | null;
  floorPriceNanoTons: number | null;
  cashbackCoef: number | null;
}

export interface ModelsRequest {
  collections: string[];
}

export interface GiftBackdrop {
  collectionName: string;
  backdropName: string;
  colorsCenterColor: number;
  colorsEdgeColor: number;
  rarityPerMille: number;
  rarityName: string | null;
  floorNanoTons: number;
}

export interface BackdropsRequest {
  collections: string[];
}

// ============================================================
// Подарки (Gift)
// ============================================================

export interface Gift {
  id: string;
  exportDate: string;
  receivedDate: string;
  giftId: number;
  giftIdString: string;
  maxUpgradedCount: number;
  totalUpgradedCount: number;
  backdropColorsCenterColor: number;
  backdropColorsEdgeColor: number;
  backdropColorsTextColor: number;
  backdropColorsSymbolColor: number;
  backdropName: string;
  backdropRarityPerMille: number | null;
  backdropRarityName: string | null;
  modelName: string;
  modelRarityPerMille: number | null;
  modelRarityName: string | null;
  modelStickerKey: string;
  modelStickerThumbnailKey: string;
  symbolName: string;
  symbolRarityPerMille: number | null;
  symbolRarityName: string | null;
  symbolStickerKey: string;
  symbolStickerThumbnailKey: string;
  name: string;
  number: number;
  title: string;
  collectionName: string;
  isOnAuction: boolean;
  isOnSale: boolean;
  salePrice: number;
  salePriceWithoutFee: number;
  salesCount: number;
  promoteEndAt: string;
  isMine: boolean;
  isGiveawayReceived: boolean;
  nextResaleDate: string;
  nextTransferDate: string;
  isLocked: boolean;
  isLockedForSale: boolean;
  unlockDate: string;
  nextGiveAvailableAt: string;
  isOnPlatform: boolean;
  premarketStatus: string;
  waitGiftUntil: string | null;
  giftsCollectionId: string | null;
  giftType: string;
  collectionTitle: string;
  modelTitle: string;
  luckyBuy: boolean;
  regularGiftValidation: string;
  validateRegularGiftAt: string | null;
  isSpaceMonkey: boolean;
  returnLockedUntil: string | null;
  returnLockReason: string | null;
  spaceMonkeysPoints: number | null;
  craftable: boolean;
  floorPriceNanoTONsByCollection: number | null;
  floorPriceNanoTONsByBackdropModel: number | null;
  isCrafted: boolean;
  tgCanBeCrafted: boolean;
  minted: boolean;
  staked: boolean;
  stakedByMe: boolean;
  specialGiftBenefitSectionSince: string | null;
  specialGiftBenefitListedSince: string | null;
}

// ============================================================
// Saling (лоты на продажу)
// ============================================================

export interface SalingRequest {
  count: number;
  cursor: string;
  collectionNames: string[];
  modelNames: string[];
  backdropNames: string[];
  symbolNames: string[];
  minPrice: number | null;
  maxPrice: number | null;
  number: number | null;
  isPremarket: boolean | null;
  isNew: boolean | null;
  luckyBuy: boolean | null;
  giftType: string | null;
  craftable: boolean | null;
  isCrafted: boolean | null;
  tgCanBeCraftedFrom: boolean | null;
  removeSelfSales: boolean | null;
  isTransferable: boolean | null;
  availableForStaking: boolean | null;
  forGame: string | null;
  ordering: string;
  lowToHigh: boolean;
  query: string | null;
}

/** Заблокированные лоты на MRKT не купить — не учитываем при парсинге saling. */
export function isLockedListing(gift: Gift): boolean {
  return gift.isLocked === true;
}

export function withoutLockedListings(gifts: Gift[]): Gift[] {
  return gifts.filter((g) => !isLockedListing(g));
}

export interface SalingResponse {
  gifts: Gift[];
  cursor: string | null;
  total: number;
}

// ============================================================
// Feed (история событий)
// ============================================================

export type FeedType = 'Sale' | 'Purchase' | 'Transfer' | 'Give';

export interface FeedRequest {
  count: number;
  cursor: string;
  collectionNames: string[];
  modelNames: string[];
  backdropNames: string[];
  number: number | null;
  type: FeedType[];
  minPrice: number | null;
  maxPrice: number | null;
  ordering: 'Latest' | 'Oldest' | 'Price';
  lowToHigh: boolean;
  query: string | null;
}

export interface FeedItem {
  type: string;
  id: string;
  gift: Gift;
  amount: number;
  date: string;
}

export interface FeedResponse {
  items: FeedItem[];
  cursor: string | null;
}