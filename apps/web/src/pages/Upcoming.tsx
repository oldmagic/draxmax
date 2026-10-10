import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  EyeOff,
  Film,
  KeyRound,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tv,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link, useLocation } from 'wouter';
import type { LibraryEntryDTO, UpcomingItemDTO } from '@draxmax/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type TypeFilter = 'all' | 'movie' | 'tv' | 'anime';
type StatusFilter = 'all' | 'upcoming' | 'airing' | 'released';
type Sort = 'relevance' | 'date' | 'popularity';

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  upcoming: { label: 'Upcoming', tone: 'info' },
  airing: { label: 'Airing', tone: 'accent' },
  released: { label: 'Out now', tone: 'success' },
};
const TYPE_LABEL = { movie: 'Movie', tv: 'TV', anime: 'Anime' } as const;

function formatDate(d?: string): string {
  if (!d) return 'TBA';
  const t = Date.parse(d);
  if (Number.isNaN(t)) return d;
  const days = Math.round((t - Date.now()) / 86_400_000);
  const label = new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (days === 0) return `Today · ${label}`;
  if (days > 0 && days <= 30) return `In ${days} day${days === 1 ? '' : 's'} · ${label}`;
  return label;
}

/** The search query for "Search & Add", e.g. "The Expanse S05". */
function searchQuery(i: UpcomingItemDTO): string {
  if (i.type === 'movie')
    return `${i.title}${i.releaseDate ? ` ${i.releaseDate.slice(0, 4)}` : ''}`;
  if (i.season && i.episode)
    return `${i.title} S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}`;
  if (i.season) return `${i.title} S${String(i.season).padStart(2, '0')}`;
  if (i.type === 'anime' && i.episode) return `${i.title} ${String(i.episode).padStart(2, '0')}`;
  return i.title;
}

