'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { getWorkspaceStore } from '@/features/workspace/store';
import { proposeAdaptationAction } from './actions';
import { proposalTab } from './review';

/**
 * "Propose adaptation" for a session workspace: asks Claude (server action), then opens the proposal
 * in a diff tab of that session. Returns the error message on failure (null on success).
 */
export function useProposeAdaptation(sessionId: string) {
  const [running, setRunning] = useState(false);
  const run = async (input: { scriptVersionId: string; readmeId: string }): Promise<string | null> => {
    setRunning(true);
    try {
      const res = await proposeAdaptationAction({ sessionId, ...input }).catch(() => ({ ok: false as const, error: 'Could not reach the server. Try again.' }));
      if (!res.ok) return res.error;
      getWorkspaceStore(sessionId).getState().openTab(proposalTab(res.proposalId, res.filename));
      const notes = [
        res.droppedFlags ? `${res.droppedFlags} of Claude's flags pointed at lines that do not exist and ${res.droppedFlags === 1 ? 'was' : 'were'} ignored.` : null,
        res.readmeTrimmed ? 'The README was too long to send in full; requirements near its end may be missing.' : null,
      ].filter(Boolean);
      toast.success('Claude proposed an adaptation. Review it before accepting.', notes.length ? { description: notes.join(' ') } : undefined);
      return null;
    } finally {
      setRunning(false);
    }
  };
  return { run, running };
}
