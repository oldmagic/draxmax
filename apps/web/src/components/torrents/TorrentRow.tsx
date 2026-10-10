import { ArrowDown, ArrowUp, Folder, MoreHorizontal, Pause, Play, Users } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import type { MouseEvent } from 'react';
import type { TorrentDTO } from '@draxmax/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ContextMenu } from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  MenuActions,
} from '@/components/ui/menu';
import { ProgressBar, ProgressRing } from '@/components/ui/progress';
import { Tooltip } from '@/components/ui/tooltip';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { formatBytes, formatEta, formatPercent, formatSpeed, shortPath } from '@/lib/format';
import { STATUS_META } from '@/lib/status';
import { cn } from '@/lib/utils';
import { torrentActions } from './torrent-actions';

interface Props {
  torrent: TorrentDTO;
  selected: boolean;
  /** Torrents a context action applies to: the selection if this row is in it, else just this row. */
  targets: () => TorrentDTO[];
  onClick(e: MouseEvent, t: TorrentDTO): void;
  onToggle(t: TorrentDTO): void;
  onOpen(t: TorrentDTO): void;
}

const stopped = (t: TorrentDTO) => t.status === 'paused' || t.status === 'error';

function Meta({ t }: { t: TorrentDTO }) {
  const meta = STATUS_META[t.status];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge tone={meta.badge} className="shrink-0">
        {meta.label}
      </Badge>
      {t.private && <Badge tone="muted">Private</Badge>}
      {t.category && <Badge tone="info">{t.category}</Badge>}
      {t.tags.map((tag) => (
        <Badge key={tag} tone="muted">
          #{tag}
        </Badge>
      ))}
    </div>
  );
}

/** Seconds of seeding left before the torrent is removed, or null without a limit. */
function useSeedTimeLeft(t: TorrentDTO): number | null {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const limit = Number(data?.settings.seedTimeLimitMinutes ?? 0) * 60;
  if (!limit || !t.completedAt) return null;
  return Math.max(0, limit - t.seedingTime);
}

/** Folder the torrent's data is saved in (full path on hover). */
function SavePath({ t, className }: { t: TorrentDTO; className?: string }) {
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1 text-xs text-muted', className)}
      title={t.savePath}
    >
      <Folder className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">Saved in </span>
      <span className="truncate font-mono">{shortPath(t.savePath)}</span>
    </span>
  );
}

function PauseButton({ t }: { t: TorrentDTO }) {
  const s = stopped(t);
  return (
    <Tooltip content={s ? 'Resume' : 'Pause'}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={s ? `Resume ${t.name}` : `Pause ${t.name}`}
        onClick={(e) => {
          e.stopPropagation();
          void (s ? actions.resume([t.id]) : actions.pause([t.id]));
        }}
      >
        {s ? <Play /> : <Pause />}
      </Button>
    </Tooltip>
  );
}