export function UpcomingPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery({ queryKey: ['upcoming'], queryFn: api.upcoming });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [tab, setTab] = useState('foryou');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const refresh = useMutation({
    mutationFn: api.refreshUpcoming,
    onSuccess: (d) => qc.setQueryData(['upcoming'], d),
  });

  async function act(item: UpcomingItemDTO, action: 'ignore' | 'have') {
    try {
      qc.setQueryData(['upcoming'], await api.upcomingAction(item.id, action));
      toast(action === 'ignore' ? 'Hidden' : 'Marked as owned', {
        description: item.title,
        action: {
          label: 'Undo',
          onClick: () =>
            void api.upcomingAction(item.id, 'reset').then((d) => qc.setQueryData(['upcoming'], d)),
        },
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function searchAndAdd(item: UpcomingItemDTO) {
    const q = searchQuery(item);
    const template = String(settings?.settings.searchUrlTemplate ?? '');
    if (template) {
      window.open(
        template.replace('{query}', encodeURIComponent(q)),
        '_blank',
        'noopener,noreferrer',
      );
    } else {
      navigate(
        `/search?q=${encodeURIComponent(q)}&type=${item.type === 'movie' ? 'movies' : item.type}`,
      );
    }
  }

  const busy = data?.refreshing || refresh.isPending;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Upcoming</h1>
          <p className="mt-1 text-sm text-muted">
            {data?.updatedAt
              ? `Updated ${new Date(data.updatedAt).toLocaleString()}`
              : 'Not refreshed yet'}
            {data && (
              <>
                {' · '}
                TMDB {data.sources.tmdb ? 'on' : 'off'} · AniList{' '}
                {data.sources.anilist ? 'on' : 'off'}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setLibraryOpen(true)}>
            <Library /> Library
          </Button>
          <Button variant="primary" onClick={() => refresh.mutate()} disabled={busy}>
            <RefreshCw className={cn(busy && 'animate-spin')} /> {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {data && !data.sources.tmdb && (
        <div className="glass mb-4 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-sm">
          <KeyRound className="size-5 text-accent" />
          <span className="min-w-0 flex-1">
            Add a free TMDB API key to get movies and TV shows. Anime from AniList works without a
            key.
          </span>
          <a
            href="https://www.themoviedb.org/settings/api"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent hover:underline"
          >
            Get a free key
          </a>
          <Link href="/settings" className="font-medium text-accent hover:underline">
            Open settings
          </Link>
        </div>
      )}
      {data?.errors.length ? (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-2xl bg-warning/10 px-4 py-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{data.errors.join(' · ')}</span>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList
          className="mb-4 max-w-sm"
          items={[
            { value: 'foryou', label: `For You${data ? ` (${data.forYou.length})` : ''}` },
            { value: 'new', label: `New Releases${data ? ` (${data.newReleases.length})` : ''}` },
          ]}
        />
        <TabsContent value="foryou" className="min-h-0 flex-1 overflow-y-auto">
          {isLoading || (busy && !data?.updatedAt) ? (
            <Loading />
          ) : data && data.forYou.length > 0 ? (
            <Grid items={data.forYou} onAct={act} onSearch={searchAndAdd} showReason />
          ) : (
            <Empty
              icon={<Sparkles className="size-7 text-accent" />}
              title="Nothing new for your library yet"
              text="DraxMax looks at your downloads (and optional media folders) to find next seasons, sequels and collection entries. Add some shows or movies, or a TMDB key, then refresh."
            />
          )}
        </TabsContent>
        <TabsContent value="new" className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <Loading />
          ) : (
            <NewReleases items={data?.newReleases ?? []} onAct={act} onSearch={searchAndAdd} />
          )}
        </TabsContent>
      </Tabs>

      <LibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 p-16 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> Looking up releases…
    </div>
  );
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="glass flex flex-col items-center gap-3 rounded-2xl p-12 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent-2/20">
        {icon}
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-md text-sm text-muted">{text}</p>
    </div>
  );
}

function NewReleases(props: {
  items: UpcomingItemDTO[];
  onAct(i: UpcomingItemDTO, a: 'ignore' | 'have'): void;
  onSearch(i: UpcomingItemDTO): void;
}) {
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<Sort>('relevance');
  const [query, setQuery] = useState('');
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = props.items.filter(
      (i) =>
        (type === 'all' || i.type === type) &&
        (status === 'all' || i.status === status) &&
        (!q || i.title.toLowerCase().includes(q)),
    );
    const by: Record<Sort, (a: UpcomingItemDTO, b: UpcomingItemDTO) => number> = {
      relevance: (a, b) => b.relevanceScore - a.relevanceScore,
      date: (a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999'),
      popularity: (a, b) => b.popularity - a.popularity,
    };
    return [...list].sort(by[sort]);
  }, [props.items, type, status, sort, query]);
  const select =
    'h-9 rounded-xl border bg-surface-2 px-3 text-sm focus:border-accent focus:outline-none';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter titles"
            aria-label="Filter titles"
            className="h-9 w-48 pl-9"
          />
        </div>
        <select
          aria-label="Type"
          className={select}
          value={type}
          onChange={(e) => setType(e.target.value as TypeFilter)}
        >
          <option value="all">All types</option>
          <option value="movie">Movies</option>
          <option value="tv">TV</option>
          <option value="anime">Anime</option>
        </select>
        <select
          aria-label="Status"
          className={select}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="all">Any status</option>
          <option value="upcoming">Upcoming</option>
          <option value="airing">Airing</option>
          <option value="released">Out now</option>
        </select>
        <select
          aria-label="Sort by"
          className={select}
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="relevance">Most relevant</option>
          <option value="date">Release date</option>
          <option value="popularity">Most popular</option>
        </select>
      </div>
      {items.length ? (
        <Grid items={items} onAct={props.onAct} onSearch={props.onSearch} />
      ) : (
        <Empty
          icon={<Film className="size-7 text-accent" />}
          title="No releases"
          text="Nothing matches these filters, or no source is configured yet."
        />
      )}
    </div>
  );
}

function Grid({
  items,
  onAct,
  onSearch,
  showReason,
}: {
  items: UpcomingItemDTO[];
  onAct(i: UpcomingItemDTO, a: 'ignore' | 'have'): void;
  onSearch(i: UpcomingItemDTO): void;
  showReason?: boolean;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4 pb-4">
      {items.map((i, idx) => (
        <motion.li
          key={i.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(idx, 12) * 0.025 }}
          className="glass group flex flex-col overflow-hidden rounded-2xl"
        >
          <div className="relative aspect-[2/3] max-h-80 overflow-hidden bg-surface-2">
            {i.posterUrl ? (
              <img
                src={i.posterUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="grid size-full place-items-center text-muted">
                {i.type === 'movie' ? <Film className="size-10" /> : <Tv className="size-10" />}
              </div>
            )}
            <div className="absolute left-2 top-2 flex gap-1">
              <Badge tone="muted" className="!bg-black/60 !text-white backdrop-blur">
                {TYPE_LABEL[i.type]}
              </Badge>
              {i.status && STATUS[i.status] && (
                <Badge tone="muted" className="!bg-black/60 !text-white backdrop-blur">
                  {STATUS[i.status]!.label}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3.5">
            <div>
              <h3 className="line-clamp-2 font-semibold leading-snug" title={i.title}>
                {i.title}
                {i.season && !i.episode ? (
                  <span className="font-normal text-muted"> · Season {i.season}</span>
                ) : null}
              </h3>
              <div className="mt-0.5 text-xs text-muted tabular">{formatDate(i.releaseDate)}</div>
            </div>
            {showReason && i.reason && (
              <p className="rounded-lg bg-accent/10 px-2 py-1.5 text-xs text-fg">{i.reason}</p>
            )}
            {i.overview && <p className="line-clamp-3 text-xs text-muted">{i.overview}</p>}
            <div className="mt-auto flex items-center gap-1 pt-1">
              <Button size="sm" variant="primary" className="flex-1" onClick={() => onSearch(i)}>
                <Search /> Search & Add
              </Button>
              <Tooltip content="Already have">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Already have ${i.title}`}
                  onClick={() => onAct(i, 'have')}
                >
                  <Check />
                </Button>
              </Tooltip>
              <Tooltip content="Ignore">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Ignore ${i.title}`}
                  onClick={() => onAct(i, 'ignore')}
                >
                  <EyeOff />
                </Button>
              </Tooltip>
            </div>
          </div>
        </motion.li>
      ))}
    </ul>
  );
}

function LibraryDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const { data: entries = [], isFetching } = useQuery({
    queryKey: ['library'],
    queryFn: api.library,
    enabled: open,
  });
  const [title, setTitle] = useState('');
  const [type, setType] = useState<LibraryEntryDTO['type']>('tv');
  const [season, setSeason] = useState('');
  const set = (list: LibraryEntryDTO[]) => qc.setQueryData(['library'], list);

  async function add() {
    if (!title.trim()) return;
    try {
      await api.addLibraryEntry({
        title: title.trim(),
        type,
        seasonsOwned: season ? [Number(season)] : [],
      });
      setTitle('');
      setSeason('');
      void qc.invalidateQueries({ queryKey: ['library'] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Your library"
        description="What DraxMax knows you have. Hidden entries are ignored for recommendations."
        className="w-[min(94vw,44rem)]"
      >
        <form
          className="mb-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a title you own"
            aria-label="Title"
            className="h-9 min-w-48 flex-1"
          />
          <select
            aria-label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as LibraryEntryDTO['type'])}
            className="h-9 rounded-xl border bg-surface-2 px-3 text-sm"
          >
            <option value="tv">TV</option>
            <option value="movie">Movie</option>
            <option value="anime">Anime</option>
          </select>
          {type !== 'movie' && (
            <Input
              type="number"
              min={1}
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              placeholder="Season"
              aria-label="Season owned"
              className="h-9 w-24"
            />
          )}
          <Button type="submit" size="sm" className="h-9">
            <Plus /> Add
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => void api.rescanLibrary().then(set)}
          >
            <RefreshCw className={cn(isFetching && 'animate-spin')} /> Rescan
          </Button>
        </form>
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
          {entries.map((e) => (
            <li
              key={e.id}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-surface-hover',
                e.hidden && 'opacity-50',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {e.title}
                  {e.year ? <span className="text-muted"> ({e.year})</span> : null}
                </div>
                <div className="text-xs text-muted">
                  {TYPE_LABEL[e.type as keyof typeof TYPE_LABEL] ?? 'Other'}
                  {e.seasonsOwned.length ? ` · seasons ${e.seasonsOwned.join(', ')}` : ''} ·{' '}
                  {e.source}
                  {e.tmdbId || e.anilistId ? ' · linked' : ''}
                </div>
              </div>
              <Switch
                label={`Use ${e.title} for recommendations`}
                checked={!e.hidden}
                onChange={(v) =>
                  void api
                    .setLibraryHidden(e.id, !v)
                    .then(() => qc.invalidateQueries({ queryKey: ['library'] }))
                }
              />
            </li>
          ))}
          {entries.length === 0 && (
            <li className="p-6 text-center text-sm text-muted">
              Your library is empty. Download something or add a title above.
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
