import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, SearchCheck } from 'lucide-react';
import { useState } from 'react';
import type { MissingShowDTO } from '@draxmax/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

/** [1,2,3,5] → "1–3, 5". */
export function episodeRanges(eps: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < eps.length; i++) {
    let j = i;
    while (j + 1 < eps.length && eps[j + 1] === eps[j]! + 1) j++;
    out.push(j > i ? `${eps[i]}–${eps[j]}` : String(eps[i]));
    i = j;
  }
  return out.join(', ');
}

const STATE: Record<MissingShowDTO['state'], [string, BadgeTone]> = {
  ok: ['Complete', 'success'],
  missing: ['Missing', 'warning'],
  empty: ['No episodes yet', 'muted'],
  'no-results': ['Not found', 'muted'],
  error: ['Error', 'danger'],
  pending: ['Not checked', 'muted'],
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** RSS → Missing episodes: what each rule's folder lacks, and what was fetched for it. */
export function MissingTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const { data } = useQuery({ queryKey: ['missing'], queryFn: api.missing });
  const check = useMutation({
    mutationFn: (ruleIds?: string[]) => api.checkMissing(ruleIds),
    onSuccess: (res) => qc.setQueryData(['missing'], res),
  });
  const shows = (data?.shows ?? []).filter(
    (s) => !filter || `${s.ruleName} ${s.title ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const count = (st: MissingShowDTO['state']) => data?.shows.filter((s) => s.state === st).length;

  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-2xl">
      <div className="flex flex-wrap items-center gap-3 border-b p-3">
        <span className="flex items-center gap-2 px-1 text-sm font-medium">
          <SearchCheck className="size-4 text-muted" /> Missing episodes
        </span>
        <span className="text-xs text-muted">
          {data?.running
            ? `Checking ${data.current ?? '…'}`
            : data?.lastRunAt
              ? `Last run ${when(data.lastRunAt)} · ${data.lastRunAdded} added`
              : 'Not run yet'}
          {data && !data.enabled && ' · automatic checks are off (Settings → RSS)'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            aria-label="Filter shows"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-40"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={data?.running || check.isPending || data?.sources.length === 0}
            onClick={() => check.mutate(undefined)}
          >
            {data?.running ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check all now
          </Button>
        </div>
      </div>
      <p className="border-b px-4 py-2 text-xs text-muted">
        Each enabled rule with a save folder is compared with what its search finds on{' '}
        {data?.sources.length ? data.sources.join(', ') : 'no sources (add one under Sites)'}.
        Released episodes after the first one you have are added automatically; a folder without
        episodes{' '}
        {data?.whenEmpty === 'download'
          ? 'is filled from episode 1'
          : 'waits for its first one from RSS'}{' '}
        (change it in Settings → RSS, or per rule).{' '}
        {data && (
          <>
            {count('missing') ?? 0} with missing episodes · {count('ok') ?? 0} complete ·{' '}
            {count('empty') ?? 0} without episodes yet.
            {data.noFolder > 0 && (
              <span className="text-warning">
                {' '}
                {data.noFolder} enabled {data.noFolder === 1 ? 'rule has' : 'rules have'} no “Save
                to” folder and can&apos;t be checked.
              </span>
            )}
          </>
        )}
      </p>
      <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
        {shows.map((s) => {
          const [label, tone] = STATE[s.state];
          return (
            <li key={s.ruleId} className="flex items-start gap-3 px-4 py-3">
              <Badge tone={tone} className="mt-0.5 shrink-0">
                {label}
              </Badge>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="truncate text-sm font-medium">
                  {s.title ?? s.ruleName}
                  {s.season !== null && s.season > 1 && (
                    <span className="text-muted"> · Season {s.season}</span>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {s.have.length > 0 && <>Have {episodeRanges(s.have)}</>}
                  {s.added.length > 0 && (
                    <span className="text-success"> · Added {episodeRanges(s.added)}</span>
                  )}
                  {s.unavailable.length > 0 && (
                    <span className="text-warning">
                      {' '}
                      · Waiting for {episodeRanges(s.unavailable)}
                    </span>
                  )}
                  {s.message && (
                    <span className={s.state === 'error' ? 'text-danger' : ''}> · {s.message}</span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted/80" title={s.savePath}>
                  {s.savePath} · checked {when(s.checkedAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={data?.running || check.isPending}
                onClick={() => check.mutate([s.ruleId])}
              >
                Check
              </Button>
            </li>
          );
        })}
        {shows.length === 0 && (
          <li className="p-10 text-center text-sm text-muted">
            {data?.shows.length
              ? 'No show matches the filter.'
              : 'No enabled download rules with a save folder.'}
          </li>
        )}
      </ul>
    </section>
  );
}
