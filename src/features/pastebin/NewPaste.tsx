'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PublishDialog } from './PublishDialog';

/** /p/new: the publish dialog, open from the start. Nothing is published until the user presses Publish. */
export function NewPaste() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <h1 className="text-h1 font-semibold text-text">New paste</h1>
      <p className="text-small text-muted">Pastes are public to anyone with the link. Nothing from your private workspace is published unless you choose to.</p>
      <div>
        <Button onClick={() => setOpen(true)}>
          <Plus aria-hidden className="size-4" />
          New paste
        </Button>
      </div>
      <PublishDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
