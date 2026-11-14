'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { uploadWithRetry } from '@/lib/files/uploadClient';
import { ALLOWED_EXTENSIONS, MAX_TEXT_BYTES, validateUpload } from '@/server/files/limits';
import { getWorkspaceStore } from '@/features/workspace/store';
import { addPastedReadmeAction, prepareReadmeUpload, recordUploadedReadme, type ReadmeActionError, type ReadmeAdded } from './actions';
import { readmeTab, useReadmeUi, type IntakeTab } from './readmeUi';

const ACCEPT = ALLOWED_EXTENSIONS.readme.join(',');

function FieldError({ id, message }: { id?: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-2 text-small text-danger">
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      {message}
    </p>
  );
}

/**
 * The "Add README" dialog (Paste | Upload) for one session. Mount once per session page; open it
 * with `useReadmeUi.getState().openIntake(sessionId, tab?)` from any button (tab empty state,
 * inspector). On success it opens/activates the README tab and refreshes server data.
 */
export function ReadmeIntakeHost({ sessionId }: { sessionId: string }) {
  const tab = useReadmeUi((s) => s.intake[sessionId]);
  // Mounted only while open, so every opening starts from the requested tab with clean fields.
  return tab ? <IntakeDialog sessionId={sessionId} initialTab={tab} /> : null;
}

function IntakeDialog({ sessionId, initialTab }: { sessionId: string; initialTab: IntakeTab }) {
  const router = useRouter();
  const closeIntake = useReadmeUi((s) => s.closeIntake);

  const [active, setActive] = useState<IntakeTab>(initialTab);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const ids = { text: useId(), file: useId() };

  const pasteTooLarge = new Blob([text]).size > MAX_TEXT_BYTES;

  const finish = (result: ReadmeAdded | ReadmeActionError) => {
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    const ui = useReadmeUi.getState();
    ui.bumpVersion(sessionId);
    ui.closeIntake(sessionId);
    getWorkspaceStore(sessionId).getState().openTab(readmeTab());
    setPending(false);
    toast.success(result.hasText ? 'README added' : 'README saved, but it has no extractable text');
    router.refresh();
  };

  const submitPaste = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (text.trim() === '') return setError('Paste the README text first.');
    if (pasteTooLarge) return setError('That text is over 2 MB. Paste a shorter README.');
    setError(null);
    setPending(true);
    try {
      finish(await addPastedReadmeAction({ sessionId, pasted: text }));
    } catch {
      finish({ ok: false, error: 'Could not add the README. Check your connection and try again.' });
    }
  };

  const submitUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!file) return setError('Choose a .txt, .md or .pdf file.');
    setError(null);
    setPending(true);
    try {
      const prepared = await prepareReadmeUpload(sessionId, file.name, file.size);
      if (!prepared.ok) return finish(prepared);
      const { storagePath } = await uploadWithRetry(file, prepared.target, { fields: { kind: 'readme', sessionId } });
      finish(await recordUploadedReadme({ sessionId, storagePath }));
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : 'Upload failed. Try again.' });
    }
  };

  const onFile = (f: File | null) => {
    setFile(null);
    setError(null);
    if (!f) return setFileError(null);
    try {
      validateUpload(f.name, f.size, 'readme');
      setFile(f);
      setFileError(null);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'That file cannot be used.');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && closeIntake(sessionId)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add README</DialogTitle>
          <DialogDescription>
            The README for this image. It stays with this session; you will not need to enter it again. Its text is treated as data, never as instructions.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={active}
          onValueChange={(v) => {
            setActive(v as IntakeTab);
            setError(null);
          }}
        >
          <TabsList>
            <TabsTrigger value="paste">Paste</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
          </TabsList>
          <TabsContent value="paste" className="pt-4">
            <form onSubmit={submitPaste} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.text} className="text-small font-medium text-text">
                  README text
                </label>
                <Textarea
                  id={ids.text}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setError(null);
                  }}
                  rows={10}
                  className="font-mono"
                  disabled={pending}
                  aria-invalid={error || pasteTooLarge ? true : undefined}
                />
              </div>
              <FieldError message={error ?? (pasteTooLarge ? 'That text is over 2 MB. Paste a shorter README.' : null)} />
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => closeIntake(sessionId)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending} disabled={text.trim() === '' || pasteTooLarge}>
                  Add README
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
          <TabsContent value="upload" className="pt-4">
            <form onSubmit={submitUpload} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.file} className="text-small font-medium text-text">
                  File
                </label>
                <Input
                  id={ids.file}
                  type="file"
                  accept={ACCEPT}
                  onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                  disabled={pending}
                  aria-invalid={fileError ? true : undefined}
                  className="h-auto py-2"
                />
                <p className="text-small text-muted">.txt, .md or .pdf. A scanned PDF has no text to read; paste the text instead.</p>
              </div>
              <FieldError message={fileError ?? error} />
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => closeIntake(sessionId)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending} disabled={!file}>
                  Upload README
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
