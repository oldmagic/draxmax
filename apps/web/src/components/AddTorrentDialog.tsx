import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FileText, FileUp, FolderDown, Link2, Loader2, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { isAbsolutePath, MAGNET_RE, TORRENT_URL_RE } from '@draxmax/shared';
import { PathInput, useSavePlaces } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { actions } from '@/lib/actions';
import { api, fileToBase64 } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useUi } from '@/stores/ui';

/**
 * Accepts magnet links or http(s) .torrent links (one per line), and .torrent files. Picked or
 * dropped files are only listed; everything is added when the user clicks Add.
 */
export function AddTorrentDialog() {
  const { addOpen, addPrefill, closeAdd } = useUi();
  return (
    <Dialog open={addOpen} onOpenChange={(o) => !o && closeAdd()}>
      <DialogContent
        title="Add torrents"
        description="Paste magnet or torrent links, or drop .torrent files."
      >
        {/* Content unmounts when closed, so the form starts fresh from the prefill each time. */}
        <AddTorrentForm initialText={addPrefill} onDone={closeAdd} />
      </DialogContent>
    </Dialog>
  );
}

function AddTorrentForm({ initialText, onDone }: { initialText: string; onDone(): void }) {
  const closeAdd = onDone;
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { addFiles: files, stageFiles, unstageFile, setStagedFiles } = useUi();
  const [showOptions, setShowOptions] = useState(false);
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [paused, setPaused] = useState(false);
  const [sequential, setSequential] = useState(false);
  const [savePath, setSavePath] = useState('');
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const { defaultPath } = useSavePlaces();
  // Where torrents go when no folder is chosen: the category's folder, else the default.
  const fallbackPath =
    categories.find((c) => c.name === category.trim())?.savePath ?? defaultPath ?? '';
  const pathInvalid = savePath.trim() !== '' && !isAbsolutePath(savePath.trim());
  const extra = {
    savePath: savePath.trim() || undefined,
    category: category.trim() || undefined,
    tags: tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    paused,
    sequential,
  };

  const links = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = links.filter((l) => !MAGNET_RE.test(l) && !TORRENT_URL_RE.test(l));

  const total = links.length + files.length;
  const canSubmit = !busy && total > 0 && invalid.length === 0 && !pathInvalid;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const failedLinks: string[] = [];
    for (const l of links) {
      const added = MAGNET_RE.test(l)
        ? await actions.addMagnet(l, extra)
        : await actions.addUrl(l, extra);
      if (!added) failedLinks.push(l);
    }
    const failedFiles: File[] = [];
    for (const f of files) {
      if (!(await actions.addTorrentFile(f.name, await fileToBase64(f), extra)))
        failedFiles.push(f);
    }
    setBusy(false);
    // Keep only what failed, so it can be fixed and retried.
    if (failedLinks.length === 0 && failedFiles.length === 0) return closeAdd();
    setText(failedLinks.join('\n'));
    setStagedFiles(failedFiles);
  }

  async function pick() {
    if (desktop) {
      const picked = await desktop.pickTorrentFiles();
      stageFiles(
        picked.map(
          (p) => new File([Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0))], p.name),
        ),
      );
    } else {
      fileInput.current?.click();
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    stageFiles([...e.dataTransfer.files]);
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Link2 className="size-4 text-muted" /> Magnet or torrent links
        </span>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
          placeholder={'magnet:?xt=urn:btih:…\nhttps://example.org/file.torrent  (one per line)'}
          className="font-mono text-xs"
          aria-invalid={invalid.length > 0}
        />
        {invalid.length > 0 && (
          <span className="mt-1 block text-xs text-danger">
            {invalid.length === 1 ? 'One line is' : `${invalid.length} lines are`} not a magnet or
            http(s) link.
          </span>
        )}
      </label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragging ? 'border-accent bg-accent/10' : 'border-border',
        )}
      >
        <FileUp className={cn('size-6', dragging ? 'text-accent' : 'text-muted')} />
        <p className="text-sm text-muted">
          Drop <span className="font-medium text-fg">.torrent</span> files here or{' '}
          <button
            type="button"
            onClick={() => void pick()}
            className="font-medium text-accent hover:underline"
          >
            browse
          </button>
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".torrent,application/x-bittorrent"
          multiple
          hidden
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            e.target.value = '';
            if (picked.length) stageFiles(picked);
          }}
        />
      </div>

      {files.length > 0 && (
        <ul aria-label="Torrent files to add" className="space-y-1.5">
          {files.map((f) => (
            <li
              key={`${f.name}:${f.size}`}
              className="flex items-center gap-2 rounded-lg bg-surface-2 py-1.5 pr-1.5 pl-3 text-sm"
            >
              <FileText className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {formatBytes(f.size)}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${f.name}`}
                disabled={busy}
                onClick={() => unstageFile(f)}
                className="shrink-0"
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <label
          htmlFor="add-save-path"
          className="mb-1.5 flex items-center gap-1.5 text-sm font-medium"
        >
          <FolderDown className="size-4 text-muted" /> Save to
        </label>
        <PathInput
          id="add-save-path"
          value={savePath}
          onChange={setSavePath}
          placeholder={fallbackPath}
          inputClassName="h-9"
        />
        <span className={cn('mt-1 block text-xs', pathInvalid ? 'text-danger' : 'text-muted')}>
          {pathInvalid
            ? 'Use a full path, e.g. /mnt/nas/Movies.'
            : savePath.trim()
              ? 'Overrides the default and category folder for these torrents.'
              : 'Leave empty to use the default or category folder.'}
        </span>
      </div>

      <div className="rounded-xl border">
        <button
          type="button"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium"
        >
          Options
          <ChevronDown
            className={cn('size-4 text-muted transition-transform', showOptions && 'rotate-180')}
          />
        </button>
        {showOptions && (
          <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted">Category</span>
              <Input
                list="add-categories"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="None"
                className="h-9"
              />
              <datalist id="add-categories">
                {categories.map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted">Tags (comma-separated)</span>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. linux, iso"
                className="h-9"
              />
            </label>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
              Start paused
              <Switch label="Start paused" checked={paused} onChange={setPaused} />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
              Sequential download
              <Switch label="Sequential download" checked={sequential} onChange={setSequential} />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={closeAdd}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
          {busy && <Loader2 className="animate-spin" />}
          Add {total > 1 ? `${total} torrents` : 'torrent'}
        </Button>
      </div>
    </div>
  );
}
