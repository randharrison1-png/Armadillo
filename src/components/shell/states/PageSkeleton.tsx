import { cn } from '@/lib/utils';

type Variant = 'list' | 'detail' | 'form' | 'paste';

const bar = 'animate-pulse rounded-sm bg-surface motion-reduce:animate-none';
const block = 'animate-pulse rounded-md border border-border bg-surface motion-reduce:animate-none';

/**
 * Route-level loading skeleton (loading.tsx): a few neutral placeholder blocks shaped like the page
 * that is coming, announced to assistive tech as a busy status. Shown while a page's server render
 * is pending during client navigation.
 */
export function PageSkeleton({ label, variant = 'list' }: { label: string; variant?: Variant }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn('flex flex-col', variant === 'detail' ? 'h-full min-h-0' : variant === 'paste' ? 'gap-4' : 'gap-6 p-6')}
    >
      <span className="sr-only">{label}</span>
      {variant === 'detail' ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
            <div className={cn(bar, 'h-6 w-48')} />
          </div>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
            <div className={cn(bar, 'h-6 w-24 bg-surface-raised')} />
            <div className={cn(bar, 'h-6 w-24 bg-surface-raised')} />
          </div>
          <div className="flex flex-1 flex-col gap-4 p-4">
            <div className={cn(block, 'h-16')} />
            <div className={cn(block, 'h-16')} />
          </div>
        </>
      ) : variant === 'paste' ? (
        <>
          <div className={cn(bar, 'h-10 w-2/3')} />
          <div className={cn(bar, 'h-5 w-1/2')} />
          <div className={cn(block, 'h-64')} />
        </>
      ) : variant === 'form' ? (
        <>
          <div className={cn(bar, 'h-10 w-48')} />
          <div className="flex max-w-2xl flex-col gap-6">
            <div className={cn(block, 'h-24')} />
            <div className={cn(block, 'h-24')} />
            <div className={cn(block, 'h-24')} />
          </div>
        </>
      ) : (
        <>
          <div className={cn(bar, 'h-10 w-48')} />
          <div className="flex flex-col gap-2">
            <div className={cn(block, 'h-16')} />
            <div className={cn(block, 'h-16')} />
            <div className={cn(block, 'h-16')} />
          </div>
        </>
      )}
    </div>
  );
}
