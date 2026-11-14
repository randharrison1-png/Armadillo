'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { uploadWithRetry } from '@/lib/files/uploadClient';
import { ALLOWED_EXTENSIONS, validateUpload } from '@/server/files/limits';
import { getWorkspaceStore } from '@/features/workspace/store';
import { prepareReportUpload, recordUploadedLeadsReport } from './actions';
import { reportTab, useReportUi } from './reportUi';

const ACCEPT = ALLOWED_EXTENSIONS.report.join(',');

/**
 * Upload control for LEADS output: pick a file, it is uploaded privately, parsed on the server and
 * recorded for the session's current cycle; then its report tab opens. The output is untrusted
 * data and is only ever shown as text.
 */
export function UploadReport({ sessionId, variant = 'primary' }: { sessionId: string; variant?: 'primary' | 'secondary' }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | null) => {
    if (!file || pending) return;
    setError(null);
    try {
      validateUpload(file.name, file.size, 'report');
    } catch (e) {
      return setError(e instanceof Error ? e.message : 'That file cannot be used.');
    }
    setPending(true);
    try {
      const prepared = await prepareReportUpload(sessionId, file.name, file.size);
      if (!prepared.ok) throw new Error(prepared.error);
      const { storagePath } = await uploadWithRetry(file, prepared.target, { fields: { kind: 'report', sessionId } });
      const res = await recordUploadedLeadsReport({ sessionId, storagePath });
      if (!res.ok) throw new Error(res.error);
      useReportUi.getState().bumpVersion(sessionId);
      getWorkspaceStore(sessionId).getState().openTab(reportTab(res.reportId, res.filename));
      toast.success(res.findings > 0 ? `Report added: ${res.findings} findings parsed` : 'Report added. No findings could be parsed; the raw text is available.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed. Try again.');
    } finally {
      setPending(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        aria-label="LEADS report file"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
      />
      <Button variant={variant} loading={pending} onClick={() => input.current?.click()} aria-describedby={error ? errorId : undefined}>
        <Upload aria-hidden className="size-4" />
        Upload LEADS report
      </Button>
      <p className="text-small text-muted">.txt, .log, .csv, .json, .html, .md or .pdf, up to 25 MB.</p>
      {error ? (
        <p id={errorId} role="alert" className="flex items-center gap-2 text-small text-danger">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
