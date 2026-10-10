import { create } from 'zustand';
import type { RuleInput } from '@draxmax/shared';

interface UiState {
  addOpen: boolean;
  addPrefill: string;
  shortcutsOpen: boolean;
  /** A prefilled, unsaved rule waiting to be opened in the rule editor ("Follow"). */
  ruleDraft: RuleInput | null;
  openAdd(prefill?: string): void;
  closeAdd(): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  followShow(draft: RuleInput): void;
}

export const useUi = create<UiState>((set) => ({
  addOpen: false,
  addPrefill: '',
  shortcutsOpen: false,
  ruleDraft: null,
  openAdd: (prefill = '') => set({ addOpen: true, addPrefill: prefill }),
  closeAdd: () => set({ addOpen: false, addPrefill: '' }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  followShow: (draft) => set({ ruleDraft: draft }),
}));
