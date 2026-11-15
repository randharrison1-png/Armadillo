import Link from 'next/link';
import { FolderX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/shell/states/EmptyState';

export default function SessionNotFound() {
  return (
    <EmptyState
      icon={FolderX}
      title="Session not found"
      description="It may have been removed, or it belongs to another account."
      actions={
        <Link href="/app/sessions" className={buttonVariants({ variant: 'secondary' })}>
          Back to sessions
        </Link>
      }
    />
  );
}
