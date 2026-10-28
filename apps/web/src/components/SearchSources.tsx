import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CONTENT_TYPES, type ContentType, type SearchSourceDTO } from '@draxmax/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';

const TYPE_LABEL: Record<ContentType, string> = { anime: 'Anime', tv: 'TV', movies: 'Movies' };

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
  const [editing, setEditing] = useState<SearchSourceDTO | null>(null);
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
                {s.kind === 'torznab'
                  ? s.detail
                  : `${s.detail} · ${
                      s.contentTypes.length
                        ? s.contentTypes.map((t) => TYPE_LABEL[t]).join(', ')
                        : 'Everything'
                    }`}
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
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${s.name}`}
              title="Edit"
              disabled={s.kind === 'torznab' && s.locked}
              onClick={() => setEditing(s)}
            >
              <Pencil />
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
      {editing && (
        <EditSource
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            setEditing(null);
            done(list);
            toast.success(`${editing.kind === 'torznab' ? 'Indexer' : editing.name} saved`);
          }}
        />
      )}
    </div>
  );
}

/** A built-in indexer's address and content, or a Torznab endpoint's URL. */
function EditSource({
  source,
  onClose,
  onSaved,
}: {
  source: SearchSourceDTO;
  onClose: () => void;
  onSaved: (list: SearchSourceDTO[]) => void;
}) {
  const builtin = source.kind === 'builtin';
  // The Torznab URL holds its API key and is never sent back, so it's entered again.
  const [url, setUrl] = useState(builtin ? (source.url ?? '') : '');
  const [types, setTypes] = useState<ContentType[]>(source.contentTypes);
  const save = useMutation({
    mutationFn: (reset: boolean) =>
      api.editSource(
        source.id,
        builtin
          ? reset
            ? { url: null, contentTypes: null }
            : { url: url.trim() || null, contentTypes: types }
          : { url: url.trim() },
      ),
    onSuccess: onSaved,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Edit ${builtin ? source.name : 'Torznab indexer'}`}
        description={
          builtin
            ? 'Point it at a mirror, or choose what it is searched for.'
            : `Replace the URL of ${source.detail ?? 'this indexer'}.`
        }
        className="w-[min(94vw,30rem)]"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(false);
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{builtin ? 'Address' : 'Torznab URL'}</span>
            <Input
              autoFocus
              required={!builtin}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={
                builtin ? (source.defaultUrl ?? '') : 'http://prowlarr:9696/1/api?apikey=…'
              }
            />
            <span className="block text-xs text-muted">
              {builtin
                ? `Default ${source.defaultUrl}. A mirror must serve the same pages.`
                : 'Include apikey=. The current key is not shown.'}
            </span>
          </label>
          {builtin && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">What it carries</span>
              <div className="flex flex-wrap gap-4 pt-1">
                {CONTENT_TYPES.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={types.includes(t)}
                      onChange={(e) =>
                        setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))
                      }
                    />
                    {TYPE_LABEL[t]}
                  </label>
                ))}
              </div>
              <span className="block text-xs text-muted">
                It is only searched for these. Leave all unticked to search it for everything.
              </span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            {builtin && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                disabled={save.isPending}
                onClick={() => save.mutate(true)}
              >
                Reset to default
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
