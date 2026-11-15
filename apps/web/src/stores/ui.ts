import { toast } from 'sonner';
import { create } from 'zustand';
import type { RuleInput } from '@draxmax/shared';

interface UiState {
  addOpen: boolean;
  addPrefill: string;
  /** Picked or dropped .torrent files, waiting in the add dialog until the user confirms. */
  addFiles: File[];
  shortcutsOpen: boolean;
  /** A prefilled, unsaved rule waiting to be opened in the rule editor ("Follow"). */
  ruleDraft: RuleInput | null;
  openAdd(prefill?: string): void;
  closeAdd(): void;
  /** Queues .torrent files for the add dialog (skipping others and repeats); adds nothing yet. */
  stageFiles(files: File[]): void;
  unstageFile(file: File): void;
  setStagedFiles(files: File[]): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  followShow(draft: RuleInput): void;
}

/** Picking the same file twice shouldn't list it twice (lastModified isn't always stable). */
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size;

export const useUi = create<UiState>((set) => ({
  addOpen: false,
  addPrefill: '',
  addFiles: [],
  shortcutsOpen: false,
  ruleDraft: null,
  openAdd: (prefill = '') => set({ addOpen: true, addPrefill: prefill }),
  closeAdd: () => set({ addOpen: false, addPrefill: '', addFiles: [] }),
  stageFiles: (files) =>
    set((s) => {
      const next = [...s.addFiles];
      for (const f of files) {
        if (!f.name.toLowerCase().endsWith('.torrent')) {
          toast.warning(`Skipped ${f.name}`, { description: 'Only .torrent files can be added.' });
        } else if (!next.some((x) => sameFile(x, f))) next.push(f);
      }
      return { addFiles: next };
    }),
  unstageFile: (file) => set((s) => ({ addFiles: s.addFiles.filter((f) => f !== file) })),
  setStagedFiles: (files) => set({ addFiles: files }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  followShow: (draft) => set({ ruleDraft: draft }),
}));
