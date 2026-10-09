import * as T from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-lg bg-fg px-2 py-1 text-xs font-medium text-bg shadow-lg"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
