'use client';

import { ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openRequirements } from './matrix';

/** Inspector "Requirements" section: opens the session's requirements matrix tab. */
export function RequirementsInspectorSection({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p>README requirements, their coverage by a script, and what has been verified.</p>
      <Button variant="secondary" onClick={() => openRequirements(sessionId)}>
        <ListChecks aria-hidden className="size-4" />
        Open requirements
      </Button>
    </div>
  );
}
