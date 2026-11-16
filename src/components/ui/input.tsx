import * as React from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'w-full rounded-sm border border-border-input bg-surface px-2 text-small text-text placeholder:text-muted transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type} className={cn(fieldClass, 'h-control', className)} {...props} />
  ),
);
Input.displayName = 'Input';
