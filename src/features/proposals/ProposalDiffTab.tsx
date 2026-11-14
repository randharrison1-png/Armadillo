'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Check, Download, FileQuestion, FileText, PanelRight, PencilLine, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { SetTabInspector, useInspectorStore } from '@/components/shell/inspectorStore';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { TabDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';
import { draftKey, isDirty, useDrafts } from '@/features/workspace/drafts';
import { getWorkspaceStore } from '@/features/workspace/store';
import type { ModifiedEditor } from '@/features/library/monaco/CodeEditor';
import { downloadHref, scriptTab } from '@/features/library/scriptTabs';
import { acceptProposalAction, loadProposal, rejectProposalAction, reproposeAdaptationAction } from './actions';
import { FlagChecklist } from './FlagChecklist';
import { acceptLabel, parseProposalResourceId, proposalTab, reviewFlags } from './review';
import { jumpTo, registerJump, useProposalReview } from './reviewStore';
import type { ProposalView } from './types';

const ReviewDiff = dynamic(() => import('@/features/library/monaco/CodeEditor').then((m) => m.ReviewDiff), {
  ssr: false,
  loading: () => <LoadingState label="Loading comparison" />,
});

/** Re-scan the user's edits this long after the last keystroke. */
const SCAN_DELAY_MS = 300;

/**
 * Body of a proposal's 'diff' tab (resourceId `proposal:<id>`): the base version on the left, Claude's
 * proposed script on the right (editable while pending), the summary and the high-impact checklist
 * in the inspector, and Accept / Reject / Keep editing. Accept stays disabled until every flag — of
 * the proposal and of the user's edits — is ticked; the server checks the same rule again.
 */
export function ProposalDiffTab({ tab, namespace }: { tab: TabDescriptor; namespace: string }) {
  const proposalId = tab.resourceId ? parseProposalResourceId(tab.resourceId) : null;
  const [state, setState] = useState<ProposalView | 'missing' | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    if (!proposalId) return;
    let live = true;
    loadProposal(proposalId).then(
      (v) => live && setState(v ?? 'missing'),
      () => live && setState((s) => (s && typeof s === 'object' ? s : 'failed')),
    );
    return () => {
      live = false;
    };
  }, [proposalId, attempt]);

  if (!proposalId || state === 'missing') {
    return <EmptyState icon={FileQuestion} title="Proposal not found" description="It may belong to another account, or this tab points at something else." />;
  }
  if (state === 'failed') return <ErrorState title="Could not load the proposal" detail="Check your connection and try again." onRetry={() => (setState(null), reload())} />;
  if (!state) return <LoadingState label="Loading proposal" />;
  if (!state.base) return <EmptyState icon={FileQuestion} title="Nothing to compare" description="This proposal has no base script version." />;
  return <ProposalReview key={`${state.proposal.id}:${state.proposal.status}:${state.sessionStatus}`} view={state} namespace={namespace} tabKey={tab.key} reload={reload} />;
}

type Banner = { kind: 'error' | 'status'; text: string };

const STATUS_LABEL = { pending: 'Pending review', accepted: 'Accepted', rejected: 'Rejected' } as const;

