'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { getWorkspaceStore } from '@/features/workspace/store';
import { tabFromParams } from './tabFromLink';

/** Opens the tab a `?tab=` deep link asks for (once per link) in this session's workspace. */
export function OpenTabFromLink({ sessionId }: { sessionId: string }) {
  const params = useSearchParams();
  const link = params.toString();
  useEffect(() => {
    const tab = tabFromParams(new URLSearchParams(link));
    if (tab) getWorkspaceStore(sessionId).getState().openTab(tab);
  }, [sessionId, link]);
  return null;
}
