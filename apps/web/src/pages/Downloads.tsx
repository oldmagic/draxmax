import { useQuery } from '@tanstack/react-query';
import {
  Download,
  LayoutGrid,
  List,
  Pause,
  Play,
  Plus,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, type MouseEvent } from 'react';
import type { TorrentDTO, TorrentStatus } from '@draxmax/shared';
import { CategoryDialog } from '@/components/torrents/CategoryDialog';
import { DetailSheet } from '@/components/torrents/DetailSheet';
import { RemoveDialog } from '@/components/torrents/RemoveDialog';
import { MoveDialog } from '@/components/torrents/MoveDialog';
import { TorrentCard, TorrentRow } from '@/components/torrents/TorrentRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { formatSpeed } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDownloadsUi, type StatusFilter } from '@/stores/downloads';
import { useTorrents } from '@/stores/torrents';
import { useUi } from '@/stores/ui';

const FILTERS: { id: StatusFilter; label: string; match: (s: TorrentStatus) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  {
    id: 'active',
    label: 'Active',
    match: (s) => s === 'downloading' || s === 'metadata' || s === 'checking',
  },
  { id: 'downloading', label: 'Downloading', match: (s) => s === 'downloading' },
  { id: 'seeding', label: 'Seeding', match: (s) => s === 'seeding' },
  { id: 'queued', label: 'Queued', match: (s) => s === 'queued' },
  { id: 'paused', label: 'Paused', match: (s) => s === 'paused' },
  { id: 'error', label: 'Errors', match: (s) => s === 'error' },
];

const selectClass =
  'h-10 rounded-xl border bg-surface-2 px-3 text-sm text-fg focus:border-accent focus:outline-none';

