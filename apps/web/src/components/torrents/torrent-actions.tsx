import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  Info,
  Megaphone,
  Pause,
  Play,
  RefreshCw,
  Tag,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { TorrentDTO } from '@draxmax/shared';
import type { MenuAction } from '@/components/ui/menu';
import { actions } from '@/lib/actions';
import { desktop } from '@/lib/desktop';
import { useDownloadsUi } from '@/stores/downloads';

const isStopped = (t: TorrentDTO) => t.status === 'paused' || t.status === 'error';

/** Actions for one or many torrents; shared by dropdown, context menu and keyboard. */
export function torrentActions(targets: TorrentDTO[]): MenuAction[] {
  const ui = useDownloadsUi.getState();
  const ids = targets.map((t) => t.id);
  const single = targets.length === 1 ? targets[0]! : null;
  const anyRunning = targets.some((t) => !isStopped(t));
  const anyStopped = targets.some(isStopped);
  const n = targets.length > 1 ? ` (${targets.length})` : '';

  const list: MenuAction[] = [];
  if (anyStopped)
    list.push({
      key: 'resume',
      label: `Resume${n}`,
      icon: <Play />,
      onSelect: () => void actions.resume(ids),
    });
  if (anyRunning)
    list.push({
      key: 'pause',
      label: `Pause${n}`,
      icon: <Pause />,
      onSelect: () => void actions.pause(ids),
    });
  if (single) {
    list.push({
      key: 'details',
      label: 'Details',
      icon: <Info />,
      onSelect: () => ui.openDetail(single.id),
    });
  }
  list.push(
    {
      key: 'category',
      label: 'Set category…',
      icon: <Tag />,
      onSelect: () => ui.askCategory(ids),
      separatorBefore: true,
    },
    {
      key: 'reannounce',
      label: 'Force reannounce',
      icon: <Megaphone />,
      onSelect: () => void actions.reannounce(ids),
    },
    {
      key: 'recheck',
      label: 'Force recheck',
      icon: <RefreshCw />,
      onSelect: () => void actions.recheck(ids),
    },
    {
      key: 'q-top',
      label: 'Move to top of queue',
      icon: <ArrowUpToLine />,
      onSelect: () => void actions.queue(ids, 'top'),
      separatorBefore: true,
    },
    {
      key: 'q-up',
      label: 'Move up',
      icon: <ChevronUp />,
      onSelect: () => void actions.queue(ids, 'up'),
    },
    {
      key: 'q-down',
      label: 'Move down',
      icon: <ChevronDown />,
      onSelect: () => void actions.queue(ids, 'down'),
    },
    {
      key: 'q-bottom',
      label: 'Move to bottom',
      icon: <ArrowDownToLine />,
      onSelect: () => void actions.queue(ids, 'bottom'),
    },
  );
  if (single?.magnetURI) {
    list.push({
      key: 'copy',
      label: 'Copy magnet link',
      icon: <Copy />,
      separatorBefore: true,
      onSelect: () =>
        void navigator.clipboard
          .writeText(single.magnetURI!)
          .then(() => toast.success('Magnet link copied')),
    });
  }
  if (single) {
    list.push({
      key: 'copy-path',
      label: 'Copy save path',
      icon: <Copy />,
      separatorBefore: !single.magnetURI,
      onSelect: () =>
        void navigator.clipboard
          .writeText(single.savePath)
          .then(() => toast.success('Save path copied')),
    });
  }
  if (single && desktop) {
    list.push({
      key: 'open',
      label: 'Open folder',
      icon: <FolderOpen />,
      onSelect: () => void desktop?.openPath(single.savePath),
    });
  }
  list.push({
    key: 'remove',
    label: `Remove${n}…`,
    icon: <Trash2 />,
    danger: true,
    separatorBefore: true,
    onSelect: () => ui.askRemove(ids),
  });
  return list;
}
