import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCheck,
  Download,
  ExternalLink,
  History,
  ListFilter,
  Loader2,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ArticleDTO, FeedDTO, RuleDTO, RuleImportResult, RuleInput } from '@draxmax/shared';
import { PathInput } from '@/components/FolderPicker';
import { MissingTab } from '@/components/MissingEpisodes';
import { useUi } from '@/stores/ui';
import { RssJsonEditorButton } from '@/components/RssJsonEditor';
import { SelectedRulesPanel } from '@/components/SelectedRulesPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function RssPage() {
  // Arriving with a rule to follow (from Search or an article) opens the rule editor.
  const pending = useUi((s) => s.ruleDraft);
  const [draft, setDraft] = useState(pending);
  const [tab, setTab] = useState(draft ? 'rules' : 'feeds');
  if (pending && pending !== draft) {
    setDraft(pending);
    setTab('rules');
  }
  // Handed over: a later visit to this page starts normally.
  useEffect(() => {
    if (pending) useUi.setState({ ruleDraft: null });
  }, [pending]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">RSS</h1>
          <p className="mt-1 text-sm text-muted">
            Follow feeds and download matching releases automatically.
          </p>
        </div>
        <RssJsonEditorButton />
      </header>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList
          className="mb-4 max-w-xl"
          items={[
            { value: 'feeds', label: 'Feeds' },
            { value: 'rules', label: 'Download rules' },
            { value: 'missing', label: 'Missing' },
            { value: 'history', label: 'History' },
          ]}
        />
        <TabsContent value="feeds" className="min-h-0 flex-1">
          <FeedsTab />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0 flex-1">
          <RulesTab key={draft ? JSON.stringify(draft) : 'rules'} draft={draft} />
        </TabsContent>
        <TabsContent value="missing" className="min-h-0 flex-1">
          <MissingTab />
        </TabsContent>
        <TabsContent value="history" className="min-h-0 flex-1">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Feeds ----------------------------------------------------------------------

function FeedsTab() {
  const qc = useQueryClient();
  const { data: feeds = [], isLoading } = useQuery({
    queryKey: ['rss', 'feeds'],
    queryFn: api.feeds,
  });
  const [feedId, setFeedId] = useState<string>(ALL);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FeedDTO | null>(null);
  const selectedFeed = feeds.find((f) => f.id === feedId) ?? null;
  const { data: articles = [], isFetching } = useQuery({
    queryKey: ['rss', 'articles', feedId, unreadOnly, query],
    queryFn: () =>
      api.articles({
        feedId: feedId === ALL ? null : feedId,
        unread: unreadOnly,
        q: query.trim() || undefined,
      }),
  });
  const totalUnread = feeds.reduce((s, f) => s + f.unread, 0);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['rss'] });

  const refresh = useMutation({
    mutationFn: async (): Promise<unknown> =>
      feedId === ALL ? api.refreshAllFeeds() : api.refreshFeed(feedId),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="glass flex min-h-0 flex-col rounded-2xl p-2">
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Feeds</span>
          <Tooltip content="Add feed">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Add feed"
              onClick={() => setAdding(true)}
            >
              <Plus />
            </Button>
          </Tooltip>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" aria-label="Feeds">
          <FeedItem
            active={feedId === ALL}
            onClick={() => setFeedId(ALL)}
            title="All feeds"
            unread={totalUnread}
          />
          {feeds.map((f) => (
            <FeedItem
              key={f.id}
              active={feedId === f.id}
              onClick={() => setFeedId(f.id)}
              onEdit={() => setEditing(f)}
              title={f.title}
              unread={f.unread}
              error={f.lastError}
              disabled={!f.enabled}
            />
          ))}
        </ul>
        {!isLoading && feeds.length === 0 && (
          <div className="p-4 text-center text-sm text-muted">
            <Rss className="mx-auto mb-2 size-6" />
            No feeds yet.
            <Button size="sm" variant="primary" className="mt-3" onClick={() => setAdding(true)}>
              <Plus /> Add a feed
            </Button>
          </div>
        )}
      </aside>

      <section className="glass flex min-h-0 flex-col rounded-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search articles"
              aria-label="Search articles"
              className="h-9 pl-9"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted">
            <Switch label="Unread only" checked={unreadOnly} onChange={setUnreadOnly} />
            Unread only
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void api
                .markRead({ feedId: feedId === ALL ? undefined : feedId, read: true })
                .then(invalidate)
                .catch((e: Error) => toast.error(e.message))
            }
          >
            <CheckCheck /> Mark all read
          </Button>
          <Button
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || feeds.length === 0}
          >
            <RefreshCw className={cn(refresh.isPending && 'animate-spin')} /> Refresh
          </Button>
        </div>
        {selectedFeed && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-xs text-muted">
            <span>Updated {timeAgo(selectedFeed.lastFetched)}</span>
            <span>every {selectedFeed.refreshIntervalMinutes} min</span>
            {selectedFeed.lastError && (
              <span className="flex items-center gap-1 text-danger">
                <AlertTriangle className="size-3.5" /> {selectedFeed.lastError}
              </span>
            )}
          </div>
        )}
        <ul
          className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto"
          aria-label="Articles"
        >
          {articles.map((a) => (
            <ArticleRow
              key={`${a.feedId}:${a.id}`}
              a={a}
              feedTitle={feedId === ALL ? feeds.find((f) => f.id === a.feedId)?.title : undefined}
              onChange={invalidate}
            />
          ))}
          {articles.length === 0 && (
            <li className="p-10 text-center text-sm text-muted">
              {isFetching ? 'Loading…' : 'No articles.'}
            </li>
          )}
        </ul>
      </section>

      <FeedDialog open={adding} onClose={() => setAdding(false)} onSaved={(f) => setFeedId(f.id)} />
      <FeedDialog
        open={!!editing}
        feed={editing}
        onClose={() => setEditing(null)}
        onDeleted={() => setFeedId(ALL)}
      />
    </div>
  );
}

