import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { buttonVariants } from '@/components/ui/button';

// Expired, deleted and never-existed pastes all land here: the page does not say which.
export default function NotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="This paste has expired or doesn't exist"
      actions={
        <Link href="/p" className={buttonVariants({ variant: 'secondary' })}>
          Browse public pastes
        </Link>
      }
    />
  );
}
