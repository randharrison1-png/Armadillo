'use client';

import { useEffect, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fieldClass, Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ScriptLanguage } from '@/lib/types';
import type { SecretFinding } from '@/lib/secrets';
import { deletePaste, loadOwnPaste, updatePaste, type PasteFieldErrors } from './actions';
import { pasteDate, pasteDateTime, pasteTitle, retryMessage } from './format';
import { SecretsWarning } from './SecretsWarning';
import { LANGUAGE_LABEL, PASTE_LANGUAGES, type OwnPasteWithContent, type PasteVisibility } from './schema';

// Same editor as the script library (Monaco, local bundle), loaded only in the browser.
const CodeEditor = dynamic(() => import('@/features/library/monaco/CodeEditor').then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <LoadingState label="Loading editor" />,
});

export type MyPasteRow = {
  slug: string;
  title: string | null;
  language: ScriptLanguage;
  visibility: PasteVisibility;
  expiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

type Status = 'deleted' | 'expired' | 'live';
const statusOf = (p: MyPasteRow, now = Date.now()): Status => (p.deletedAt ? 'deleted' : p.expiresAt && Date.parse(p.expiresAt) <= now ? 'expired' : 'live');

const EXPIRY_PRESETS = [
  { value: 'keep', label: 'Keep current expiry' },
  { value: 'never', label: 'Never expires' },
  { value: '1h', label: 'Expires in 1 hour', ms: 3600_000 },
  { value: '1d', label: 'Expires in 1 day', ms: 86400_000 },
  { value: '7d', label: 'Expires in 7 days', ms: 7 * 86400_000 },
  { value: '30d', label: 'Expires in 30 days', ms: 30 * 86400_000 },
] as const;

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-2 text-small text-danger">
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      {message}
    </p>
  );
}

