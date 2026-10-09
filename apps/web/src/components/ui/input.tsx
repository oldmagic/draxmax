import type { ComponentProps, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const base =
  'w-full rounded-xl border bg-surface-2 px-3 text-sm text-fg placeholder:text-muted/70 transition-colors focus:border-accent focus:outline-none focus:ring-3 focus:ring-ring/40';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(base, 'h-10', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'min-h-24 py-2.5 resize-none', className)} {...props} />;
}
