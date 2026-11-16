import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { loadScriptPage } from '@/features/library/pageData';

/** 404 gate outside loading.tsx's Suspense boundary, so the response status stays 404 (see the session layout). */
export default async function ScriptLayout({ children, params }: { children: ReactNode; params: Promise<{ scriptId: string }> }) {
  if (!(await loadScriptPage((await params).scriptId))) notFound();
  return children;
}