function FeedItem(props: {
  active: boolean;
  onClick(): void;
  onEdit?(): void;
  title: string;
  unread: number;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <li>
      <div
        className={cn(
          'group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors',
          props.active
            ? 'bg-surface-hover text-fg'
            : 'text-muted hover:bg-surface-hover hover:text-fg',
          props.disabled && 'opacity-50',
        )}
      >
        <button
          type="button"
          onClick={props.onClick}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {props.error ? <AlertTriangle className="size-3.5 shrink-0 text-danger" /> : null}
          <span className="truncate">{props.title}</span>
        </button>
        {props.unread > 0 && (
          <span className="rounded-full bg-accent/15 px-1.5 text-xs text-accent tabular">
            {props.unread}
          </span>
        )}
        {props.onEdit && (
          <button
            type="button"
            onClick={props.onEdit}
            aria-label={`Edit ${props.title}`}
            className="rounded-md px-1 text-xs text-muted opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
          >
            Edit
          </button>
        )}
      </div>
    </li>
  );
}

function ArticleRow({
  a,
  feedTitle,
  onChange,
}: {
  a: ArticleDTO;
  feedTitle?: string | undefined;
  onChange(): void;
}) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const res = await api.downloadArticle(a.feedId, a.id);
      toast[res.status === 'added' ? 'success' : 'info'](
        res.status === 'added' ? 'Torrent added' : 'Already in your downloads',
        {
          description: a.title,
        },
      );
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3', a.isRead && 'opacity-60')}>
      <span
        className={cn('size-2 shrink-0 rounded-full', a.isRead ? 'bg-transparent' : 'bg-accent')}
        aria-label={a.isRead ? undefined : 'Unread'}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block w-full truncate text-left text-sm font-medium hover:underline"
          title={a.title}
          onClick={() =>
            void api
              .markRead({ articles: [{ feedId: a.feedId, id: a.id }], read: !a.isRead })
              .then(onChange)
          }
        >
          {a.title}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted tabular">
          {feedTitle && <span>{feedTitle}</span>}
          <span>{new Date(a.pubDate).toLocaleString()}</span>
          {a.size ? <span>{formatBytes(a.size)}</span> : null}
          {a.downloaded && <Badge tone="success">Downloaded</Badge>}
          {a.matchedRuleIds.length > 0 && !a.downloaded && <Badge tone="info">Matched</Badge>}
        </div>
      </div>
      {a.link && /^https?:/.test(a.link) && (
        <Tooltip content="Open page">
          <a
            href={a.link}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-fg"
            aria-label={`Open ${a.title}`}
          >
            <ExternalLink className="size-4" />
          </a>
        </Tooltip>
      )}
      <Tooltip content="Follow this show: create a download rule from this release">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Follow ${a.title}`}
          onClick={() =>
            void api.suggestRule(a.title).then(
              (d) => useUi.getState().followShow({ ...d, assignedFeedIds: [a.feedId] }),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          <Wand2 />
        </Button>
      </Tooltip>
      <Tooltip content={a.torrentURL ? 'Download' : 'No torrent link'}>
        <span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Download ${a.title}`}
            disabled={!a.torrentURL || busy}
            onClick={() => void download()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
          </Button>
        </span>
      </Tooltip>
    </li>
  );
}

