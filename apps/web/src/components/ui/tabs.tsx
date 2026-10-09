import * as T from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export const TabsContent = ({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) => (
  <T.Content value={value} className={cn('outline-none', className)}>
    {children}
  </T.Content>
);

export function TabsList({
  items,
  className,
}: {
  items: { value: string; label: ReactNode }[];
  className?: string;
}) {
  return (
    <T.List className={cn('flex gap-1 rounded-xl bg-surface-2 p-1', className)}>
      {items.map((i) => (
        <T.Trigger
          key={i.value}
          value={i.value}
          className="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-bg data-[state=active]:text-fg data-[state=active]:shadow-sm"
        >
          {i.label}
        </T.Trigger>
      ))}
    </T.List>
  );
}
