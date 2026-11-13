'use client';
import * as React from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { cn } from '@/lib/utils';

export const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof Group>) => (
  <Group className={cn('flex size-full', className)} {...props} />
);

export const ResizablePanel = Panel;

export const ResizableHandle = ({ className, ...props }: React.ComponentProps<typeof Separator>) => (
  <Separator
    className={cn(
      'w-px shrink-0 bg-border transition-colors duration-150 hover:bg-accent data-[separator=active]:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
      className,
    )}
    {...props}
  />
);
