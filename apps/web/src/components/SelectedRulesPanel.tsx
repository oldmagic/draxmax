import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2, Minus, Rss, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { FeedDTO, RuleDTO } from '@draxmax/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type State = 'on' | 'off' | 'mixed';

function feedLabel(f: FeedDTO): string {
  try {
    const u = new URL(f.url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search.replace(/passkey=[^&]+/i, 'passkey=…')}`;
  } catch {
    return f.url;
  }
}

/**
 * Editor shown instead of the single-rule editor while rules are ticked: sets the feeds of
 * every selected rule at once. A feed used by only some of them shows as mixed and stays that
 * way unless clicked.
 */
export function SelectedRulesPanel({
  rules,
  onClear,
  onDelete,
}: {
  rules: RuleDTO[];
  onClear(): void;
  onDelete(): void;
}) {
  const qc = useQueryClient();
  const { data: feeds = [] } = useQuery({ queryKey: ['rss', 'feeds'], queryFn: api.feeds });
  // Target state per feed; feeds not in the map are left as they are.
  const [targets, setTargets] = useState<Map<string, 'on' | 'off'>>(new Map());
  const [enable, setEnable] = useState(true);
  const [applyToExisting, setApplyToExisting] = useState(false);

  const usedBy = (feedId: string) => rules.filter((r) => r.assignedFeedIds.includes(feedId)).length;
  const initial = (feedId: string): State => {
    const n = usedBy(feedId);
    return n === rules.length ? 'on' : n === 0 ? 'off' : 'mixed';
  };
  const shown = (feedId: string): State => targets.get(feedId) ?? initial(feedId);
  function cycle(feedId: string) {
    const now = shown(feedId);
    // mixed → on → off → mixed; feeds all or none of the rules use simply toggle.
    const target: State =
      now === 'mixed' ? 'on' : now === 'on' ? 'off' : initial(feedId) === 'mixed' ? 'mixed' : 'on';
    const next = new Map(targets);
    if (target === initial(feedId) || target === 'mixed') next.delete(feedId);
    else next.set(feedId, target);
    setTargets(next);
  }
  const setAll = (state: 'on' | 'off') =>
    setTargets(
      new Map(feeds.filter((f) => initial(f.id) !== state).map((f) => [f.id, state] as const)),
    );

  const add = [...targets].filter(([, t]) => t === 'on').map(([id]) => id);
  const remove = [...targets].filter(([, t]) => t === 'off').map(([id]) => id);
  const after = (r: RuleDTO) =>
    [...new Set([...r.assignedFeedIds, ...add])].filter((id) => !remove.includes(id));
  const allFeedsNow = rules.filter((r) => r.assignedFeedIds.length === 0).length;
  const becomeAll = rules.filter((r) => r.assignedFeedIds.length > 0 && after(r).length === 0);
  const disabled = rules.filter((r) => !r.enabled);
  const wouldEnable = enable ? disabled.filter((r) => after(r).length > 0).length : 0;
  const dirty = targets.size > 0 || wouldEnable > 0;

  const save = useMutation({
    mutationFn: () =>
      api.setRuleFeeds({ ids: rules.map((r) => r.id), add, remove, enable, applyToExisting }),
    onSuccess: (res) => {
      toast.success(
        `Feeds updated on ${res.updated} ${res.updated === 1 ? 'rule' : 'rules'}` +
          (res.enabled ? `, ${res.enabled} turned on` : ''),
      );
      setTargets(new Map());
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rss'] }),
  });

  return (
    <form
      className="mx-auto max-w-2xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {rules.length === 1 ? '1 rule selected' : `${rules.length} rules selected`}
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Choose the feeds these rules use. Changes apply to every selected rule.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>
            <Trash2 /> Delete
          </Button>
          <Button size="sm" onClick={onClear}>
            <X /> Clear selection
          </Button>
        </div>
      </header>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Rss className="size-4 text-muted" /> Feeds
          </h3>
          {feeds.length > 1 && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setAll('on')}>
                Use all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAll('off')}>
                Use none
              </Button>
            </div>
          )}
        </div>
        {feeds.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-sm text-muted">
            No feeds yet. Add one on the Feeds tab first.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
            {feeds.map((f) => {
              const state = shown(f.id);
              const n = usedBy(f.id);
              const target = targets.get(f.id);
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
                    onClick={() => cycle(f.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover',
                      target && 'bg-accent/10',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-md border-2',
                        state === 'on' && 'border-accent bg-accent text-accent-fg',
                        state === 'mixed' && 'border-accent text-accent',
                        state === 'off' && 'border-muted/60',
                      )}
                    >
                      {state === 'on' && <Check className="size-3.5" strokeWidth={3} />}
                      {state === 'mixed' && <Minus className="size-3.5" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{f.title}</span>
                      <span className="block truncate font-mono text-[11px] text-muted">
                        {feedLabel(f)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 text-xs',
                        target === 'on'
                          ? 'text-success'
                          : target === 'off'
                            ? 'text-danger'
                            : 'text-muted',
                      )}
                    >
                      {target === 'on'
                        ? `+ ${rules.length - n} ${rules.length - n === 1 ? 'rule' : 'rules'}`
                        : target === 'off'
                          ? `− ${n} ${n === 1 ? 'rule' : 'rules'}`
                          : n === rules.length
                            ? 'All'
                            : n === 0
                              ? 'None'
                              : `${n} of ${rules.length}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {allFeedsNow > 0 && add.length > 0 && (
        <p className="flex gap-2 text-xs text-muted">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          {allFeedsNow} of these {allFeedsNow === 1 ? 'rule has' : 'rules have'} no feed and apply
          to every feed; after this {allFeedsNow === 1 ? 'it uses' : 'they use'} only the ticked
          ones.
        </p>
      )}
      {becomeAll.length > 0 && (
        <p className="flex gap-2 text-xs text-muted">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          {becomeAll.length} {becomeAll.length === 1 ? 'rule is' : 'rules are'} left without a feed
          and will apply to every feed.
        </p>
      )}

      <div className="space-y-2 text-sm">
        {disabled.length > 0 && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enable}
              onChange={(e) => setEnable(e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            Turn on the {disabled.length} disabled {disabled.length === 1 ? 'rule' : 'rules'} once
            they have a feed
          </label>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={applyToExisting}
            onChange={(e) => setApplyToExisting(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Also download matching articles already in these feeds
        </label>
      </div>

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex items-center justify-end gap-2 border-t bg-surface-2/95 px-5 py-3 backdrop-blur">
        {targets.size > 0 && (
          <Button variant="ghost" onClick={() => setTargets(new Map())}>
            Reset
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={save.isPending || !dirty}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Save feeds for {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
        </Button>
      </div>
    </form>
  );
}
