import { create } from 'zustand';

export type ViewMode = 'list' | 'cards';
export type StatusFilter =
  'all' | 'active' | 'downloading' | 'seeding' | 'paused' | 'queued' | 'error';

function readView(): ViewMode {
  try {
    return localStorage.getItem('draxmax-view') === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

interface DownloadsUi {
  view: ViewMode;
  status: StatusFilter;
  category: string | null;
  tag: string | null;
  query: string;
  selected: Set<string>;
  /** Selection anchor for shift-click ranges. */
  anchor: string | null;
  detailId: string | null;
  detailTab: string;
  removeIds: string[] | null;
  categoryIds: string[] | null;
  moveIds: string[] | null;
  setView(v: ViewMode): void;
  setFilter(p: Partial<Pick<DownloadsUi, 'status' | 'category' | 'tag' | 'query'>>): void;
  toggle(id: string): void;
  selectOnly(id: string): void;
  selectRange(ids: string[], to: string): void;
  setSelection(ids: string[]): void;
  clearSelection(): void;
  openDetail(id: string, tab?: string): void;
  closeDetail(): void;
  askRemove(ids: string[] | null): void;
  askCategory(ids: string[] | null): void;
  askMove(ids: string[] | null): void;
}

export const useDownloadsUi = create<DownloadsUi>((set, get) => ({
  view: readView(),
  status: 'all',
  category: null,
  tag: null,
  query: '',
  selected: new Set(),
  anchor: null,
  detailId: null,
  detailTab: 'general',
  removeIds: null,
  categoryIds: null,
  moveIds: null,
  setView: (view) => {
    try {
      localStorage.setItem('draxmax-view', view);
    } catch {
      // Preference not persisted.
    }
    set({ view });
  },
  setFilter: (p) => set(p),
  toggle: (id) =>
    set((s) => {
      const selected = new Set(s.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { selected, anchor: id };
    }),
  selectOnly: (id) => set({ selected: new Set([id]), anchor: id }),
  selectRange: (ids, to) => {
    const from = get().anchor;
    const a = from ? ids.indexOf(from) : -1;
    const b = ids.indexOf(to);
    if (a === -1 || b === -1) return set({ selected: new Set([to]), anchor: to });
    const [lo, hi] = a < b ? [a, b] : [b, a];
    set({ selected: new Set(ids.slice(lo, hi + 1)) });
  },
  setSelection: (ids) => set({ selected: new Set(ids) }),
  clearSelection: () => set({ selected: new Set(), anchor: null }),
  openDetail: (detailId, detailTab = 'general') => set({ detailId, detailTab }),
  closeDetail: () => set({ detailId: null }),
  askRemove: (removeIds) => set({ removeIds }),
  askCategory: (categoryIds) => set({ categoryIds }),
  askMove: (moveIds) => set({ moveIds }),
}));
