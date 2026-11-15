import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { buttonVariants } from '@/components/ui/button';

export default function ScriptNotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Script not found"
      description="It may have been archived, or it belongs to another account."
      actions={
        <Link href="/app/library" className={buttonVariants({ variant: 'secondary' })}>
          Back to the library
        </Link>
      }
    />
  );
}
