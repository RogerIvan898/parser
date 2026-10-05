import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  /** Для axios; задаётся через VITE_API_BASE, в UI не редактируется */
  apiBase: string;
  defaultDays: number;
  /** Доля комиссии 0–1 (в настройках показываем проценты) */
  defaultFeeRate: number;
  setDefaultDays: (v: number) => void;
  setDefaultFeeRate: (v: number) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      apiBase: import.meta.env.VITE_API_BASE || '/api',
      defaultDays: 7,
      defaultFeeRate: 0.02,
      setDefaultDays: (v) => set({ defaultDays: v }),
      setDefaultFeeRate: (v) => set({ defaultFeeRate: v }),
    }),
    { name: 'mrkt-admin-settings' },
  ),
);

export function feePercentFromRate(rate: number): number {
  return Math.round(rate * 1000) / 10;
}

export function feeRateFromPercent(percent: number): number {
  const p = Math.min(100, Math.max(0, percent));
  return p / 100;
}