import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getSession } from '@/features/sessions/queries';

/**
 * 404 gate. Unknown (or another account's) sessions must answer 404, but page.tsx renders inside
 * loading.tsx's Suspense boundary, whose shell is flushed with a 200 before the page can call
 * notFound(). A layout renders outside that boundary, so the status is still open here.
 */
export default async function SessionLayout({ children, params }: { children: ReactNode; params: Promise<{ sessionId: string }> }) {
  if (!(await getSession((await params).sessionId))) notFound();
  return children;
}
