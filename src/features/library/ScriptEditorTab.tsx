'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Download, FileDiff, FileQuestion, GitBranch, GitCompare, Info, Save } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Script, ScriptVersion, TabDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';
import { draftKey, isDirty, useDrafts } from '@/features/workspace/drafts';
import { getWorkspaceStore } from '@/features/workspace/store';
import { loadAdaptationOptions } from '@/features/proposals/actions';
import type { AdaptationOptions } from '@/features/proposals/types';
import { useProposeAdaptation } from '@/features/proposals/useProposeAdaptation';
import { useReadmeUi } from '@/features/readme/readmeUi';
import { OS_LABEL } from '@/features/sessions/schema';
import { useScriptEditorExtras } from './editorContext';
import { CATEGORY_LABEL } from './filters';
import { ScriptDetailsDialog } from './ScriptDetailsDialog';
import { firstNonCp1252 } from '@/lib/cp1252';
import { defaultFormat, ENCODING_LABEL, formatLabel } from './scriptMeta';
import { diffTab, downloadHref, isUuid, parseScriptResourceId, scriptTab, versionViewTab } from './scriptTabs';
import { forkToSessionAction, loadScriptEditor, loadVersion, restoreVersionAction, saveScriptVersionAction } from './versionActions';
import type { ScriptEditorData, VersionSummary } from './versionTypes';
import { VersionHistory } from './VersionHistory';

const CodeEditor = dynamic(() => import('./monaco/CodeEditor').then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <LoadingState label="Loading editor" />,
});

/** Body of a 'script' workspace tab: the editor (resourceId `<scriptId>`) or a read-only version (`<scriptId>@<versionId>`). */
export function ScriptEditorTab({ namespace, tab }: { namespace: string; tab: TabDescriptor }) {
  const parsed = tab.resourceId ? parseScriptResourceId(tab.resourceId) : null;
  if (!parsed) return <EmptyState icon={FileQuestion} title="Nothing to show" description="This tab does not point at a script." />;
  if (parsed.versionId) return <VersionViewer key={tab.key} versionId={parsed.versionId} />;
  return <ScriptEditor key={tab.key} namespace={namespace} tabKey={tab.key} scriptId={parsed.scriptId} />;
}

function Meta({ script, version }: { script: Script; version: Pick<ScriptVersion, 'version_no' | 'encoding' | 'line_ending'> }) {
  return (
    <p className="flex flex-wrap gap-x-2 text-small text-muted">
      <span className="font-mono text-text">{script.filename}</span>
      <span aria-hidden>·</span>
      <span>{CATEGORY_LABEL[script.category]}</span>
      <span aria-hidden>·</span>
      <span>{script.os_compat.map((o) => OS_LABEL[o]).join(', ')}</span>
      <span aria-hidden>·</span>
      <span className="font-mono">v{version.version_no}</span>
      <span aria-hidden>·</span>
      <span>{formatLabel(version)}</span>
    </p>
  );
}

type Confirm =
  | { kind: 'saveOnLatest'; latest: ScriptVersion }
  | { kind: 'openLatest'; latest: ScriptVersion }
  | { kind: 'restore'; version: VersionSummary };

