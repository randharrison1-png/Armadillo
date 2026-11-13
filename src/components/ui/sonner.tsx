'use client';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster"
      toastOptions={{
        classNames: {
          toast: 'bg-surface text-text border border-border rounded-md',
          description: 'text-muted',
          actionButton: 'bg-accent text-accent-ink',
        },
      }}
      {...props}
    />
  );
}
