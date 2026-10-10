import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { SearchSourceDTO } from '@draxmax/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';

/**
 * The search sources that aren't tracker sites: the built-in anime indexers and Torznab
 * endpoints (Prowlarr / Jackett). Together with the sites they are everything that search
 * and the missing-episode check ask.
 */
export function SearchSources() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['search-sources'], queryFn: api.searchSources });
  const [url, setUrl] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const done = (list: SearchSourceDTO[]) => {
    qc.setQueryData(['search-sources'], list);
    void qc.invalidateQueries({ queryKey: ['missing'] });
  };
  const fail = (e: Error) => toast.error(e.message);
  const add = useMutation({
    mutationFn: () => api.addTorznab(url.trim()),
    onSuccess: (list) => {
      setUrl('');
      done(list);
      toast.success('Indexer added');
    },
    onError: fail,
  });
  const test = (s: SearchSourceDTO) => {
    setTesting(s.id);
    // Something every indexer has plenty of.
    void api
      .testSource(s.id, '1080p')
      .then((r) =>
        r.ok
          ? toast.success(`${s.name} works`, {
              description: `${r.total} results, e.g. ${r.sample[0]}`,
            })
          : toast.error(`${s.name}: ${r.error ?? 'no results'}`),
      )
      .catch(fail)
      .finally(() => setTesting(null));
  };
  const others = data.filter((s) => s.kind !== 'site');

  return (
    <div className="space-y-2 border-t p-2 pt-3">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Indexers</div>
      <ul className="space-y-0.5" aria-label="Indexers">
        {others.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate">{s.kind === 'torznab' ? 'Torznab' : s.name}</div>
              <div className="truncate text-xs text-muted">
                {s.kind === 'torznab' ? s.detail : 'Anime · built in'}
              </div>
            </div>
            {s.locked && (
              <span title="Set by an environment variable">
                <Lock className="size-3.5 text-muted" />
              </span>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Test ${s.name}`}
              title="Test"
              disabled={testing !== null || !s.enabled}
              onClick={() => test(s)}
            >
              {testing === s.id ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            </Button>
            {s.kind === 'builtin' ? (
              <Switch
                label={`Search ${s.name}`}
                checked={s.enabled}
                disabled={s.locked}
                onChange={(v) => void api.setSourceEnabled(s.id, v).then(done, fail)}
              />
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${s.name}`}
                disabled={s.locked}
                onClick={() =>
                  confirm(`Remove ${s.name}?`) && void api.removeSource(s.id).then(done, fail)
                }
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) add.mutate();
        }}
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Torznab URL"
          placeholder="Prowlarr / Jackett Torznab URL"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Button type="submit" size="icon-sm" aria-label="Add indexer" disabled={add.isPending}>
          <Plus />
        </Button>
      </form>
      <p className="px-1 text-[11px] leading-snug text-muted">
        Paste the Torznab feed URL including <code>apikey=</code>. Needed for live-action TV unless
        a site carries it.
      </p>
    </div>
  );
}