export function MyPastes({ pastes, initialEdit, initialDelete }: { pastes: MyPasteRow[]; initialEdit?: string; initialDelete?: string }) {
  // ?edit=<slug> / ?delete=<slug> (from the paste page) open the matching dialog on first render.
  const live = (slug?: string) => pastes.find((p) => p.slug === slug && !p.deletedAt);
  const [editSlug, setEditSlug] = useState<string | null>(() => (live(initialEdit) ? initialEdit! : null));
  const [deleteRow, setDeleteRow] = useState<MyPasteRow | null>(() => (live(initialEdit) ? null : (live(initialDelete) ?? null)));

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-h1 font-semibold text-text">My pastes</h1>
          <Link href="/p/new" className={buttonVariants({ variant: 'secondary' })}>
            <Plus aria-hidden className="size-4" />
            New paste
          </Link>
        </div>
        <p className="text-small text-muted">Pastes you published. Public pastes are searchable; unlisted pastes are reachable only by their link.</p>
      </div>

      {pastes.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="You have not published any pastes"
          description="Publishing is always an explicit action. Nothing from your private workspace is published automatically."
          actions={
            <Link href="/p" className="text-small text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              Browse the public pastebin
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-small">
            <thead className="border-b border-border text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Language</th>
                <th className="px-4 py-2 font-medium">Visibility</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pastes.map((p) => {
                const status = statusOf(p);
                return (
                  <tr key={p.slug} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2">
                      {status === 'live' ? (
                        <Link href={`/p/${p.slug}`} className="text-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                          {pasteTitle(p.title)}
                        </Link>
                      ) : (
                        <span className="text-muted">{pasteTitle(p.title)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted">{LANGUAGE_LABEL[p.language]}</td>
                    <td className="px-4 py-2 text-muted">{p.visibility === 'public' ? 'Public' : 'Unlisted'}</td>
                    <td className="px-4 py-2 text-muted">{pasteDate(p.createdAt)}</td>
                    <td className="px-4 py-2 text-muted">
                      {status === 'deleted' ? 'Deleted' : status === 'expired' ? `Expired ${pasteDate(p.expiresAt!)}` : p.expiresAt ? `Expires ${pasteDateTime(p.expiresAt)}` : 'Live'}
                    </td>
                    <td className="px-4 py-2">
                      {status === 'deleted' ? null : (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" aria-label={`Edit ${pasteTitle(p.title)}`} onClick={() => setEditSlug(p.slug)}>
                            <Pencil aria-hidden className="size-4" />
                            Edit
                          </Button>
                          <Button variant="secondary" aria-label={`Delete ${pasteTitle(p.title)}`} onClick={() => setDeleteRow(p)}>
                            <Trash2 aria-hidden className="size-4" />
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editSlug ? <EditDialog slug={editSlug} onClose={() => setEditSlug(null)} /> : null}
      {deleteRow ? <DeleteDialog row={deleteRow} onClose={() => setDeleteRow(null)} /> : null}
    </div>
  );
}

function DeleteDialog({ row, onClose }: { row: MyPasteRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => (!o && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete paste</DialogTitle>
          <DialogDescription>
            Delete “{pasteTitle(row.title)}”? Its link stops working immediately. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <FieldError message={error ?? undefined} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={() =>
              start(async () => {
                const r = await deletePaste(row.slug);
                if (r.ok) {
                  toast.success('Paste deleted');
                  onClose();
                  router.replace('/app/pastes');
                  router.refresh();
                } else setError(('errors' in r && r.errors.form) || 'Could not delete the paste.');
              })
            }
          >
            Delete paste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const detectEol = (s: string): 'crlf' | 'lf' | 'mixed' => (s.includes('\r\n') ? (/(^|[^\r])\n/.test(s) ? 'mixed' : 'crlf') : 'lf');

function EditDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<OwnPasteWithContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadOwnPaste(slug).then((r) => {
      if (cancelled) return;
      if (r.ok) setLoaded(r.paste);
      else setLoadError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-auto">
        <DialogHeader>
          <DialogTitle>Edit paste</DialogTitle>
          <DialogDescription>Changes are visible to anyone with the link as soon as you save.</DialogDescription>
        </DialogHeader>
        {loadError ? (
          <p role="alert" className="text-small text-danger">
            {loadError}
          </p>
        ) : loaded ? (
          <EditForm
            paste={loaded}
            onClose={onClose}
            onSaved={() => {
              toast.success('Paste saved');
              onClose();
              router.refresh();
            }}
          />
        ) : (
          <LoadingState label="Loading paste" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ paste, onClose, onSaved }: { paste: OwnPasteWithContent; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(paste.title ?? '');
  const [language, setLanguage] = useState<ScriptLanguage>(paste.language);
  const [visibility, setVisibility] = useState<PasteVisibility>(paste.visibility);
  const [expiry, setExpiry] = useState<string>('keep');
  const [content, setContent] = useState(paste.content);
  const [errors, setErrors] = useState<PasteFieldErrors>({});
  const [secrets, setSecrets] = useState<{ findings: SecretFinding[]; fingerprint: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, start] = useTransition();
  const [eol] = useState(() => detectEol(paste.content));
  const label = 'text-small font-medium text-text';

  function save() {
    const preset = EXPIRY_PRESETS.find((p) => p.value === expiry);
    start(async () => {
      const r = await updatePaste({
        slug: paste.slug,
        title,
        content,
        language,
        visibility,
        ...(secrets && acknowledged ? { acknowledgeSecrets: true, secretsFingerprint: secrets.fingerprint } : {}),
        ...(expiry === 'never' ? { expiresAt: null } : preset && 'ms' in preset ? { expiresAt: new Date(Date.now() + preset.ms).toISOString() } : {}),
      });
      if (r.ok) return onSaved();
      if ('refusal' in r) {
        const f = r.refusal;
        if (f.code === 'secrets') {
          // A new fingerprint means different findings: the earlier tick no longer applies.
          if (f.fingerprint !== secrets?.fingerprint) setAcknowledged(false);
          setSecrets({ findings: f.findings, fingerprint: f.fingerprint });
          setErrors({});
        } else {
          setErrors({ form: f.code === 'rate_limited' ? `You have made a lot of changes recently. ${retryMessage(f.retryAfter)}` : 'Could not save the paste.' });
        }
      } else setErrors(r.errors);
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="paste-title" className={label}>
          Title
        </label>
        <Input id="paste-title" value={title} maxLength={200} aria-invalid={Boolean(errors.title)} onChange={(e) => setTitle(e.target.value)} />
        <FieldError message={errors.title} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="paste-language-edit" className={label}>
            Language
          </label>
          <select id="paste-language-edit" value={language} onChange={(e) => setLanguage(e.target.value as ScriptLanguage)} className={cn(fieldClass, 'h-control')}>
            {PASTE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABEL[l]}
              </option>
            ))}
          </select>
          <FieldError message={errors.language} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="paste-visibility" className={label}>
            Visibility
          </label>
          <select id="paste-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as PasteVisibility)} className={cn(fieldClass, 'h-control')}>
            <option value="public">Public (searchable)</option>
            <option value="unlisted">Unlisted (link only)</option>
          </select>
          <FieldError message={errors.visibility} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="paste-expiry" className={label}>
            Expiry
          </label>
          <select id="paste-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={cn(fieldClass, 'h-control')}>
            {EXPIRY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <FieldError message={errors.expiresAt} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span id="paste-content-label" className={label}>
          Content
        </span>
        <div className="h-72 overflow-hidden rounded-sm border border-border-input">
          <CodeEditor value={paste.content} language={language} lineEnding={eol} ariaLabel="Paste content" onChange={setContent} onSave={save} />
        </div>
        <FieldError message={errors.content} />
      </div>
      {secrets ? <SecretsWarning findings={secrets.findings} acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} /> : null}
      <FieldError message={errors.form} />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending} disabled={Boolean(secrets) && !acknowledged}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}
