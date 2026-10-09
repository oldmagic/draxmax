import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Braces, Download, Loader2, RotateCcw, WandSparkles } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RssConfig } from '@draxmax/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { locateJsonError } from '@/lib/json-error';
import { cn } from '@/lib/utils';

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** Checks the text and returns the document, or a readable error with its line. */
function parse(text: string): { cfg: RssConfig } | { error: string; index?: number } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const at = locateJsonError(text);
    return { error: at.message, index: at.index };
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as RssConfig).feeds) ||
    !Array.isArray((value as RssConfig).rules)
  )
    return { error: 'Expected an object with "feeds" and "rules" arrays' };
  return { cfg: value as RssConfig };
}

/** "Edit as JSON": all feeds and download rules as one document, edited and saved at once. */
export function RssJsonEditorButton() {
  const [open, setOpen] = useState(false);
  // Escape / clicking outside shouldn't silently throw away edits.
  const dirty = useRef(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Braces /> Edit as JSON
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && dirty.current && !confirm('Discard your changes?')) return;
          dirty.current = false;
          setOpen(o);
        }}
      >
        <DialogContent
          title="Feeds & download rules (JSON)"
          description="Rules name their feeds by URL. Keep a rule's id to rename it; leave it out for a new rule."
          className="w-[min(96vw,64rem)]"
        >
          {open && (
            <Editor
              onDirty={(d) => (dirty.current = d)}
              onClose={() => {
                dirty.current = false;
                setOpen(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Editor({ onClose, onDirty }: { onClose(): void; onDirty(dirty: boolean): void }) {
  const qc = useQueryClient();
  const area = useRef<HTMLTextAreaElement>(null);
  const loaded = useQuery({
    queryKey: ['rss', 'config'],
    queryFn: api.rssConfig,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [text, setText] = useState<string | null>(null);
  const [removeMissing, setRemoveMissing] = useState(false);
  const original = loaded.data ? pretty(loaded.data) : '';
  const value = text ?? original;
  const dirty = text !== null && text !== original;
  onDirty(dirty);
  const parsed = useMemo(() => (value ? parse(value) : null), [value]);

  // What "delete missing" would remove, so it's never a surprise.
  const removals = useMemo(() => {
    if (!loaded.data || !parsed || 'error' in parsed) return { feeds: 0, rules: 0 };
    const urls = new Set(parsed.cfg.feeds.map((f) => f.url));
    const ids = new Set(parsed.cfg.rules.flatMap((r) => (r.id ? [r.id] : [])));
    const names = new Set(parsed.cfg.rules.map((r) => r.name));
    return {
      feeds: loaded.data.feeds.filter((f) => !urls.has(f.url)).length,
      rules: loaded.data.rules.filter((r) => !ids.has(r.id!) && !names.has(r.name)).length,
    };
  }, [loaded.data, parsed]);

  const save = useMutation({
    mutationFn: (cfg: RssConfig) => api.saveRssConfig({ ...cfg, removeMissing }),
    onSuccess: (res) => {
      const part = (n: { created: number; updated: number; deleted: number }, what: string) => {
        const bits = [
          n.created && `${n.created} added`,
          n.updated && `${n.updated} updated`,
          n.deleted && `${n.deleted} deleted`,
        ].filter(Boolean);
        return bits.length ? `${what} ${bits.join(', ')}` : '';
      };
      const summary = [part(res.feeds, 'Feeds:'), part(res.rules, 'Rules:')].filter(Boolean);
      toast.success(summary.length ? `Saved: ${summary.join(' · ')}` : 'Nothing changed');
      void qc.invalidateQueries({ queryKey: ['rss'] });
      onClose();
    },
    onError: (e) => toast.error(e.message, { duration: 10_000 }),
  });

  function submit() {
    if (!parsed || 'error' in parsed) return;
    if (
      removeMissing &&
      (removals.feeds || removals.rules) &&
      !confirm(
        `Delete ${removals.feeds} feeds and ${removals.rules} rules that aren't in the JSON?`,
      )
    )
      return;
    save.mutate(parsed.cfg);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `draxmax-rss-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loaded.isLoading)
    return (
      <div className="grid h-64 place-items-center">
        <Loader2 className="size-5 animate-spin text-muted" aria-label="Loading" />
      </div>
    );
  if (loaded.isError) return <p className="text-sm text-danger">{loaded.error.message}</p>;

  const error = parsed && 'error' in parsed ? parsed.error : null;
  const counts = parsed && !('error' in parsed) ? parsed.cfg : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={area}
        aria-label="Feeds and rules JSON"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the editor; Ctrl/⌘+S saves.
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${value.slice(0, a)}  ${value.slice(b)}`;
            setText(next);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className={cn(
          'h-[58vh] w-full resize-none rounded-xl border bg-surface-2 p-3 font-mono text-xs leading-5 text-fg outline-none [tab-size:2] focus:ring-2 focus:ring-accent/40',
          error && 'border-danger/60',
        )}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {error ? (
          <button
            type="button"
            title="Go to the error"
            className="flex items-center gap-1.5 text-left text-danger hover:underline"
            onClick={() => {
              const el = area.current;
              const at = parsed && 'index' in parsed ? (parsed.index ?? 0) : 0;
              if (!el) return;
              el.focus();
              el.setSelectionRange(at, Math.min(at + 1, value.length));
              // Scroll the line into view (the textarea doesn't do it for programmatic selections).
              const line = value.slice(0, at).split('\n').length;
              el.scrollTop = Math.max(0, (line - 5) * 20);
            }}
          >
            <AlertTriangle className="size-4 shrink-0" /> {error}
          </button>
        ) : (
          counts && (
            <span className="text-muted">
              {counts.feeds.length} feeds · {counts.rules.length} rules
              {dirty && ' · unsaved changes'}
            </span>
          )
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!!error}
          onClick={() => counts && setText(pretty(counts))}
        >
          <WandSparkles /> Format
        </Button>
        <Button size="sm" variant="ghost" onClick={download}>
          <Download /> Download
        </Button>
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setText(null)}>
          <RotateCcw /> Undo changes
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={removeMissing}
          onChange={(e) => setRemoveMissing(e.target.checked)}
          className="size-4 accent-[var(--accent)]"
        />
        Delete feeds and rules that aren&apos;t in the JSON
        {removeMissing && (removals.feeds > 0 || removals.rules > 0) && (
          <span className="text-danger">
            ({removals.feeds} feeds, {removals.rules} rules)
          </span>
        )}
      </label>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <p className="text-xs text-muted">
          Saving doesn&apos;t download anything already in the feeds. Ctrl/⌘+S saves.
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => (!dirty || confirm('Discard your changes?')) && onClose()}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!!error || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