function ProposalReview({ view, namespace, tabKey, reload }: { view: ProposalView; namespace: string; tabKey: string; reload: () => void }) {
  const { proposal, readOnly, result } = view;
  const { script, version } = view.base!;
  const editable = !readOnly;
  const universal = script.session_id === null;

  const key = draftKey(namespace, tabKey);
  const draft = useDrafts((s) => s.drafts[key]);
  const putDraft = useDrafts((s) => s.put);
  const clearDraft = useDrafts((s) => s.clear);
  const usable = editable && draft?.baseVersionId === proposal.base_version_id ? draft : undefined;
  const content = usable?.content ?? proposal.proposed_content;
  const dirty = isDirty(usable);
  // Right-hand side of a decided proposal: what was saved (it may include the user's edits).
  const shown = proposal.status === 'accepted' && result?.content !== undefined ? result.content : proposal.proposed_content;

  const [scanned, setScanned] = useState(content);
  useEffect(() => {
    if (scanned === content) return;
    const t = setTimeout(() => setScanned(content), SCAN_DELAY_MS);
    return () => clearTimeout(t);
  }, [content, scanned]);
  const scanning = scanned !== content;
  const flags = useMemo(
    () => reviewFlags(proposal.flags, readOnly ? shown : scanned, version.language),
    [proposal.flags, readOnly, shown, scanned, version.language],
  );

  const update = useProposalReview((s) => s.update);
  const acknowledged = useProposalReview((s) => s.entries[proposal.id]?.acknowledged) ?? [];
  useEffect(() => {
    update(proposal.id, {
      flags,
      readOnly,
      summary: proposal.summary,
      ...(proposal.status === 'accepted' ? { acknowledged: flags.map((f) => f.id) } : {}),
    });
  }, [update, proposal.id, proposal.summary, proposal.status, flags, readOnly]);
  const ack = new Set(acknowledged);
  const ackedCount = flags.filter((f) => ack.has(f.id)).length;

  const editorRef = useRef<ModifiedEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  useEffect(() => {
    registerJump(proposal.id, (line) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
      ed.focus();
    });
    return () => registerJump(proposal.id, null);
  }, [proposal.id]);

  // The checklist lives in the inspector: open it for a proposal that still needs acknowledgements.
  const needsChecklist = editable && proposal.flags.length > 0;
  useEffect(() => {
    if (needsChecklist) useInspectorStore.getState().setOpen(true);
  }, [needsChecklist]);
  const inspectorOpen = useInspectorStore((s) => s.open);

  const [busy, setBusy] = useState<'accept' | 'reject' | 'repropose' | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [conflict, setConflict] = useState<{ latestVersionId: string; latestVersionNo: number } | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);

  const openTab = (t: TabDescriptor) => getWorkspaceStore(namespace).getState().openTab(t);
  const latest = view.latestBaseVersion;
  const staleBase = editable && !universal && !!latest && latest.id !== version.id;
  const shownConflict = conflict ?? (staleBase && latest ? { latestVersionId: latest.id, latestVersionNo: latest.version_no } : null);
  const canAccept = editable && busy === null && !scanning && ackedCount === flags.length && !shownConflict;

  const accept = async () => {
    if (!canAccept) return;
    setBusy('accept');
    setBanner(null);
    try {
      const res = await acceptProposalAction({ proposalId: proposal.id, acknowledgedFlagIds: [...acknowledged], ...(dirty ? { editedContent: content } : {}) });
      if (res.ok) {
        clearDraft(key);
        toast.success(`Saved ${res.filename} v${res.versionNo}`, {
          action: { label: `Open v${res.versionNo}`, onClick: () => openTab(scriptTab(res.scriptId, res.filename)) },
        });
        reload();
        return;
      }
      if ('missingFlagIds' in res) {
        setScanned(content);
        useInspectorStore.getState().setOpen(true);
      }
      if ('conflict' in res) setConflict(res.conflict);
      setBanner({ kind: 'error', text: res.error });
    } catch {
      setBanner({ kind: 'error', text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setConfirmReject(false);
    setBusy('reject');
    setBanner(null);
    try {
      const res = await rejectProposalAction({ proposalId: proposal.id });
      if (!res.ok) return setBanner({ kind: 'error', text: res.error });
      clearDraft(key);
      toast.success('Proposal rejected. Nothing was saved.');
      reload();
    } catch {
      setBanner({ kind: 'error', text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const repropose = async () => {
    setBusy('repropose');
    setBanner(null);
    try {
      const res = await reproposeAdaptationAction({ proposalId: proposal.id });
      if (!res.ok) return setBanner({ kind: 'error', text: res.error });
      openTab(proposalTab(res.proposalId, res.filename));
      toast.success('Claude proposed a new adaptation against the latest version.');
    } catch {
      setBanner({ kind: 'error', text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const [headline, ...details] = proposal.summary.split(/\r?\n/).filter((l) => l.trim());
  const nextNo = (latest?.version_no ?? version.version_no) + 1;
  const explanation = readOnly
    ? null
    : universal
      ? `Library script. Accepting saves a session copy of v${version.version_no} with the right-hand side as v2; the library script is not changed.`
      : `Session script. Accepting saves the right-hand side as v${nextNo}; earlier versions stay in the history.`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SetTabInspector
        version={`${proposal.id}|${proposal.status}|${readOnly}`}
        sections={[
          { id: 'proposal-summary', title: 'Proposal', content: <InspectorSummary proposalId={proposal.id} /> },
          { id: 'proposal-flags', title: 'High-impact changes', content: <InspectorFlags proposalId={proposal.id} /> },
        ]}
      />

      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2">
        <h2 className="truncate text-body font-semibold text-text">
          {script.name}: proposed adaptation of v{version.version_no}
        </h2>
        <p className="flex flex-wrap gap-x-2 text-small text-muted">
          <span className="font-mono text-text">{script.filename}</span>
          <span aria-hidden>·</span>
          <span>{universal ? 'Library script' : 'Session script'}</span>
          <span aria-hidden>·</span>
          <span>Left v{version.version_no}, right {proposal.status === 'accepted' && result ? `saved v${result.versionNo}` : "Claude's proposal"}</span>
          {view.readmeLabel ? (
            <>
              <span aria-hidden>·</span>
              <span>README {view.readmeLabel}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className="text-text">{STATUS_LABEL[proposal.status]}</span>
        </p>
        {headline ? <p className="text-small text-text">{headline}</p> : null}
        {details.length ? <p className="whitespace-pre-wrap text-small text-muted">{details.join('\n')}</p> : null}
        {explanation ? <p className="text-small text-muted">{explanation}</p> : null}
      </div>

      {proposal.status === 'accepted' && result ? (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2 text-small text-text">
          <Check aria-hidden className="size-4 shrink-0 text-accent" />
          <span>
            Accepted as {result.filename} v{result.versionNo}
            {universal ? `, a session copy of ${script.name} v${version.version_no}. The library script is unchanged.` : '.'}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => openTab(scriptTab(result.scriptId, result.filename))}>
              <FileText aria-hidden className="size-4" />
              Open {result.filename} v{result.versionNo}
            </Button>
            <a href={downloadHref(result.versionId)} download className={buttonVariants({ variant: 'primary' })}>
              <Download aria-hidden className="size-4" />
              Download v{result.versionNo}
            </a>
          </div>
        </div>
      ) : proposal.status === 'rejected' ? (
        <p role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2 text-small text-text">
          <X aria-hidden className="size-4 shrink-0 text-muted" />
          Rejected. Nothing was saved.
        </p>
      ) : view.sessionStatus === 'completed' ? (
        <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-small text-muted">
          This session is completed, so this proposal is read-only.
        </p>
      ) : null}

      {shownConflict && editable ? (
        <div role="alert" className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-2">
          <p className="flex items-center gap-2 text-small text-text">
            <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
            v{shownConflict.latestVersionNo} of {script.name} was saved after this proposal (based on v{version.version_no}). Nothing was overwritten
            {dirty ? ' and your edits are still here' : ''}. Accepting would hide those changes, so propose again against v{shownConflict.latestVersionNo}.
          </p>
          <div>
            <Button onClick={() => void repropose()} loading={busy === 'repropose'} disabled={busy !== null}>
              <RefreshCw aria-hidden className="size-4" />
              Re-propose against v{shownConflict.latestVersionNo}
            </Button>
          </div>
        </div>
      ) : null}

      {banner ? (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={cn('flex shrink-0 items-start justify-between gap-2 border-b bg-surface px-4 py-2 text-small text-text', banner.kind === 'error' ? 'border-danger' : 'border-border')}
        >
          <p>{banner.text}</p>
          <Button variant="ghost" className="h-control-sm px-2" aria-label="Dismiss message" onClick={() => setBanner(null)}>
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      ) : null}

      <section aria-label="Proposed changes" className="min-h-0 flex-1">
        <ReviewDiff
          original={version.content}
          modified={readOnly ? shown : content}
          language={version.language}
          lineEnding={version.line_ending}
          readOnly={readOnly}
          ariaLabel={`${script.filename} proposal`}
          onModifiedEditor={(ed) => {
            editorRef.current = ed;
            setEditorReady(!!ed);
          }}
          onReady={(value) => {
            if (!editable) return;
            const d = useDrafts.getState().drafts[key];
            if (!d || d.baseVersionId !== proposal.base_version_id) putDraft(key, { baseVersionId: proposal.base_version_id, pristine: value, content: value });
          }}
          onChange={(value) => {
            if (!editable) return;
            const d = useDrafts.getState().drafts[key];
            putDraft(key, { baseVersionId: proposal.base_version_id, pristine: d?.pristine ?? proposal.proposed_content, content: value });
          }}
        />
      </section>

      {editable ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2">
          <span role="status" className={cn('text-small', scanning || dirty ? 'text-warning' : 'text-muted')}>
            {scanning
              ? 'Checking your edits for high-impact changes…'
              : flags.length > ackedCount
                ? `Acknowledge ${flags.length - ackedCount} more high-impact ${flags.length - ackedCount === 1 ? 'change' : 'changes'} in the inspector.`
                : dirty
                  ? 'Your edits will be saved with the proposal.'
                  : 'Review the diff, then accept or reject.'}
          </span>
          {!inspectorOpen && flags.length > 0 ? (
            <Button variant="ghost" onClick={() => useInspectorStore.getState().setOpen(true)}>
              <PanelRight aria-hidden className="size-4" />
              Show checklist
            </Button>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => editorRef.current?.focus()} disabled={!editorReady || busy !== null}>
              <PencilLine aria-hidden className="size-4" />
              Keep editing
            </Button>
            <Button variant="secondary" onClick={() => setConfirmReject(true)} loading={busy === 'reject'} disabled={busy !== null}>
              Reject
            </Button>
            <Button
              onClick={() => void accept()}
              loading={busy === 'accept'}
              disabled={!canAccept}
              title={ackedCount < flags.length ? 'Acknowledge every high-impact change in the inspector first' : undefined}
            >
              {acceptLabel(ackedCount, flags.length)}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={confirmReject} onOpenChange={setConfirmReject}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this proposal?</DialogTitle>
            <DialogDescription>
              Nothing is saved{dirty ? ' and your edits are discarded' : ''}. The proposal stays in the session as rejected; you can ask Claude for a new one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmReject(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void reject()}>
              Reject proposal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InspectorSummary({ proposalId }: { proposalId: string }) {
  const entry = useProposalReview((s) => s.entries[proposalId]);
  if (!entry) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-wrap text-text">{entry.summary}</p>
      {entry.readOnly ? null : <p>Accept stays disabled until every high-impact change below is acknowledged.</p>}
    </div>
  );
}

function InspectorFlags({ proposalId }: { proposalId: string }) {
  const entry = useProposalReview((s) => s.entries[proposalId]);
  const toggle = useProposalReview((s) => s.toggle);
  if (!entry) return null;
  const ack = new Set(entry.acknowledged);
  const done = entry.flags.filter((f) => ack.has(f.id)).length;
  return (
    <div className="flex flex-col gap-4">
      {entry.flags.length ? (
        <p role="status">
          {done} of {entry.flags.length} acknowledged
        </p>
      ) : null}
      <FlagChecklist
        flags={entry.flags}
        acknowledged={entry.acknowledged}
        readOnly={entry.readOnly}
        onToggle={(flagId, checked) => toggle(proposalId, flagId, checked)}
        onJump={(line) => jumpTo(proposalId, line)}
      />
    </div>
  );
}
