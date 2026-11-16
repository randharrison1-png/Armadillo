'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fieldClass, Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { clientSecretsFingerprint, scanSecrets, type SecretFinding } from '@/lib/secrets';
import type { ScriptLanguage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { publishPasteAction, type PasteFieldErrors } from './actions';
import { retryMessage } from './format';
import { EXPIRES_IN, LANGUAGE_LABEL, PASTE_LANGUAGES, type ExpiresIn, type PasteVisibility } from './schema';
import { SecretsWarning } from './SecretsWarning';

/** A private library script version the content was copied from; only used to word the confirmation. */
export type PublishSource = { name: string; versionNo: number };

export type PublishInitial = {
  title?: string;
  content?: string;
  language?: ScriptLanguage;
  /** Set when the content comes from the private library: the user must confirm before it is published. */
  source?: PublishSource;
};

type Phase = 'form' | 'confirm' | 'secrets' | 'pending' | 'done';
const EXPIRY_LABEL: Record<ExpiresIn, string> = { '1h': 'Expires in 1 hour', '1d': 'Expires in 1 day', '7d': 'Expires in 7 days', '30d': 'Expires in 30 days' };
const label = 'text-small font-medium text-text';

function ErrorLine({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-center gap-2 text-small text-danger">
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      {message}
    </p>
  );
}

/**
 * The only way to publish a paste. Publishing is always an explicit action: nothing is sent until
 * the user presses Publish, and from the private library also confirms the copy; if secrets are
 * detected they must also tick "Publish anyway". The server enforces all of it again.
 *
 * Flow: form -> (secrets warning, "Publish anyway") -> (private-source confirmation) -> pending -> done.
 * The warning comes from the same scanner the server runs; if the server finds something else
 * (different fingerprint) it sends back fresh findings and the warning is shown again.
 */
export function PublishDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: PublishInitial;
}) {
  // The dialog content unmounts when closed, so every open starts from a clean form.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-auto">
        <PublishBody initial={initial} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PublishBody({ initial, onClose }: { initial?: PublishInitial; onClose: () => void }) {
  const source = initial?.source;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [language, setLanguage] = useState<ScriptLanguage>(initial?.language ?? 'text');
  const [visibility, setVisibility] = useState<PasteVisibility>('public');
  const [expiresIn, setExpiresIn] = useState<ExpiresIn | 'never'>('never');
  const [phase, setPhase] = useState<Phase>('form');
  const [errors, setErrors] = useState<PasteFieldErrors>({});
  const [secrets, setSecrets] = useState<{ findings: SecretFinding[]; fingerprint: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const ids = useId();

  async function publish(opts: { ack?: { fingerprint: string } }) {
    const from: Phase = opts.ack ? 'secrets' : 'form';
    setPhase('pending');
    setErrors({});
    try {
      const r = await publishPasteAction({
        title,
        content,
        language,
        visibility,
        expiresIn: expiresIn === 'never' ? null : expiresIn,
        fromPrivate: Boolean(source),
        confirmPrivateSource: Boolean(source),
        acknowledgeSecrets: Boolean(opts.ack),
        secretsFingerprint: opts.ack?.fingerprint,
      });
      if (r.ok) {
        setSlug(r.slug);
        setPhase('done');
      } else if ('refusal' in r) {
        const f = r.refusal;
        if (f.code === 'secrets') {
          setSecrets({ findings: f.findings, fingerprint: f.fingerprint });
          setAcknowledged(false);
          setConfirmed(false);
          setPhase('secrets');
        } else if (f.code === 'rate_limited') {
          setErrors({ form: `You have published a lot recently. ${retryMessage(f.retryAfter)}` });
          setPhase(from === 'secrets' ? 'secrets' : 'form');
        } else {
          setPhase('confirm');
        }
      } else {
        setErrors(r.errors);
        setPhase('form');
      }
    } catch {
      setErrors({ form: 'Could not publish the paste. Check your connection and try again.' });
      setPhase(from);
    }
  }

  /** After the secrets step (if any): the private-source confirmation, then publish. */
  function proceed(ack?: { fingerprint: string }) {
    if (source && !confirmed) setPhase('confirm');
    else void publish({ ack });
  }

  async function submitForm() {
    const local: PasteFieldErrors = {};
    if (!title.trim()) local.title = 'Enter a title.';
    if (!content.trim()) local.content = 'Content cannot be empty.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setConfirmed(false);
    setAcknowledged(false);
    const findings = scanSecrets(content);
    if (findings.length > 0) {
      const fingerprint = await clientSecretsFingerprint(findings);
      if (fingerprint) {
        setSecrets({ findings, fingerprint });
        return setPhase('secrets');
      }
    }
    setSecrets(null);
    proceed();
  }

  async function copyLink() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/p/${slug}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  if (phase === 'done' && slug) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Paste published</DialogTitle>
          <DialogDescription>
            {visibility === 'public' ? 'It is public and searchable.' : 'It is unlisted: only people with the link can open it.'}
          </DialogDescription>
        </DialogHeader>
        <p role="status" className="flex items-center gap-2 text-small text-text">
          <Check aria-hidden className="size-4 shrink-0 text-accent" />
          <Link href={`/p/${slug}`} className="font-mono text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            /p/{slug}
          </Link>
        </p>
        {copyError ? <ErrorLine message="Could not copy the link. Select it and copy it manually." /> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => void copyLink()}>
            {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
            {copied ? 'Link copied' : 'Copy link'}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  if (phase === 'pending') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Publishing</DialogTitle>
          <DialogDescription>Checking the paste and publishing it.</DialogDescription>
        </DialogHeader>
        <p role="status" className="flex items-center gap-2 text-small text-muted">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Publishing…
        </p>
      </>
    );
  }

  if (phase === 'confirm' && source) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Publish a copy from your private library?</DialogTitle>
          <DialogDescription>
            Publishing a copy of {source.name} v{source.versionNo} from your private library
          </DialogDescription>
        </DialogHeader>
        <p className="text-small text-muted">
          The pastebin is public. Only the text below is copied; the script and its history stay private and are not linked to the paste. Later changes to the script do not change the paste.
        </p>
        <ErrorLine message={errors.form} />
        <DialogFooter>
          <Button variant="secondary" onClick={() => setPhase(secrets && acknowledged ? 'secrets' : 'form')}>
            Back
          </Button>
          <Button
            onClick={() => {
              setConfirmed(true);
              void publish({ ack: secrets && acknowledged ? { fingerprint: secrets.fingerprint } : undefined });
            }}
          >
            Publish copy
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (phase === 'secrets' && secrets) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Check before publishing</DialogTitle>
          <DialogDescription>Nothing has been published yet.</DialogDescription>
        </DialogHeader>
        <SecretsWarning findings={secrets.findings} acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} />
        <ErrorLine message={errors.form} />
        <DialogFooter>
          <Button variant="secondary" onClick={() => setPhase('form')}>
            Back to edit
          </Button>
          <Button disabled={!acknowledged} onClick={() => proceed({ fingerprint: secrets.fingerprint })}>
            Publish
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Publish to pastebin</DialogTitle>
        <DialogDescription>
          {source ? `A copy of ${source.name} v${source.versionNo} will be published. ` : ''}Public pastes are searchable; unlisted pastes are reachable only by their link.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submitForm();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-title`} className={label}>
            Title
          </label>
          <Input id={`${ids}-title`} value={title} maxLength={200} aria-invalid={Boolean(errors.title)} onChange={(e) => setTitle(e.target.value)} />
          <ErrorLine message={errors.title} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-language`} className={label}>
              Language
            </label>
            <select id={`${ids}-language`} value={language} onChange={(e) => setLanguage(e.target.value as ScriptLanguage)} className={cn(fieldClass, 'h-control')}>
              {PASTE_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABEL[l]}
                </option>
              ))}
            </select>
            <ErrorLine message={errors.language} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-visibility`} className={label}>
              Visibility
            </label>
            <select id={`${ids}-visibility`} value={visibility} onChange={(e) => setVisibility(e.target.value as PasteVisibility)} className={cn(fieldClass, 'h-control')}>
              <option value="public">Public (searchable)</option>
              <option value="unlisted">Unlisted (link only)</option>
            </select>
            <ErrorLine message={errors.visibility} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-expiry`} className={label}>
              Expiry
            </label>
            <select id={`${ids}-expiry`} value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as ExpiresIn | 'never')} className={cn(fieldClass, 'h-control')}>
              <option value="never">Never expires</option>
              {EXPIRES_IN.map((x) => (
                <option key={x} value={x}>
                  {EXPIRY_LABEL[x]}
                </option>
              ))}
            </select>
            <ErrorLine message={errors.expiresIn} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-content`} className={label}>
            Content
          </label>
          <Textarea
            id={`${ids}-content`}
            value={content}
            rows={12}
            spellCheck={false}
            aria-invalid={Boolean(errors.content)}
            onChange={(e) => setContent(e.target.value)}
            className="font-mono"
          />
          <ErrorLine message={errors.content} />
        </div>
        <ErrorLine message={errors.form} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Publish</Button>
        </DialogFooter>
      </form>
    </>
  );
}
