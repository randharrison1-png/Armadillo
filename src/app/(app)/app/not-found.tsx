import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

export default function AppNotFound() {
  return (
    <div className="flex flex-col items-center gap-2 p-6 text-center">
      <FileQuestion aria-hidden className="size-6 text-muted" />
      <h1 className="text-h1 font-semibold text-text">Page not found</h1>
      <p className="max-w-md text-small text-muted">That page does not exist, or it belongs to another account.</p>
      <Link href="/app" className={buttonVariants({ className: 'mt-2' })}>
        Back to the dashboard
      </Link>
    </div>
  );
}
