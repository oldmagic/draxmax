import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  className?: string;
  size?: 'md' | 'sm';
}

/** Accessible toggle (role="switch"). `label` is used as the accessible name. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  size = 'md',
}: SwitchProps) {
  const sm = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        sm ? 'h-5 w-8' : 'h-6 w-10',
        checked ? 'bg-accent' : 'bg-fg/15',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-white shadow transition-transform duration-200',
          sm ? 'size-4' : 'size-5',
          checked ? (sm ? 'translate-x-[14px]' : 'translate-x-[18px]') : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
