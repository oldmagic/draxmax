import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  MessagesSquare,
  Search as SearchIcon,
  Wand2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link, useLocation, useSearch } from 'wouter';
import { CONTENT_TYPES, type ContentType, type SearchResultDTO } from '@draxmax/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTorrents } from '@/stores/torrents';
import { useUi } from '@/stores/ui';
import { useXdcc } from '@/stores/xdcc';

const TYPE_LABEL: Record<ContentType, string> = { anime: 'Anime', tv: 'TV', movies: 'Movies' };

/** Search every configured site and indexer, and add or follow what turns up. */
export function SearchPage() {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const q = params.get('q')?.trim() ?? '';
  const type = (CONTENT_TYPES as readonly string[]).includes(params.get('type') ?? '')
    ? (params.get('type') as ContentType)
    : null;
  const [draft, setDraft] = useState(q);
  // Arriving with another ?q= (e.g. from Upcoming) replaces what was typed.
  const [shownQ, setShownQ] = useState(q);
  if (q !== shownQ) {
    setShownQ(q);
    setDraft(q);
  }
  const [category, setCategory] = useState('');
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const { data: sources = [] } = useQuery({
    queryKey: ['search-sources'],
    queryFn: api.searchSources,
  });
  const enabled = sources.filter((s) => s.enabled);

  const go = (nextQ: string, nextType: ContentType | null) => {
    const p = new URLSearchParams();
    if (nextQ.trim()) p.set('q', nextQ.trim());
    if (nextType) p.set('type', nextType);
    navigate(`/search${p.size ? `?${p}` : ''}`, { replace: true });
  };

  const search = useQuery({
    queryKey: ['search', q, type],
    queryFn: () => api.search(q, type),
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const all = search.data?.results ?? [];
  // Torrents and XDCC packs together, or one of them.
  const [via, setVia] = useState<'all' | 'torrent' | 'xdcc'>('all');
  const xdccCount = all.filter((r) => r.kind === 'xdcc').length;
  const results = via === 'all' ? all : all.filter((r) => r.kind === via);

  return (
    <div className="flex h-full flex-col">
      <header className="pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-muted">
          Looks on your{' '}
          <Link href="/sites" className="text-accent hover:underline">
            sites and indexers
          </Link>
          . Add a result, or follow the show to get new episodes automatically.
        </p>
      </header>
      <form
        className="flex flex-wrap items-center gap-2 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft, type);
        }}
      >
        <div className="relative min-w-60 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Title, e.g. Frieren 1080p"
            aria-label="Search text"
            className="pl-9"
          />
        </div>
        <div role="group" aria-label="Kind" className="flex rounded-xl border p-0.5 text-sm">
          {([null, ...CONTENT_TYPES] as const).map((t) => (
            <button
              key={t ?? 'all'}
              type="button"
              aria-pressed={type === t}
              onClick={() => go(draft, t)}
              className={cn(
                'rounded-lg px-3 py-1.5 transition-colors',
                type === t ? 'bg-surface-hover text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {t ? TYPE_LABEL[t] : 'Everything'}
            </button>
          ))}
        </div>
        <Button type="submit" variant="primary" disabled={draft.trim().length < 2}>
          {search.isFetching ? <Loader2 className="animate-spin" /> : <SearchIcon />} Search
        </Button>
      </form>

      <section className="glass flex min-h-0 flex-1 flex-col rounded-2xl">
        {all.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs text-muted">
            <span>
              {all.length} results from {search.data!.searched.length} sources
            </span>
            {xdccCount > 0 && xdccCount < all.length && (
              <div role="group" aria-label="Result type" className="flex rounded-lg border p-0.5">
                {(
                  [
                    ['all', 'All'],
                    ['torrent', `Torrents (${all.length - xdccCount})`],
                    ['xdcc', `XDCC (${xdccCount})`],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={via === v}
                    onClick={() => setVia(v)}
                    className={cn(
                      'rounded-md px-2 py-0.5 transition-colors',
                      via === v ? 'bg-surface-hover text-fg' : 'hover:text-fg',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <label className="ml-auto flex items-center gap-2">
              Add to category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-8 rounded-lg border bg-surface-2 px-2 text-sm text-fg"
              >
                <option value="">Automatic</option>
                {categories.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {search.data?.errors.map((e) => (
          <div
            key={e.source}
            className="flex items-center gap-2 border-b px-4 py-2 text-xs text-warning"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {e.source} didn&apos;t answer: {e.error}
            </span>
          </div>
        ))}
        <ul
          className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto"
          aria-label="Results"
        >
          {results.map((r) =>
            r.kind === 'xdcc' ? (
              <XdccResult key={r.id} result={r} />
            ) : (
              <Result key={r.id} result={r} category={category} />
            ),
          )}
          {results.length === 0 && (
            <li className="p-10 text-center text-sm text-muted">
              {search.isFetching ? (
                <>
                  <Loader2 className="mx-auto mb-2 size-5 animate-spin" />
                  Searching {enabled.length} sources…
                </>
              ) : search.error ? (
                search.error.message
              ) : q.length < 2 ? (
                enabled.length ? (
                  `Type a title to search ${enabled.map((s) => s.name).join(', ')}.`
                ) : (
                  <>
                    Nothing to search yet.{' '}
                    <Link href="/sites" className="text-accent hover:underline">
                      Add a site or indexer
                    </Link>
                    .
                  </>
                )
              ) : search.data && search.data.searched.length === 0 ? (
                <>
                  No enabled source carries {type ? TYPE_LABEL[type].toLowerCase() : 'this'}.{' '}
                  <Link href="/sites" className="text-accent hover:underline">
                    Check Sites
                  </Link>
                  .
                </>
              ) : (
                `Nothing found for “${q}”.`
              )}
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Result({ result: r, category }: { result: SearchResultDTO; category: string }) {
  const [, navigate] = useLocation();
  const followShow = useUi((s) => s.followShow);
  const [added, setAdded] = useState(r.inList);
  const add = useMutation({
    mutationFn: () => api.addSearchResult({ id: r.id, ...(category ? { category } : {}) }),
    onSuccess: (t) => {
      setAdded(true);
      useTorrents.getState().upsert(t);
      toast.success('Added', { description: t.name });
    },
    onError: (e) => {
      // Already in the list is as good as added.
      if (/already/i.test(e.message)) setAdded(true);
      toast.error(e.message);
    },
  });
  const follow = useMutation({
    mutationFn: () => api.suggestRule(r.title),
    onSuccess: (draft) => {
      followShow(draft);
      navigate('/rss');
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={r.title}>
          {r.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted tabular">
          <span>{r.source}</span>
          {r.size ? <span>{formatBytes(r.size)}</span> : null}
          {r.seeders !== null && (
            <span className={r.seeders === 0 ? 'text-danger' : r.seeders < 5 ? 'text-warning' : ''}>
              {r.seeders} {r.seeders === 1 ? 'seeder' : 'seeders'}
            </span>
          )}
          {added && <Badge tone="success">In your list</Badge>}
        </div>
      </div>
      {r.episodes.length > 0 && (
        <Tooltip content="Create a download rule for this show (you can check it before saving)">
          <Button
            size="sm"
            variant="ghost"
            disabled={follow.isPending}
            onClick={() => follow.mutate()}
          >
            {follow.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />} Follow
          </Button>
        </Tooltip>
      )}
      <Button
        size="sm"
        variant={added ? 'ghost' : 'primary'}
        disabled={added || add.isPending}
        aria-label={`Add ${r.title}`}
        onClick={() => add.mutate()}
      >
        {add.isPending ? <Loader2 className="animate-spin" /> : added ? <Check /> : <Download />}
        {added ? 'Added' : 'Add'}
      </Button>
    </li>
  );
}

/** A pack offered by an IRC bot: added to the XDCC list instead of the torrents. */
function XdccResult({ result: r }: { result: SearchResultDTO }) {
  const [, navigate] = useLocation();
  const [added, setAdded] = useState(r.inList);
  const x = r.xdcc!;
  const add = useMutation({
    mutationFn: () => api.addXdcc({ id: r.id }),
    onSuccess: (t) => {
      setAdded(true);
      useXdcc.getState().upsert(t);
      toast.success('Added to XDCC', {
        description: `${t.filename} from ${t.bot}`,
        action: { label: 'Show', onClick: () => navigate('/xdcc') },
      });
    },
    onError: (e) => {
      if (/already/i.test(e.message)) setAdded(true);
      toast.error(e.message);
    },
  });
  const seen = x.lastSeen ? new Date(x.lastSeen) : null;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={r.title}>
          {r.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted tabular">
          <Badge tone="info">
            <MessagesSquare className="mr-1 inline size-3" />
            XDCC
          </Badge>
          <span title={x.channel ? `${x.network} ${x.channel}` : x.network}>
            {x.bot} · {x.network} · #{x.pack}
          </span>
          {r.size ? <span>{formatBytes(r.size)}</span> : null}
          {x.gets !== null && (
            <span>
              {x.gets} {x.gets === 1 ? 'get' : 'gets'}
            </span>
          )}
          {seen && <span title={seen.toLocaleString()}>seen {seen.toLocaleDateString()}</span>}
          {added && <Badge tone="success">In your XDCC list</Badge>}
        </div>
      </div>
      <Button
        size="sm"
        variant={added ? 'ghost' : 'primary'}
        disabled={added || add.isPending}
        aria-label={`Add ${r.title}`}
        onClick={() => add.mutate()}
      >
        {add.isPending ? <Loader2 className="animate-spin" /> : added ? <Check /> : <Download />}
        {added ? 'Added' : 'Add'}
      </Button>
    </li>
  );
}
