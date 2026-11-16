'use client';
import * as React from 'react';
import * as M from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuPortal = M.Portal;

const itemClass =
  'relative flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-small text-text outline-none select-none data-[highlighted]:bg-surface-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-60 data-[variant=danger]:text-danger';

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof M.Content>,
  React.ComponentPropsWithoutRef<typeof M.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <M.Portal>
    <M.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('z-50 min-w-40 rounded-md border border-border bg-surface p-1 text-text', className)}
      {...props}
    />
  </M.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof M.Item>,
  React.ComponentPropsWithoutRef<typeof M.Item> & { variant?: 'danger' }
>(({ className, variant, ...props }, ref) => (
  <M.Item ref={ref} data-variant={variant} className={cn(itemClass, className)} {...props} />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof M.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof M.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <M.CheckboxItem ref={ref} className={cn(itemClass, 'pl-6', className)} {...props}>
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <M.ItemIndicator>
        <Check aria-hidden className="size-4" />
      </M.ItemIndicator>
    </span>
    {children}
  </M.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof M.Label>,
  React.ComponentPropsWithoutRef<typeof M.Label>
>(({ className, ...props }, ref) => (
  <M.Label ref={ref} className={cn('px-2 py-1 text-small text-muted', className)} {...props} />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof M.Separator>,
  React.ComponentPropsWithoutRef<typeof M.Separator>
>(({ className, ...props }, ref) => (
  <M.Separator ref={ref} className={cn('my-1 h-px bg-border', className)} {...props} />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';
