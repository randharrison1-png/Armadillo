'use client';

import { Button } from '@/components/ui/button';
import { getWorkspaceStore } from '@/features/workspace/store';
import { readmeTab, useReadmeUi } from './readmeUi';

export type ReadmeInspectorItem = { id: string; label: string; hasText: boolean };

/**
 * Inspector "README" section: the session's READMEs (newest first; the latest is what the README
 * tab shows by default), the open_readme step status, and the Add README action.
 */
export function ReadmeInspectorSection({
  sessionId,
  completed,
  stepLabel,
  items,
}: {
  sessionId: string;
  completed: boolean;
  stepLabel: string;
  items: ReadmeInspectorItem[];
}) {
  const openIntake = useReadmeUi((s) => s.openIntake);
  const open = (id: string | null, label?: string) => getWorkspaceStore(sessionId).getState().openTab(id ? readmeTab(id, label) : readmeTab());
  return (
    <div className="flex flex-col gap-2">
      <p>
        Open README step: <span data-testid="readme-step-status" className="text-text">{stepLabel}</span>
      </p>
      {items.length === 0 ? (
        <>
          <p>No README yet.</p>
          <Button variant="secondary" onClick={() => open(null)}>
            Show README tab
          </Button>
        </>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal py-1 text-left"
                aria-label={`Open README ${it.label}${i === 0 ? ' (latest)' : ''}${it.hasText ? '' : ' (no text)'}`}
                onClick={() => (i === 0 ? open(null) : open(it.id, it.label))}
              >
                <span className="min-w-0 break-words">
                  {it.label}
                  {i === 0 ? ' · latest' : ''}
                  {it.hasText ? '' : ' · no text'}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {completed ? <p>This session is completed; READMEs can no longer be added.</p> : <Button onClick={() => openIntake(sessionId, 'paste')}>Add README</Button>}
    </div>
  );
}
