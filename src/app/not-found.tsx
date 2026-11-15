import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-bg p-6 text-center">
      <FileQuestion aria-hidden className="size-6 text-muted" />
      <h1 className="text-h1 font-semibold text-text">Page not found</h1>
      <p className="max-w-md text-small text-muted">That address does not exist, or it has moved.</p>
      <Link href="/app" className={buttonVariants({ className: 'mt-2' })}>
        Go to the workspace
      </Link>
    </main>
  );
}
