import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { NewPaste } from '@/features/pastebin/NewPaste';
import { getCurrentUser } from '@/server/auth';

export const metadata: Metadata = { title: 'New paste · Armadillo Pastebin', robots: { index: false } };

export default async function Page() {
  if (!(await getCurrentUser())) redirect('/login?next=/p/new');
  return <NewPaste />;
}