function ScriptEditor({ namespace, tabKey, scriptId }: { namespace: string; tabKey: string; scriptId: string }) {
  const extras = useScriptEditorExtras();
  const [data, setData] = useState<ScriptEditorData | null>(extras.initial?.script.id === scriptId ? extras.initial : null);
  const [loadError, setLoadError] = useState<'missing' | 'failed' | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [conflict, setConflict] = useState<ScriptVersion | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const noteId = useId();

  const key = draftKey(namespace, tabKey);
  const storedDraft = useDrafts((s) => s.drafts[key]);
  const putDraft = useDrafts((s) => s.put);
  const clearDraft = useDrafts((s) => s.clear);
  /*
   * Drafts outlive this component (tab switches, in-app navigation), so one can be based on an
   * older version than the one just loaded. A CLEAN stale draft is ignored (and replaced once the
   * editor mounts), so the editor always shows the current version. A DIRTY stale draft keeps the
   * user's text and raises the conflict banner straight away. Not while a save is in flight: the
   * draft and the reloaded data are updated one after the other then.
   */
  const stale = !!storedDraft && !!data && storedDraft.baseVersionId !== data.current.id && !saving;
  const draft = stale && !isDirty(storedDraft) ? undefined : storedDraft;
  const dirty = isDirty(draft);
  const currentEncoding = data?.current.encoding;
  const draftText = draft?.content;
  const unencodable = useMemo(
    () => (currentEncoding === 'windows-1252' && draftText !== undefined ? firstNonCp1252(draftText) : null),
    [currentEncoding, draftText],
  );

  // In a session workspace (namespace = session id) with a README, Claude can propose an adaptation.
  const sessionId = isUuid(namespace) ? namespace : null;
  const readmeVersion = useReadmeUi((s) => (sessionId ? (s.version[sessionId] ?? 0) : 0));
  const [adaptation, setAdaptation] = useState<AdaptationOptions | null>(null);
  const proposer = useProposeAdaptation(sessionId ?? '');
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    loadAdaptationOptions(sessionId).then(
      (o) => live && setAdaptation(o),
      () => live && setAdaptation(null),
    );
    return () => {
      live = false;
    };
  }, [sessionId, readmeVersion]);

  const reload = useCallback(async () => {
    try {
      const d = await loadScriptEditor(scriptId);
      if (!d) setLoadError('missing');
      else {
        setData(d);
        setLoadError(null);
      }
      return d;
    } catch {
      setLoadError('failed');
      return null;
    }
  }, [scriptId]);

  useEffect(() => {
    if (data || loadError) return;
    let live = true;
    loadScriptEditor(scriptId)
      .then((d) => {
        if (!live) return;
        if (d) setData(d);
        else setLoadError('missing');
      })
      .catch(() => live && setLoadError('failed'));
    return () => {
      live = false;
    };
  }, [data, loadError, scriptId]);

  /** Drop local edits and re-create the editor from the current version. */
  const resetEditor = () => {
    clearDraft(key);
    setEpoch((e) => e + 1);
  };

  if (loadError === 'missing') {
    return <EmptyState icon={FileQuestion} title="Script not found" description="It may have been archived, or it belongs to another account." />;
  }
  if (loadError === 'failed') return <ErrorState title="Could not load the script" onRetry={() => setLoadError(null)} />;
  if (!data) return <LoadingState label="Loading script" />;

  const { script, current, versions, readOnly } = data;
  const shownConflict = conflict ?? (stale && dirty ? current : null);
  const latestNo = versions[0]?.version_no ?? current.version_no;
  const baseNo = versions.find((v) => v.id === (draft?.baseVersionId ?? current.id))?.version_no;
  const openTab = (t: TabDescriptor) => getWorkspaceStore(namespace).getState().openTab(t);
  const compare = (from: { id: string; version_no: number }, to: { id: string; version_no: number }) =>
    openTab(diffTab(script.id, { id: from.id, no: from.version_no }, { id: to.id, no: to.version_no }, script.filename));

  const save = async (baseVersionId: string | null = draft?.baseVersionId ?? current.id) => {
    if (saving || readOnly) return;
    const content = draft?.content ?? current.content;
    setSaving(true);
    try {
      const r = await saveScriptVersionAction({ scriptId: script.id, baseVersionId, content, changeNote: note });
      if (!r.ok) return void toast.error(r.error);
      const res = r.result;
      if (res.status === 'conflict') return void setConflict(res.latest);
      setConflict(null);
      // Keep anything typed while the save was in flight.
      const typed = useDrafts.getState().drafts[key]?.content ?? content;
      if (res.status === 'unchanged') {
        putDraft(key, { baseVersionId: res.version.id, pristine: content, content: typed });
        return void toast.info(`No changes to save: the text matches v${res.version.version_no}.`);
      }
      const v = res.version;
      setNote('');
      const fresh = await loadScriptEditor(script.id).catch(() => null);
      // Update draft and data in one synchronous step so they never disagree about the base version.
      const keepsText = v.content === content && v.line_ending === current.line_ending;
      if (keepsText) putDraft(key, { baseVersionId: v.id, pristine: content, content: useDrafts.getState().drafts[key]?.content ?? typed });
      if (fresh) setData(fresh);
      // The server normalized the text (or a mixed file got one line ending): show what was stored.
      if (!keepsText && fresh) resetEditor();
      if (v.encoding !== current.encoding) {
        toast.success(`Saved v${v.version_no} as ${ENCODING_LABEL[v.encoding]}: the text no longer fits ${ENCODING_LABEL[current.encoding]}.`);
      } else toast.success(`Saved v${v.version_no}`);
    } catch {
      toast.error('Could not save the version. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const openLatest = async () => {
    setConflict(null);
    if (await reload()) resetEditor();
  };

  const restore = async (v: VersionSummary) => {
    setRestoringId(v.id);
    try {
      const r = await restoreVersionAction({ scriptId: script.id, versionId: v.id, baseVersionId: current.id });
      if (!r.ok) return void toast.error(r.error);
      const res = r.result;
      if (res.status === 'conflict') {
        await reload();
        return void toast.error(`v${res.latest.version_no} was saved in the meantime. Review it, then restore again.`);
      }
      if (res.status === 'unchanged') return void toast.info(`v${v.version_no} is identical to the current version.`);
      if (await reload()) resetEditor();
      toast.success(`Restored v${v.version_no} as v${res.version.version_no}`);
    } catch {
      toast.error('Could not restore the version. Try again.');
    } finally {
      setRestoringId(null);
    }
  };

  const mixedAs = draft?.pristine.includes('\r\n') ? 'CRLF' : 'LF';
  const adaptReadme = adaptation?.active ? adaptation.readmes.find((r) => r.hasText) : undefined;
  const propose = async () => {
    if (!adaptReadme) return;
    const error = await proposer.run({ scriptVersionId: current.id, readmeId: adaptReadme.id });
    if (error) toast.error(error);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="truncate text-body font-semibold text-text">{script.name}</h2>
              <Meta script={script} version={current} />
              <p className="text-small text-muted">
                {readOnly
                  ? 'This session is completed, so its scripts are read-only.'
                  : script.session_id
                    ? 'Session script. Saving adds a version; earlier versions stay in the history.'
                    : 'Universal script. Saving adds a version; earlier versions stay in the history and can be restored.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ScriptDetailsDialog script={script} disabled={readOnly} onSaved={(s) => setData((d) => (d ? { ...d, script: s } : d))} />
              <a href={downloadHref(current.id)} download className={buttonVariants({ variant: 'secondary' })} title={`Download v${current.version_no} as ${formatLabel(current)}`}>
                <Download aria-hidden className="size-4" />
                Download
              </a>
              {adaptReadme && !readOnly ? (
                <Button
                  variant="secondary"
                  onClick={() => void propose()}
                  loading={proposer.running}
                  disabled={dirty || proposer.running}
                  title={dirty ? 'Save or discard your edits first: Claude adapts the saved version.' : `Claude adapts saved v${current.version_no} to the latest README`}
                >
                  <FileDiff aria-hidden className="size-4" />
                  Propose adaptation
                </Button>
              ) : null}
              {extras.forkTargets && script.session_id === null ? (
                <ForkMenu version={current} script={script} sessions={extras.forkTargets} />
              ) : null}
            </div>
          </div>

          {shownConflict ? (
            <div role="alert" className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-2">
              <p className="flex items-center gap-2 text-small text-text">
                <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
                v{shownConflict.version_no} was saved after you opened this{baseNo ? ` (you started from v${baseNo})` : ''}. Nothing was overwritten
                and your edits are still here.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setConfirm({ kind: 'saveOnLatest', latest: shownConflict })}>
                  Save as new version based on v{shownConflict.version_no}
                </Button>
                <Button variant="secondary" onClick={() => setConfirm({ kind: 'openLatest', latest: shownConflict })}>
                  Open latest
                </Button>
                {baseNo && draft?.baseVersionId ? (
                  <Button variant="ghost" onClick={() => compare({ id: draft.baseVersionId!, version_no: baseNo }, shownConflict)}>
                    <GitCompare aria-hidden className="size-4" />
                    Compare v{baseNo} and v{shownConflict.version_no}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {unencodable && !readOnly ? (
            <p role="note" className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-small text-text">
              <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
              {ENCODING_LABEL['windows-1252']} cannot store “{unencodable}”, so saving writes the new version as{' '}
              {ENCODING_LABEL[defaultFormat(script.filename).encoding]}. Earlier versions keep their encoding.
            </p>
          ) : null}

          {current.line_ending === 'mixed' ? (
            <p role="note" className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-small text-muted">
              <Info aria-hidden className="size-4 shrink-0" />
              v{current.version_no} mixes CRLF and LF line endings. The editor shows them all as {mixedAs}; saving an edit stores {mixedAs} throughout.
              Downloading v{current.version_no} still gives the original bytes.
            </p>
          ) : null}

          <section aria-label="Script content" className="min-h-0 flex-1">
            <CodeEditor
              key={epoch}
              value={draft?.content ?? current.content}
              language={current.language}
              lineEnding={current.line_ending}
              readOnly={readOnly}
              ariaLabel={`${script.filename} editor`}
              onReady={(value) => {
                const d = useDrafts.getState().drafts[key];
                // No draft yet, or a clean one left over from an older version: start from what the editor shows.
                if (!d || (d.baseVersionId !== current.id && !isDirty(d))) putDraft(key, { baseVersionId: current.id, pristine: value, content: value });
              }}
              onChange={(value) => {
                const d = useDrafts.getState().drafts[key];
                putDraft(key, { baseVersionId: d?.baseVersionId ?? current.id, pristine: d?.pristine ?? current.content, content: value });
              }}
              onSave={() => void save()}
            />
          </section>

          {readOnly ? null : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2"
            >
              <label htmlFor={noteId} className="sr-only">
                Change note
              </label>
              <Input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Change note (optional)" className="max-w-md" />
              <span role="status" className={cn('text-small', dirty ? 'text-warning' : 'text-muted')}>
                {dirty ? 'Unsaved changes' : `Saved as v${current.version_no}`}
              </span>
              <Button type="submit" loading={saving} className="ml-auto" title="Save version (Ctrl+S)">
                <Save aria-hidden className="size-4" />
                Save version
              </Button>
            </form>
          )}
        </div>

        <VersionHistory
          versions={versions}
          currentId={current.id}
          readOnly={readOnly}
          restoringId={restoringId}
          onView={(v) => openTab(versionViewTab(script.id, v.id, script.filename, v.version_no))}
          onCompare={compare}
          onRestore={(v) => setConfirm({ kind: 'restore', version: v })}
        />
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          {confirm?.kind === 'saveOnLatest' ? (
            <>
              <DialogHeader>
                <DialogTitle>Save your edits as v{confirm.latest.version_no + 1}?</DialogTitle>
                <DialogDescription>
                  v{confirm.latest.version_no} stays in the history, and your edited text becomes the current version. Changes made in v
                  {confirm.latest.version_no} are not merged into your text, so compare first if you are unsure.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setConfirm(null);
                    void save(confirm.latest.id);
                  }}
                >
                  Save as v{confirm.latest.version_no + 1}
                </Button>
              </DialogFooter>
            </>
          ) : confirm?.kind === 'openLatest' ? (
            <>
              <DialogHeader>
                <DialogTitle>Discard your edits and open v{confirm.latest.version_no}?</DialogTitle>
                <DialogDescription>Your unsaved changes are lost. Saved versions are not affected.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setConfirm(null);
                    void openLatest();
                  }}
                >
                  Discard my changes
                </Button>
              </DialogFooter>
            </>
          ) : confirm?.kind === 'restore' ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Restore v{confirm.version.version_no} as v{latestNo + 1}?
                </DialogTitle>
                <DialogDescription>
                  This adds a new version with the text of v{confirm.version.version_no}. Every existing version stays in the history.
                  {dirty ? ' Your unsaved edits will be discarded.' : ''}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    const v = confirm.version;
                    setConfirm(null);
                    void restore(v);
                  }}
                >
                  Restore as v{latestNo + 1}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

/** "Fork to session": copies the saved current version into an active session and opens it there. */
function ForkMenu({ script, version, sessions }: { script: Script; version: ScriptVersion; sessions: { id: string; title: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (sessions.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <Button variant="secondary" disabled tabIndex={-1}>
              <GitBranch aria-hidden className="size-4" />
              Fork to session
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Create a session first</TooltipContent>
      </Tooltip>
    );
  }
  const fork = async (sessionId: string) => {
    setBusy(true);
    try {
      const r = await forkToSessionAction({ versionId: version.id, sessionId });
      if (!r.ok) return void toast.error(r.error);
      getWorkspaceStore(r.sessionId).getState().openTab(scriptTab(r.scriptId, r.filename));
      toast.success(`Copied ${script.name} v${version.version_no} into the session`);
      router.push(`/app/sessions/${r.sessionId}`);
    } catch {
      toast.error('Could not copy the script into the session. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" loading={busy}>
          <GitBranch aria-hidden className="size-4" />
          Fork to session
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Copy saved v{version.version_no} into a session</DropdownMenuLabel>
        {sessions.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => void fork(s.id)}>
            <span className="truncate">{s.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Read-only view of one version. */
function VersionViewer({ versionId }: { versionId: string }) {
  const [state, setState] = useState<{ script: Script; version: ScriptVersion } | 'missing' | 'failed' | null>(null);
  useEffect(() => {
    if (state !== null) return;
    let live = true;
    loadVersion(versionId)
      .then((r) => live && setState(r ?? 'missing'))
      .catch(() => live && setState('failed'));
    return () => {
      live = false;
    };
  }, [versionId, state]);

  if (state === 'missing') return <EmptyState icon={FileQuestion} title="Version not found" description="It belongs to a script you no longer have." />;
  if (state === 'failed') return <ErrorState title="Could not load the version" onRetry={() => setState(null)} />;
  if (!state) return <LoadingState label="Loading version" />;
  const { script, version } = state;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="truncate text-body font-semibold text-text">
            {script.name} v{version.version_no} <span className="text-small font-normal text-muted">(read-only)</span>
          </h2>
          <Meta script={script} version={version} />
          {version.change_note ? <p className="text-small text-text">{version.change_note}</p> : null}
        </div>
        <a href={downloadHref(version.id)} download className={buttonVariants({ variant: 'secondary' })}>
          <Download aria-hidden className="size-4" />
          Download v{version.version_no}
        </a>
      </div>
      <section aria-label="Script content" className="min-h-0 flex-1">
        <CodeEditor value={version.content} language={version.language} lineEnding={version.line_ending} readOnly ariaLabel={`${script.filename} v${version.version_no}`} />
      </section>
    </div>
  );
}