function MoreMenu({ t, targets }: { t: TorrentDTO; targets: () => TorrentDTO[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`More actions for ${t.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <MenuActions actions={torrentActions(targets())} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Checkbox({
  t,
  selected,
  onToggle,
}: {
  t: TorrentDTO;
  selected: boolean;
  onToggle(t: TorrentDTO): void;
}) {
  return (
    <input
      type="checkbox"
      checked={selected}
      aria-label={`Select ${t.name}`}
      onClick={(e) => e.stopPropagation()}
      onChange={() => onToggle(t)}
      className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
    />
  );
}

/** Dense list row. */
export function TorrentRow({ torrent: t, selected, targets, onClick, onToggle, onOpen }: Props) {
  const meta = STATUS_META[t.status];
  const done = Math.round(t.progress * t.totalSize);
  const seedLeft = useSeedTimeLeft(t);
  return (
    <ContextMenu actions={torrentActions(targets())}>
      <motion.li
        layout="position"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -24, transition: { duration: 0.18 } }}
        onClick={(e) => onClick(e, t)}
        onDoubleClick={() => onOpen(t)}
        aria-selected={selected}
        className={cn(
          'group grid cursor-default grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 rounded-2xl px-3 py-3 transition-colors lg:grid-cols-[auto_minmax(0,1fr)_7rem_7rem_5rem_auto]',
          selected ? 'bg-accent/10 ring-1 ring-accent/30' : 'hover:bg-surface-hover',
        )}
      >
        <Checkbox t={t} selected={selected} onToggle={onToggle} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-medium" title={t.name}>
              {t.name}
            </h3>
          </div>
          <div className="mt-1">
            <Meta t={t} />
          </div>
          <ProgressBar
            value={t.progress}
            tone={meta.bar}
            className="mt-2"
            label={`${t.name} progress`}
          />
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted tabular">
            <span>
              {formatPercent(t.progress)}
              {t.totalSize > 0 && ` · ${formatBytes(done)} of ${formatBytes(t.totalSize)}`}
            </span>
            {t.status === 'error' && t.error && (
              <span className="truncate text-danger">{t.error}</span>
            )}
            <span className="lg:hidden">
              ↓ {formatSpeed(t.downloadSpeed)} · ↑ {formatSpeed(t.uploadSpeed)}
            </span>
            {seedLeft !== null && (
              <span className="lg:hidden">seeds {formatEta(seedLeft)} more</span>
            )}
            <SavePath t={t} className="max-w-full" />
          </div>
        </div>
        <div className="hidden text-xs tabular lg:block">
          <div className="flex items-center gap-1.5 text-fg">
            <ArrowDown className="size-3.5 text-accent" />
            {formatSpeed(t.downloadSpeed)}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-muted">
            <ArrowUp className="size-3.5 text-success" />
            {formatSpeed(t.uploadSpeed)}
          </div>
        </div>
        <div className="hidden text-xs tabular lg:block">
          {seedLeft !== null ? (
            <div className="text-fg" title="Seeding time left before it's removed from the list">
              {formatEta(seedLeft)} <span className="text-muted">to seed</span>
            </div>
          ) : (
            <div className="text-fg">{t.status === 'downloading' ? formatEta(t.eta) : '—'}</div>
          )}
          <div className="mt-1 text-muted">ratio {t.ratio.toFixed(2)}</div>
        </div>
        <div className="hidden items-center gap-1.5 text-xs text-muted tabular lg:flex">
          <Users className="size-3.5" />
          {t.peers}
          {t.seeds > 0 && <span className="text-success">({t.seeds})</span>}
        </div>
        <div className="flex items-center gap-1">
          <PauseButton t={t} />
          <MoreMenu t={t} targets={targets} />
        </div>
      </motion.li>
    </ContextMenu>
  );
}

/** Card for the grid view. */
export function TorrentCard({ torrent: t, selected, targets, onClick, onToggle, onOpen }: Props) {
  const meta = STATUS_META[t.status];
  return (
    <ContextMenu actions={torrentActions(targets())}>
      <motion.li
        layout="position"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
        onClick={(e) => onClick(e, t)}
        onDoubleClick={() => onOpen(t)}
        aria-selected={selected}
        className={cn(
          'flex cursor-default flex-col gap-3 rounded-2xl border bg-surface-2 p-4 transition-all hover:-translate-y-0.5 hover:shadow-glass',
          selected && 'border-accent/50 bg-accent/10',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="relative grid shrink-0 place-items-center">
            <ProgressRing value={t.progress} size={48} stroke={4} tone={meta.bar} />
            <span className="absolute text-[10px] font-semibold tabular">
              {Math.floor(t.progress * 100)}%
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-medium" title={t.name}>
              {t.name}
            </h3>
            <div className="mt-1.5">
              <Meta t={t} />
            </div>
            <SavePath t={t} className="mt-1.5" />
          </div>
          <Checkbox t={t} selected={selected} onToggle={onToggle} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs tabular">
          <div>
            <div className="text-muted">Down</div>
            <div className="text-fg">{formatSpeed(t.downloadSpeed)}</div>
          </div>
          <div>
            <div className="text-muted">Up</div>
            <div className="text-fg">{formatSpeed(t.uploadSpeed)}</div>
          </div>
          <div>
            <div className="text-muted">{t.status === 'downloading' ? 'ETA' : 'Size'}</div>
            <div className="text-fg">
              {t.status === 'downloading' ? formatEta(t.eta) : formatBytes(t.totalSize)}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted tabular">
            <Users className="size-3.5" /> {t.peers} peers
          </span>
          <div className="flex items-center gap-1">
            <PauseButton t={t} />
            <MoreMenu t={t} targets={targets} />
          </div>
        </div>
      </motion.li>
    </ContextMenu>
  );
}
