'use client';

import { useId, useRef, useState } from 'react';
import { AlertTriangle, Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { uploadWithRetry } from '@/lib/files/uploadClient';
import { ALLOWED_EXTENSIONS, validateUpload } from '@/server/files/limits';
import { cn } from '@/lib/utils';
import type { StepKey } from '@/lib/types';
import type { FlowEvidence, FlowScriptVersion } from '@/features/flowchart/types';
import { NOTE_MAX } from '@/features/flowchart/types';
import { prepareEvidenceUpload, recordEvidenceAction } from './completeActions';
import { defaultEvidenceKind, EVIDENCE_KIND_LABEL, EVIDENCE_KINDS, EXECUTION_STEPS, reportedMessage, type EvidenceKind } from './completeRules';

const ACCEPT = ALLOWED_EXTENSIONS.evidence.join(',');

const stamp = (iso: string) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;

type Props = {
  sessionId: string;
  step: StepKey;
  /** This step's evidence, newest first. */
  evidence: FlowEvidence[];
  currentCycle: number;
  scriptVersions: FlowScriptVersion[];
  readOnly: boolean;
  /** Called after evidence was saved so the tab reloads its data. */
  onChanged: () => void;
};

/**
 * Evidence of one flowchart step (spec 8.1 steps 3, 7, 8): execution output, screenshots, verification
 * notes. Files are uploaded privately and downloaded through a guarded route (never rendered inline:
 * they are untrusted). Evidence counts toward "Complete and Verified" for the CURRENT cycle only.
 * Execution output of a script version on a run step also marks that version's covered requirements
 * Reported (never Verified).
 */
export function EvidencePanel({ sessionId, step, evidence, currentCycle, scriptVersions, readOnly, onChanged }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<EvidenceKind>(defaultEvidenceKind(step));
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [version, setVersion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runStep = EXECUTION_STEPS.includes(step);

  const pick = (f: File | null) => {
    setError(null);
    if (!f) return setFile(null);
    try {
      validateUpload(f.name, f.size, 'evidence');
      setFile(f);
    } catch (e) {
      setFile(null);
      setError(e instanceof Error ? e.message : 'That file cannot be used.');
      if (input.current) input.current.value = '';
    }
  };

  const add = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      let storagePath: string | null = null;
      if (file) {
        const prepared = await prepareEvidenceUpload(sessionId, file.name, file.size);
        if (!prepared.ok) throw new Error(prepared.error);
        ({ storagePath } = await uploadWithRetry(file, prepared.target, { fields: { kind: 'evidence', sessionId } }));
      }
      const r = await recordEvidenceAction({
        sessionId,
        step,
        kind,
        storagePath,
        note,
        scriptVersionId: runStep && version ? version : null,
      });
      if (!r.ok) throw new Error(r.error);
      setFile(null);
      setNote('');
      if (input.current) input.current.value = '';
      if (r.reported > 0 || r.skipped > 0) toast.success(reportedMessage(r.reported, r.skipped));
      else toast.success('Evidence added');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the evidence. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Evidence" className="flex flex-col gap-2">
      <h4 className="font-medium text-text">Evidence</h4>
      {evidence.length === 0 ? (
        <p>No evidence yet</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {evidence.map((e) => (
            <li key={e.id} className="border-b border-border pb-2" data-testid="evidence-item">
              <span className="text-text">{EVIDENCE_KIND_LABEL[e.kind as EvidenceKind] ?? e.kind}</span> · Cycle {e.cycleNo}
              {e.cycleNo !== currentCycle ? ' (earlier cycle)' : ''} · {stamp(e.createdAt)}
              {e.scriptLabel ? <p className="break-words">Output of {e.scriptLabel}</p> : null}
              {e.note ? <p className="whitespace-pre-wrap break-words">{e.note}</p> : null}
              {e.filename ? (
                <p>
                  <a
                    href={`/api/files/evidence/${e.id}`}
                    download
                    className="inline-flex items-center gap-2 text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Download aria-hidden className="size-4 shrink-0" />
                    <span className="break-all">Download {e.filename}</span>
                  </a>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {readOnly ? null : (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-kind`} className="font-medium text-text">
            Evidence type
          </label>
          <select id={`${id}-kind`} className={cn(fieldClass, 'h-control')} value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)}>
            {EVIDENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {EVIDENCE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {runStep ? (
            <>
              <label htmlFor={`${id}-version`} className="font-medium text-text">
                Script version you ran
              </label>
              <select id={`${id}-version`} className={cn(fieldClass, 'h-control')} value={version} onChange={(e) => setVersion(e.target.value)}>
                <option value="">None</option>
                {scriptVersions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <p>Execution output of a script version marks the requirements it covers Reported. Only a LEADS report verifies them.</p>
            </>
          ) : null}
          <label htmlFor={`${id}-note`} className="font-medium text-text">
            Evidence note
          </label>
          <Textarea id={`${id}-note`} rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          <input ref={input} type="file" accept={ACCEPT} aria-label="Evidence file" className="sr-only" tabIndex={-1} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => input.current?.click()} disabled={pending}>
              <Upload aria-hidden className="size-4" />
              {file ? 'Change file' : 'Choose file'}
            </Button>
            {file ? <span className="min-w-0 break-all text-text">{file.name}</span> : null}
          </div>
          <p>.txt, .log, .csv, .json, .html, .md, .pdf, .png, .jpg or .jpeg, up to 25 MB.</p>
          <div>
            <Button onClick={() => void add()} loading={pending} disabled={!file && note.trim() === ''}>
              Add evidence
            </Button>
          </div>
          {error ? (
            <p role="alert" className="flex items-center gap-2 text-danger">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
