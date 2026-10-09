import { create } from 'zustand';

interface UiState {
  addOpen: boolean;
  addPrefill: string;
  shortcutsOpen: boolean;
  openAdd(prefill?: string): void;
  closeAdd(): void;
  openShortcuts(): void;
  closeShortcuts(): void;
}

export const useUi = create<UiState>((set) => ({
  addOpen: false,
  addPrefill: '',
  shortcutsOpen: false,
  openAdd: (prefill = '') => set({ addOpen: true, addPrefill: prefill }),
  closeAdd: () => set({ addOpen: false, addPrefill: '' }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
}));