export function DownloadsPage() {
  const torrents = useTorrents((s) => s.torrents);
  const connection = useTorrents((s) => s.connection);
  const openAdd = useUi((s) => s.openAdd);
  const ui = useDownloadsUi();
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.id, torrents.filter((t) => f.match(t.status)).length]),
      ),
    [torrents],
  );
  const allTags = useMemo(() => [...new Set(torrents.flatMap((t) => t.tags))].sort(), [torrents]);
  const visible = useMemo(() => {
    const q = ui.query.trim().toLowerCase();
    const match = FILTERS.find((f) => f.id === ui.status)!.match;
    return torrents.filter(
      (t) =>
        match(t.status) &&
        (ui.category === null || (ui.category === '' ? !t.category : t.category === ui.category)) &&
        (ui.tag === null || t.tags.includes(ui.tag)) &&
        (!q || t.name.toLowerCase().includes(q) || t.infoHash.startsWith(q)),
    );
  }, [torrents, ui.status, ui.category, ui.tag, ui.query]);
  const visibleIds = useMemo(() => visible.map((t) => t.id), [visible]);
  const selected = useMemo(
    () => torrents.filter((t) => ui.selected.has(t.id)),
    [torrents, ui.selected],
  );
  const down = torrents.reduce((s, t) => s + t.downloadSpeed, 0);
  const up = torrents.reduce((s, t) => s + t.uploadSpeed, 0);

  const onRowClick = useCallback(
    (e: MouseEvent, t: TorrentDTO) => {
      const s = useDownloadsUi.getState();
      if (e.shiftKey) s.selectRange(visibleIds, t.id);
      else if (e.metaKey || e.ctrlKey) s.toggle(t.id);
      else s.selectOnly(t.id);
    },
    [visibleIds],
  );
  /** A context action targets the selection if the row is part of it, else just the row. */
  const targetsFor = (t: TorrentDTO) => () => {
    const sel = useDownloadsUi.getState().selected;
    const list = useTorrents.getState().torrents;
    return sel.has(t.id) && sel.size > 1 ? list.filter((x) => sel.has(x.id)) : [t];
  };

  // Keyboard: Ctrl/Cmd+A select all, Delete remove, Esc clear, Enter details.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
        )
      )
        return;
      const s = useDownloadsUi.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        s.setSelection(visibleIds);
      } else if (e.key === 'Escape') s.clearSelection();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected.size > 0)
        s.askRemove([...s.selected]);
      else if (e.key === 'Enter' && s.selected.size === 1) s.openDetail([...s.selected][0]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleIds]);

  // Drop selections of torrents that disappeared.
  useEffect(() => {
    const ids = new Set(torrents.map((t) => t.id));
    const s = useDownloadsUi.getState();
    if ([...s.selected].some((id) => !ids.has(id)))
      s.setSelection([...s.selected].filter((id) => ids.has(id)));
  }, [torrents]);

  const allVisibleSelected = visible.length > 0 && visible.every((t) => ui.selected.has(t.id));
  const Item = ui.view === 'cards' ? TorrentCard : TorrentRow;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Downloads</h1>
          <p className="mt-1 text-sm text-muted tabular">
            {torrents.length} torrent{torrents.length === 1 ? '' : 's'} · ↓ {formatSpeed(down)} · ↑{' '}
            {formatSpeed(up)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={ui.query}
              onChange={(e) => ui.setFilter({ query: e.target.value })}
              placeholder="Search"
              aria-label="Search torrents"
              className="w-40 pl-9 sm:w-56"
            />
          </div>
          <select
            aria-label="Filter by category"
            className={selectClass}
            value={ui.category ?? '__all'}
            onChange={(e) =>
              ui.setFilter({ category: e.target.value === '__all' ? null : e.target.value })
            }
          >
            <option value="__all">All categories</option>
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          {allTags.length > 0 && (
            <select
              aria-label="Filter by tag"
              className={selectClass}
              value={ui.tag ?? ''}
              onChange={(e) => ui.setFilter({ tag: e.target.value || null })}
            >
              <option value="">All tags</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          )}
          <div
            role="radiogroup"
            aria-label="View"
            className="flex rounded-xl border bg-surface-2 p-0.5"
          >
            {(
              [
                ['list', List, 'List view'],
                ['cards', LayoutGrid, 'Card view'],
              ] as const
            ).map(([v, Icon, label]) => (
              <Tooltip key={v} content={label}>
                <button
                  role="radio"
                  aria-checked={ui.view === v}
                  aria-label={label}
                  onClick={() => ui.setView(v)}
                  className={cn(
                    'rounded-lg p-2 transition-colors',
                    ui.view === v ? 'bg-bg text-fg shadow-sm' : 'text-muted hover:text-fg',
                  )}
                >
                  <Icon className="size-4" />
                </button>
              </Tooltip>
            ))}
          </div>
          <Button variant="primary" onClick={() => openAdd()}>
            <Plus /> Add
          </Button>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <input
          type="checkbox"
          aria-label="Select all visible torrents"
          checked={allVisibleSelected}
          onChange={() => (allVisibleSelected ? ui.clearSelection() : ui.setSelection(visibleIds))}
          className="mr-2 ml-3 size-4 accent-[var(--accent)]"
          disabled={visible.length === 0}
        />
        <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={ui.status === f.id}
              onClick={() => ui.setFilter({ status: f.id })}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                ui.status === f.id ? 'bg-fg text-bg' : 'bg-surface-2 text-muted hover:text-fg',
              )}
            >
              {f.label}
              <span className="ml-1.5 opacity-60 tabular">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="glass relative min-h-0 flex-1 overflow-y-auto rounded-2xl p-2">
        {torrents.length === 0 ? (
          <EmptyState loading={connection === 'connecting'} onAdd={() => openAdd()} />
        ) : visible.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">No torrents match these filters.</p>
        ) : (
          <ul
            aria-label="Torrents"
            aria-multiselectable
            className={cn(
              ui.view === 'cards'
                ? 'grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3 p-1'
                : 'divide-y divide-border/60',
            )}
          >
            <AnimatePresence initial={false}>
              {visible.map((t) => (
                <Item
                  key={t.id}
                  torrent={t}
                  selected={ui.selected.has(t.id)}
                  targets={targetsFor(t)}
                  onClick={onRowClick}
                  onToggle={(x) => ui.toggle(x.id)}
                  onOpen={(x) => ui.openDetail(x.id)}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      <BulkBar selected={selected} />
      <DetailSheet />
      <RemoveDialog />
      <CategoryDialog />
      <MoveDialog />
    </div>
  );
}

function BulkBar({ selected }: { selected: TorrentDTO[] }) {
  const ui = useDownloadsUi();
  const ids = selected.map((t) => t.id);
  return (
    <AnimatePresence>
      {selected.length > 1 && (
        <motion.div
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          role="toolbar"
          aria-label="Bulk actions"
          className="glass fixed bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-2xl !bg-bg/90 p-1.5 md:bottom-6"
        >
          <span className="px-3 text-sm font-medium tabular">{selected.length} selected</span>
          <Button size="sm" variant="ghost" onClick={() => void actions.resume(ids)}>
            <Play /> Resume
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void actions.pause(ids)}>
            <Pause /> Pause
          </Button>
          <Button size="sm" variant="ghost" onClick={() => ui.askCategory(ids)}>
            <Tag /> Category
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => ui.askRemove(ids)}
          >
            <Trash2 /> Remove
          </Button>
          <Tooltip content="Clear selection (Esc)">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection"
              onClick={ui.clearSelection}
            >
              <X />
            </Button>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function EmptyState({ loading, onAdd }: { loading: boolean; onAdd(): void }) {
  if (loading) return <p className="p-10 text-center text-sm text-muted">Connecting…</p>;
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent-2/20">
        <Download className="size-7 text-accent" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">No torrents yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Paste a magnet link anywhere, drop a <span className="font-medium text-fg">.torrent</span>{' '}
          file onto this window, or use the button below.
        </p>
      </div>
      <Button variant="primary" onClick={onAdd}>
        <Plus /> Add your first torrent
      </Button>
    </div>
  );
}
