import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { useDownloadsUi } from '@/stores/downloads';
import { useTorrents } from '@/stores/torrents';

export function CategoryDialog() {
  const ids = useDownloadsUi((s) => s.categoryIds);
  const close = () => useDownloadsUi.getState().askCategory(null);
  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Set category"
        description={
          ids && ids.length > 1
            ? `${ids.length} torrents`
            : 'Pick an existing category or type a new one.'
        }
      >
        {ids && <CategoryForm ids={ids} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function CategoryForm({ ids, onDone }: { ids: string[]; onDone(): void }) {
  const current = useTorrents((s) => s.torrents.find((t) => t.id === ids[0])?.category ?? '');
  const [value, setValue] = useState(current);
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });

  async function apply(category: string | null) {
    await actions.update(ids, { category });
    onDone();
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void apply(value.trim() || null);
      }}
    >
      <Input
        list="draxmax-categories"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. Movies"
        autoFocus
      />
      <datalist id="draxmax-categories">
        {categories.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => setValue(c.name)}
              className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted hover:text-fg"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={() => void apply(null)}>
          Clear category
        </Button>
        <Button type="submit" variant="primary">
          Apply
        </Button>
      </div>
    </form>
  );
}
