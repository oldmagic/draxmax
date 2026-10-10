import { useState } from 'react';
import { toast } from 'sonner';
import { PathInput } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useDownloadsUi } from '@/stores/downloads';
import { useTorrents } from '@/stores/torrents';

/** Changes where torrents live, moving their files there (or just pointing at them). */
export function MoveDialog() {
  const ids = useDownloadsUi((s) => s.moveIds);
  const close = () => useDownloadsUi.getState().askMove(null);
  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Move to another folder"
        description={
          ids && ids.length > 1 ? `${ids.length} torrents` : 'Pick where this torrent should live.'
        }
      >
        {ids && <MoveForm ids={ids} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function MoveForm({ ids, onDone }: { ids: string[]; onDone(): void }) {
  const current = useTorrents((s) => s.torrents.find((t) => t.id === ids[0])?.savePath ?? '');
  const [path, setPath] = useState(current);
  const [moveFiles, setMoveFiles] = useState(true);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) => api.setLocation(id, path.trim(), moveFiles)),
    );
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected');
    for (const r of results) if (r.status === 'fulfilled') useTorrents.getState().upsert(r.value);
    if (failed.length) toast.error((failed[0] as PromiseRejectedResult).reason.message as string);
    else
      toast.success(moveFiles ? 'Moving files' : 'Folder changed', {
        description: moveFiles
          ? 'The torrent continues from the new folder when the move is done.'
          : 'The files there are being checked.',
      });
    onDone();
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      <PathInput value={path} onChange={setPath} aria-label="New folder" placeholder="/path" />
      <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm">Move the files there</div>
          <div className="text-xs text-muted">
            Turn off if you already moved them yourself: DraxMax then just checks the new folder.
          </div>
        </div>
        <Switch label="Move the files there" checked={moveFiles} onChange={setMoveFiles} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !path.trim() || path.trim() === current}
        >
          {moveFiles ? 'Move' : 'Change folder'}
        </Button>
      </div>
    </form>
  );
}
