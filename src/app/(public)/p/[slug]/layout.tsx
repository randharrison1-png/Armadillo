import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { loadPaste } from '@/features/pastebin/load';

/**
 * 404 gate for unknown, deleted and expired pastes (they look the same). It sits outside
 * loading.tsx's Suspense boundary so the response status stays 404 (see the session layout).
 */
export default async function PasteLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  if (!(await loadPaste((await params).slug))) notFound();
  return children;
}
