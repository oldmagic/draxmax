import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Right-hand side panel built on Radix Dialog. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
        <D.Content className="glass fixed inset-y-2 right-2 z-50 flex w-[min(96vw,40rem)] flex-col rounded-2xl !bg-bg/95 data-[state=open]:animate-[sheet-in_220ms_cubic-bezier(0.2,0.9,0.3,1)]">
          <div className="flex items-start justify-between gap-4 border-b px-6 py-5">
            <div className="min-w-0">
              <D.Title className="truncate text-lg font-semibold tracking-tight">{title}</D.Title>
              <D.Description className="mt-1 text-sm text-muted">{description ?? ''}</D.Description>
            </div>
            <D.Close
              className="rounded-lg p-1.5 text-muted transition hover:bg-surface-hover hover:text-fg"
              aria-label="Close"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
