'use client';

import { useFormStatus } from 'react-dom';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signOut } from '@/server/auth/actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" loading={pending}>
      {pending ? null : <LogOut aria-hidden className="size-4" />}
      Sign out
    </Button>
  );
}

/** Sign-out control; the Task 5 sidebar account menu reuses it. */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <Submit />
    </form>
  );
}