function FeedDialog({
  open,
  feed,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  feed?: FeedDTO | null;
  onClose(): void;
  onSaved?(f: FeedDTO): void;
  onDeleted?(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={feed ? 'Edit feed' : 'Add RSS feed'}
        description={feed ? feed.url : 'Paste the URL of an RSS or Atom feed.'}
      >
        {open && (
          <FeedForm feed={feed ?? null} onClose={onClose} onSaved={onSaved} onDeleted={onDeleted} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FeedForm({
  feed,
  onClose,
  onSaved,
  onDeleted,
}: {
  feed: FeedDTO | null;
  onClose(): void;
  onSaved?(f: FeedDTO): void;
  onDeleted?(): void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(feed?.url ?? '');
  const [title, setTitle] = useState(feed?.title ?? '');
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);
  const [custom, setCustom] = useState(feed?.customRefreshMinutes != null);
  const [minutes, setMinutes] = useState(String(feed?.customRefreshMinutes ?? 30));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const refreshMinutes = custom ? Number(minutes) : null;
      const saved = feed
        ? await api.updateFeed(feed.id, {
            url: url.trim(),
            title: title.trim() || undefined,
            enabled,
            refreshMinutes,
          })
        : await api.addFeed(url.trim(), refreshMinutes);
      if (!feed && saved.lastError)
        toast.warning('Feed added, but it could not be fetched', { description: saved.lastError });
      void qc.invalidateQueries({ queryKey: ['rss'] });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Feed URL</span>
        <Input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.org/rss"
          autoFocus={!feed}
        />
      </label>
      {feed && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Name</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      <div className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
        <span>Custom refresh interval</span>
        <div className="flex items-center gap-2">
          {custom && (
            <Input
              type="number"
              min={5}
              max={1440}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-label="Minutes"
              className="h-8 w-20"
            />
          )}
          {custom && <span className="text-muted">min</span>}
          <Switch label="Custom refresh interval" checked={custom} onChange={setCustom} />
        </div>
      </div>
      {feed && (
        <div className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
          <span>Enabled</span>
          <Switch label="Feed enabled" checked={enabled} onChange={setEnabled} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        {feed ? (
          <Button
            variant="ghost"
            className="text-danger"
            onClick={() =>
              void api.deleteFeed(feed.id).then(() => {
                void qc.invalidateQueries({ queryKey: ['rss'] });
                onDeleted?.();
                onClose();
              })
            }
          >
            <Trash2 /> Delete feed
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {feed ? 'Save' : 'Add feed'}
          </Button>
        </div>
      </div>
    </form>
  );
}

// --- Rules ----------------------------------------------------------------------

const EMPTY_RULE: RuleInput = {
  name: '',
  enabled: true,
  priority: 0,
  mustContain: [],
  mustNotContain: [],
  useRegex: false,
  episodeFilter: '',
  smartEpisodeFilter: true,
  assignedFeedIds: [],
  category: '',
  tags: [],
  savePath: '',
  addPaused: false,
};

function toInput(r: RuleDTO): RuleInput {
  return {
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    mustContain: r.mustContain,
    mustNotContain: r.mustNotContain,
    useRegex: r.useRegex,
    episodeFilter: r.episodeFilter ?? '',
    smartEpisodeFilter: r.smartEpisodeFilter,
    ignoreSubsequentDays: r.ignoreSubsequentDays,
    assignedFeedIds: r.assignedFeedIds,
    category: r.category ?? '',
    tags: r.tags,
    savePath: r.savePath ?? '',
    addPaused: r.addPaused,
    missingMode: r.missingMode ?? 'default',
  };
}

function RulesTab({ draft }: { draft: RuleInput | null }) {
  const qc = useQueryClient();
  const { data: rules = [] } = useQuery({ queryKey: ['rss', 'rules'], queryFn: api.rules });
  const [chosen, setSelected] = useState<string | 'new' | null>(draft ? 'new' : null);
  const [importing, setImporting] = useState<Record<string, unknown> | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  // Rules ticked for bulk actions (separate from the rule open in the editor).
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ruleQuery, setRuleQuery] = useState('');
  // Every word must appear in the name or a "must contain" line.
  const words = ruleQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = words.length
    ? rules.filter((r) => {
        const text = `${r.name}\n${r.mustContain.join('\n')}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
    : rules;
  // Bulk actions only apply to rules that are shown.
  const checked = visible.filter((r) => checkedIds.has(r.id));
  const allChecked = visible.length > 0 && checked.length === visible.length;

  /** Toggles one rule; with `range`, ticks everything between the last clicked rule and this one. */
  function check(id: string, range = false) {
    const next = new Set(checkedIds);
    const from = anchor ? visible.findIndex((r) => r.id === anchor) : -1;
    const to = visible.findIndex((r) => r.id === id);
    if (range && from >= 0) {
      for (const r of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(r.id);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    setCheckedIds(next);
    setAnchor(id);
  }

  const removeChecked = useMutation({
    mutationFn: (ids: string[]) => api.deleteRules(ids),
    onSuccess: ({ deleted }, ids) => {
      toast.success(deleted === 1 ? 'Rule deleted' : `${deleted} rules deleted`);
      if (chosen && ids.includes(chosen)) setSelected(null);
      setCheckedIds(new Set());
      setConfirmDelete(false);
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rss'] }),
  });
  const toggle = useMutation({
    mutationFn: (r: RuleDTO) => api.updateRule(r.id, { ...toInput(r), enabled: !r.enabled }),
    // Flip the checkbox immediately; the server's answer (or an error) settles it.
    onMutate: (r) =>
      qc.setQueryData<RuleDTO[]>(['rss', 'rules'], (list) =>
        list?.map((x) => (x.id === r.id ? { ...x, enabled: !r.enabled } : x)),
      ),
    onError: (e) => toast.error(e.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rss'] }),
  });

  async function readImport(file: File) {
    try {
      const json: unknown = JSON.parse(await file.text());
      if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error();
      setImporting(json as Record<string, unknown>);
    } catch {
      toast.error(`${file.name} is not a qBittorrent rules export`);
    }
  }
  // Until the user picks one, the first rule is shown.
  const selected = chosen ?? rules[0]?.id ?? null;
  const current = selected === 'new' ? null : (rules.find((r) => r.id === selected) ?? null);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="glass flex min-h-0 flex-col rounded-2xl p-2">
        <div className="flex min-h-9 items-center gap-1 pb-2 pl-3 pr-2 pt-1">
          {rules.length > 0 && (
            <input
              type="checkbox"
              aria-label="Select all rules"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = checked.length > 0 && !allChecked;
              }}
              onChange={() =>
                setCheckedIds(allChecked ? new Set() : new Set(visible.map((r) => r.id)))
              }
              className="mr-1.5 size-4 shrink-0 accent-[var(--accent)]"
            />
          )}
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">
            {checked.length > 0
              ? `${checked.length} selected`
              : `Rules${
                  rules.length === 0
                    ? ''
                    : words.length
                      ? ` (${visible.length} of ${rules.length})`
                      : ` (${rules.length})`
                }`}
          </span>
          <span className="flex-1" />
          {checked.length > 0 && (
            <Tooltip content="Delete selected rules (Del)">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${checked.length} selected rules`}
                className="text-danger"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Import qBittorrent rules (.json)">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Import qBittorrent rules"
              onClick={() => importInput.current?.click()}
            >
              <Upload />
            </Button>
          </Tooltip>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void readImport(file);
            }}
          />
          <Tooltip content="New rule">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New rule"
              onClick={() => setSelected('new')}
            >
              <Plus />
            </Button>
          </Tooltip>
        </div>
        {rules.length > 0 && (
          <div className="relative px-1 pb-2">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-[calc(50%+4px)] text-muted" />
            <Input
              type="search"
              value={ruleQuery}
              onChange={(e) => setRuleQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setRuleQuery('')}
              placeholder="Search rules"
              aria-label="Search rules"
              className="h-9 pl-9"
            />
          </div>
        )}
        <ul
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto"
          aria-label="Download rules"
          onKeyDown={(e) => {
            if (e.key === 'Delete' && checked.length > 0) setConfirmDelete(true);
          }}
        >
          {visible.map((r) => (
            <li
              key={r.id}
              className={cn(
                'flex items-center rounded-xl transition-colors',
                selected === r.id
                  ? 'bg-surface-hover text-fg'
                  : checkedIds.has(r.id)
                    ? 'bg-accent/10 text-fg'
                    : 'text-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              <input
                type="checkbox"
                aria-label={`Select ${r.name}`}
                checked={checkedIds.has(r.id)}
                onChange={() => {}}
                onClick={(e) => check(r.id, e.shiftKey)}
                className="ml-3 size-4 shrink-0 accent-[var(--accent)]"
              />
              <button
                type="button"
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey) check(r.id, e.shiftKey);
                  else setSelected(r.id);
                }}
                className="min-w-0 flex-1 py-1.5 pl-2.5 pr-2 text-left"
              >
                <span
                  className={cn('block truncate text-sm', !r.enabled && 'opacity-60')}
                  title={r.name}
                >
                  {r.name}
                </span>
                <span className="block text-xs text-muted">
                  {r.lastMatchAt ? `Matched ${timeAgo(r.lastMatchAt)}` : 'No matches yet'}
                </span>
              </button>
              <Switch
                size="sm"
                label={`Enable ${r.name}`}
                checked={r.enabled}
                onChange={() => toggle.mutate(r)}
                className="mr-3"
              />
            </li>
          ))}
        </ul>
        {words.length > 0 && visible.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted">No rules match.</p>
        )}
        {rules.length > 1 && checked.length === 0 && (
          <p className="hidden px-3 pt-2 text-xs text-muted lg:block">
            Tick rules, or Ctrl/Shift-click them, to set their feeds or delete several at once.
          </p>
        )}
        {rules.length === 0 && selected !== 'new' && (
          <div className="p-4 text-center text-sm text-muted">
            <Wand2 className="mx-auto mb-2 size-6" />
            Rules download matching articles automatically.
            <Button size="sm" variant="primary" className="mt-3" onClick={() => setSelected('new')}>
              <Plus /> Create a rule
            </Button>
          </div>
        )}
      </aside>
      <section className="glass min-h-0 overflow-y-auto rounded-2xl p-5">
        {checked.length > 0 ? (
          <SelectedRulesPanel
            rules={checked}
            onClear={() => setCheckedIds(new Set())}
            onDelete={() => setConfirmDelete(true)}
          />
        ) : selected ? (
          <RuleEditor
            key={selected}
            rule={current}
            draft={selected === 'new' ? draft : null}
            onSaved={(r) => setSelected(r.id)}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <p className="p-10 text-center text-sm text-muted">Select a rule or create a new one.</p>
        )}
      </section>
      <ImportRulesDialog rules={importing} onClose={() => setImporting(null)} />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={checked.length === 1 ? 'Delete rule?' : `Delete ${checked.length} rules?`}
          description="Their download history is kept. This can't be undone."
        >
          <ul className="mb-4 max-h-48 space-y-0.5 overflow-y-auto rounded-xl bg-surface-2 p-2 text-sm">
            {checked.map((r) => (
              <li key={r.id} className="truncate px-2 py-1" title={r.name}>
                {r.name}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={removeChecked.isPending}
              onClick={() => removeChecked.mutate(checked.map((r) => r.id))}
            >
              {removeChecked.isPending && <Loader2 className="animate-spin" />}
              Delete {checked.length === 1 ? 'rule' : `${checked.length} rules`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImportRulesDialog({
  rules,
  onClose,
}: {
  rules: Record<string, unknown> | null;
  onClose(): void;
}) {
  return (
    <Dialog open={rules !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Import qBittorrent rules"
        description={
          rules
            ? `${Object.keys(rules).length} rules found. Rules with the same name are replaced.`
            : ''
        }
      >
        {rules && <ImportRulesForm rules={rules} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportRulesForm({ rules, onClose }: { rules: Record<string, unknown>; onClose(): void }) {
  const qc = useQueryClient();
  const [createMissingFeeds, setCreateMissingFeeds] = useState(true);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const [result, setResult] = useState<RuleImportResult | null>(null);
  const run = useMutation({
    mutationFn: () => api.importQbRules({ rules, createMissingFeeds, applyToExisting }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['rss'] });
      setResult(r);
      toast.success(`Imported ${r.created + r.updated} rules`, {
        description: [
          r.created && `${r.created} new`,
          r.updated && `${r.updated} replaced`,
          r.feedsCreated && `${r.feedsCreated} feeds added`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      if (r.errors.length === 0 && r.warnings.length === 0) onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  if (result)
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Imported {result.created + result.updated} rules
          {result.feedsCreated > 0 && ` and ${result.feedsCreated} feeds`}.
        </p>
        <ul className="max-h-72 space-y-1 overflow-y-auto rounded-xl bg-surface-2 p-2 text-xs">
          {result.errors.map((e) => (
            <li key={`e:${e.name}`} className="flex gap-2 rounded-lg px-2 py-1.5">
              <AlertTriangle className="size-3.5 shrink-0 text-danger" />
              <span className="min-w-0">
                <span className="font-medium break-all">{e.name}</span>: {e.error}
              </span>
            </li>
          ))}
          {result.warnings.map((w) => (
            <li key={`w:${w.name}`} className="flex gap-2 rounded-lg px-2 py-1.5">
              <AlertTriangle className="size-3.5 shrink-0 text-warning" />
              <span className="min-w-0">
                <span className="font-medium break-all">{w.name}</span>: {w.warning}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        In qBittorrent: RSS → Download Rules… → right-click the rule list → Export rules… Feeds are
        matched by URL.
      </p>
      <ToggleRow
        label="Add missing feeds"
        hint="Subscribe to feeds the rules use that aren't added here yet."
        checked={createMissingFeeds}
        onChange={setCreateMissingFeeds}
      />
      <ToggleRow
        label="Download matches already in feeds"
        hint="Off: only articles published after the import are downloaded."
        checked={applyToExisting}
        onChange={setApplyToExisting}
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending && <Loader2 className="animate-spin" />}
          Import
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function RuleEditor({
  rule,
  draft,
  onSaved,
  onDeleted,
}: {
  rule: RuleDTO | null;
  /** Prefilled values for a new rule ("Follow this show"). */
  draft?: RuleInput | null;
  onSaved(r: RuleDTO): void;
  onDeleted(): void;
}) {
  const qc = useQueryClient();
  const { data: feeds = [] } = useQuery({ queryKey: ['rss', 'feeds'], queryFn: api.feeds });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const start = rule ?? draft;
  const [r, setR] = useState<RuleInput>(
    rule ? toInput(rule) : draft ? { ...EMPTY_RULE, ...draft } : EMPTY_RULE,
  );
  const [contain, setContain] = useState((start?.mustContain ?? []).join('\n'));
  const [notContain, setNotContain] = useState((start?.mustNotContain ?? []).join('\n'));
  const [tags, setTags] = useState((start?.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<RuleInput>) => setR((x) => ({ ...x, ...p }));
  // The enable checkbox in the rule list saves directly; reflect it here.
  const [savedEnabled, setSavedEnabled] = useState(rule?.enabled);
  if (rule && rule.enabled !== savedEnabled) {
    setSavedEnabled(rule.enabled);
    set({ enabled: rule.enabled });
  }

  const input: RuleInput = useMemo(
    () => ({
      ...r,
      name: r.name.trim() || 'Untitled rule',
      mustContain: lines(contain),
      mustNotContain: lines(notContain),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      episodeFilter: r.episodeFilter?.trim() || undefined,
      category: r.category?.trim() || undefined,
      savePath: r.savePath?.trim() || undefined,
      ignoreSubsequentDays: r.ignoreSubsequentDays || undefined,
    }),
    [r, contain, notContain, tags],
  );

  // Debounced live preview.
  const [debounced, setDebounced] = useState(input);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input), 400);
    return () => clearTimeout(t);
  }, [input]);
  const preview = useQuery({
    queryKey: ['rss', 'preview', debounced],
    queryFn: () => api.previewRule(debounced),
    retry: false,
  });

  const previewGroups = useMemo(() => {
    const groups = new Map<string, ArticleDTO[]>();
    for (const a of preview.data ?? []) groups.set(a.feedId, [...(groups.get(a.feedId) ?? []), a]);
    return [...groups];
  }, [preview.data]);

  async function save() {
    if (!r.name.trim()) return toast.error('Give the rule a name');
    setBusy(true);
    try {
      const saved = rule ? await api.updateRule(rule.id, input) : await api.createRule(input);
      toast.success(rule ? 'Rule saved' : 'Rule created', {
        description: 'Existing articles were checked too.',
      });
      void qc.invalidateQueries({ queryKey: ['rss'] });
      onSaved(saved);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Input
            value={r.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Rule name"
            aria-label="Rule name"
            className="text-base font-medium"
            autoFocus={!rule}
          />
          <Switch label="Rule enabled" checked={r.enabled} onChange={(v) => set({ enabled: v })} />
        </div>
        {rule && (
          <p className="-mt-2 text-xs text-muted">
            Last match: {rule.lastMatchAt ? timeAgo(rule.lastMatchAt) : 'never'}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Must contain"
            hint={
              r.useRegex
                ? 'One regex per line; any line may match.'
                : 'One pattern per line; words must all appear. * and ? are wildcards, | separates alternatives.'
            }
          >
            <Textarea
              value={contain}
              onChange={(e) => setContain(e.target.value)}
              placeholder={r.useRegex ? '^Show\\.Name\\.S\\d+' : 'show name 1080p'}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Must not contain" hint="Rejects the article if any line matches.">
            <Textarea
              value={notContain}
              onChange={(e) => setNotContain(e.target.value)}
              placeholder="x265"
              className="font-mono text-xs"
            />
          </Field>
        </div>
        <ToggleRow
          label="Use regular expressions"
          checked={r.useRegex}
          onChange={(v) => set({ useRegex: v })}
        />
        <Field
          label="Episode filter"
          hint="e.g. 1x01-1x10;2x05;3x- (open-ended includes later seasons). Leave empty for all."
        >
          <Input
            value={r.episodeFilter ?? ''}
            onChange={(e) => set({ episodeFilter: e.target.value })}
            placeholder="1x01-"
            className="font-mono text-xs"
          />
        </Field>
        <ToggleRow
          label="Smart episode filter"
          hint="Skip episodes this rule already downloaded (a REPACK/PROPER is allowed once)."
          checked={r.smartEpisodeFilter}
          onChange={(v) => set({ smartEpisodeFilter: v })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Ignore matches for (days)"
            hint="After a match, skip further matches for this many days."
          >
            <Input
              type="number"
              min={0}
              max={365}
              value={r.ignoreSubsequentDays ?? ''}
              onChange={(e) =>
                set({ ignoreSubsequentDays: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="0"
            />
          </Field>
          <Field label="Priority" hint="Lower runs first; the first matching rule wins.">
            <Input
              type="number"
              min={0}
              value={r.priority}
              onChange={(e) => set({ priority: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
        <Field label="Apply to feeds">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => set({ assignedFeedIds: [] })}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium',
                r.assignedFeedIds.length === 0 ? 'bg-fg text-bg' : 'bg-surface-2 text-muted',
              )}
            >
              All feeds
            </button>
            {feeds.map((f) => {
              const on = r.assignedFeedIds.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({
                      assignedFeedIds: on
                        ? r.assignedFeedIds.filter((x) => x !== f.id)
                        : [...r.assignedFeedIds, f.id],
                    })
                  }
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium',
                    on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted hover:text-fg',
                  )}
                >
                  {f.title}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            <Input
              list="rule-categories"
              value={r.category ?? ''}
              onChange={(e) => set({ category: e.target.value })}
              placeholder="None"
            />
            <datalist id="rule-categories">
              {categories.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Tags">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tv, auto" />
          </Field>
        </div>
        <Field
          label="Save to"
          hint="Leave empty to use the category's folder or the default download folder."
        >
          <PathInput
            value={r.savePath ?? ''}
            onChange={(v) => set({ savePath: v })}
            placeholder={
              categories.find((c) => c.name === r.category?.trim())?.savePath ?? 'Default folder'
            }
          />
        </Field>
        <ToggleRow
          label="Add paused"
          checked={r.addPaused}
          onChange={(v) => set({ addPaused: v })}
        />
        <Field
          label="Missing episodes"
          hint={
            !r.savePath?.trim() && (r.missingMode ?? 'default') !== 'off'
              ? 'Needs a “Save to” folder above: without one this rule is not checked for missing episodes.'
              : 'Episodes that RSS missed are searched on your sites and indexers and added. See the Missing tab.'
          }
        >
          <select
            value={r.missingMode ?? 'default'}
            onChange={(e) => set({ missingMode: e.target.value as RuleInput['missingMode'] })}
            className="h-10 w-full rounded-xl border bg-surface-2 px-3 text-sm"
          >
            <option value="default">
              Use the setting (fill gaps; empty folder as set in Settings)
            </option>
            <option value="gaps">Fill gaps after the first episode I have</option>
            <option value="all">Whole season, from episode 1</option>
            <option value="off">Don&apos;t search for this rule</option>
          </select>
        </Field>
        <div className="flex items-center justify-between gap-2 border-t pt-4">
          {rule ? (
            <Button
              variant="ghost"
              className="text-danger"
              onClick={() =>
                void api.deleteRule(rule.id).then(() => {
                  void qc.invalidateQueries({ queryKey: ['rss'] });
                  onDeleted();
                })
              }
            >
              <Trash2 /> Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {rule ? 'Save rule' : 'Create rule'}
          </Button>
        </div>
      </div>

      <aside className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListFilter className="size-4 text-muted" /> Matching articles
          {preview.isFetching && <Loader2 className="size-3.5 animate-spin text-muted" />}
        </div>
        {preview.isError ? (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
            {(preview.error as Error).message}
          </p>
        ) : (
          <div
            className="max-h-[60vh] space-y-2 overflow-y-auto rounded-xl bg-surface-2 p-2"
            aria-label="Rule preview"
          >
            {previewGroups.map(([feedId, articles]) => (
              <section key={feedId}>
                <h4 className="truncate px-2 pb-0.5 pt-1 text-xs font-semibold text-muted">
                  {feeds.find((f) => f.id === feedId)?.title ?? 'Feed'} · {articles.length}
                </h4>
                <ul>
                  {articles.map((a) => (
                    <li
                      key={a.id}
                      className="truncate rounded-lg px-2 py-1.5 text-xs"
                      title={a.title}
                    >
                      {a.title}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {preview.data?.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted">No current articles match.</p>
            )}
          </div>
        )}
        <p className="text-xs text-muted">
          Preview ignores history; saving applies the rule to these articles too.
        </p>
      </aside>
    </form>
  );
}

// --- History --------------------------------------------------------------------

function HistoryTab() {
  const qc = useQueryClient();
  const { data: history = [] } = useQuery({
    queryKey: ['rss', 'history'],
    queryFn: api.rssHistory,
  });
  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-2xl">
      <div className="flex items-center justify-between border-b p-3">
        <span className="flex items-center gap-2 px-1 text-sm font-medium">
          <History className="size-4 text-muted" /> Matched items
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={history.length === 0}
          onClick={() => {
            if (
              confirm(
                'Clear history? Rules will also forget which episodes they already downloaded.',
              )
            ) {
              void api.clearRssHistory().then(() => qc.invalidateQueries({ queryKey: ['rss'] }));
            }
          }}
        >
          <Trash2 /> Clear
        </Button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
        {history.map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-4 py-3">
            <Badge
              tone={
                h.status === 'added' ? 'success' : h.status === 'duplicate' ? 'muted' : 'danger'
              }
            >
              {h.status === 'added' ? 'Added' : h.status === 'duplicate' ? 'Duplicate' : 'Failed'}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{h.articleTitle}</div>
              <div className="text-xs text-muted">
                {h.ruleName ? `Rule: ${h.ruleName}` : 'Manual download'}
                {h.feedId === 'missing' && ' (missing episode search)'} ·{' '}
                {new Date(h.createdAt).toLocaleString()}
                {h.error && <span className="text-danger"> · {h.error}</span>}
              </div>
            </div>
          </li>
        ))}
        {history.length === 0 && (
          <li className="p-10 text-center text-sm text-muted">Nothing downloaded from RSS yet.</li>
        )}
      </ul>
    </section>
  );
}
