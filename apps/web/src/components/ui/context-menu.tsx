import * as CM from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { MenuAction } from '@/components/ui/menu';

/** Right-click menu rendering the same {@link MenuAction} list as the dropdown menu. */
export function ContextMenu({ actions, children }: { actions: MenuAction[]; children: ReactNode }) {
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="glass z-50 min-w-52 rounded-xl !bg-bg/90 p-1 data-[state=open]:animate-[fade-in_120ms_ease-out]">
          {actions.map((a) => (
            <div key={a.key}>
              {a.separatorBefore && <CM.Separator className="my-1 h-px bg-border" />}
              <CM.Item
                disabled={a.disabled}
                onSelect={a.onSelect}
                className={cn(
                  'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-hover [&_svg]:size-4 [&_svg]:text-muted',
                  a.danger && 'text-danger [&_svg]:!text-danger',
                )}
              >
                {a.icon}
                {a.label}
              </CM.Item>
            </div>
          ))}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
