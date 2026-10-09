import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({
  children,
  align = 'end',
}: {
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={6}
        className="glass z-50 min-w-48 rounded-xl !bg-bg/90 p-1 data-[state=open]:animate-[fade-in_120ms_ease-out]"
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-hover [&_svg]:size-4 [&_svg]:text-muted',
        danger && 'text-danger [&_svg]:!text-danger',
      )}
    >
      {children}
    </Menu.Item>
  );
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-border" />;
}

/** One action, rendered identically by dropdown and context menus. */
export interface MenuAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function MenuActions({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <div key={a.key}>
          {a.separatorBefore && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={a.onSelect} danger={a.danger} disabled={a.disabled}>
            {a.icon}
            {a.label}
          </DropdownMenuItem>
        </div>
      ))}
    </>
  );
}
