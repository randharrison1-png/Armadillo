'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import { Bot, Check, CircleHelp, ListChecks, ScrollText, Sparkles, Wrench, X } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { Button } from '@/components/ui/button';
import { Gated } from '@/components/ui/gated';
import { fieldClass } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { openToolRoute, toolRouteFor } from '@/features/flowchart/toolRoutes';
import { proposalTab } from '@/features/proposals/review';
import { getWorkspaceStore } from '@/features/workspace/store';
import type { TabDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  applyVerificationAction,
  confirmAllSuggestionsAction,
  loadReportRaw,
  loadReportsView,
  loadReportView,
  proposeRemediationAction,
  setFindingRequirementAction,
  suggestMappingsAction,
} from './actions';
import { MAX_FINDINGS } from './parsers/shared';
import { reportTab, useReportUi } from './reportUi';
import { READ_ONLY_REASON, remediationBlockedReason } from './remediationRules';
import type { ReportDetail, ReportFinding, ReportRequirement, ReportsOverview, ReportSummary } from './service';
import { UploadReport } from './UploadReport';

/** Findings rows / raw lines shown at first; "Show more" adds another chunk (large reports never freeze the tab). */
export const ROWS_CHUNK = 200;
export const RAW_CHUNK = 1000;

const dateLabel = (d: Date) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d)} UTC`;
const scoreLabel = (score: number, max: number | null) => (max ? `${score} / ${max}` : String(score));

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'missing' } | { state: 'ready'; data: T };

/** Body of a 'report' workspace tab: one report (resourceId) or the session's reports list. */
export function ReportTab({ namespace: sessionId, tab }: { namespace: string; tab: TabDescriptor }) {
  return tab.resourceId ? <ReportView key={tab.resourceId} sessionId={sessionId} reportId={tab.resourceId} /> : <ReportsList sessionId={sessionId} />;
}

function useLoaded<T>(load: () => Promise<T | null>, deps: unknown[]) {
  const [state, setState] = useState<Load<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setState(data ? { state: 'ready', data } : { state: 'missing' }),
      () => !cancelled && setState({ state: 'error' }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is rebuilt each render; `deps` say when to reload
  }, [...deps, attempt]);
  const retry = () => (setState({ state: 'loading' }), setAttempt((n) => n + 1));
  return [state, retry] as const;
}

/* ---------------------------------------------------------------------------------------------- */
/* Reports list                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

function ReportsList({ sessionId }: { sessionId: string }) {
  const version = useReportUi((s) => s.version[sessionId] ?? 0);
  const [load, retry] = useLoaded<ReportsOverview>(() => loadReportsView(sessionId), [sessionId, version]);

  if (load.state === 'loading') return <LoadingState label="Loading reports" />;
  if (load.state === 'error') return <ErrorState title="Could not load the reports" detail="Check your connection and try again." onRetry={retry} />;
  if (load.state === 'missing') return <EmptyState icon={ScrollText} title="Session not found" description="This session no longer exists." />;

  const { reports, sessionStatus, currentCycle } = load.data;
  const completed = sessionStatus === 'completed';

  if (reports.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title="No LEADS reports yet"
        description={
          completed
            ? 'This session is completed, so a report can no longer be added.'
            : 'After running the hardening script, run the LEADS audit script locally and upload its output here. Armadillo keeps the raw text and parses findings where it can.'
        }
        actions={completed ? null : <UploadReport sessionId={sessionId} />}
      />
    );
  }

  // Newest first: cycles descending, reports within a cycle newest first (the query's order).
  const cycles = [...new Set(reports.map((r) => r.cycleNo))].sort((a, b) => b - a);
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4 p-4" aria-label="LEADS reports">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-2">
        <div>
          <h2 className="text-body font-semibold text-text">LEADS reports</h2>
          <p className="text-small text-muted">Output you uploaded after running the LEADS audit script, grouped by audit cycle.</p>
        </div>
        {completed ? <p className="text-small text-muted">This session is completed; reports can no longer be added.</p> : <UploadReport sessionId={sessionId} variant="secondary" />}
      </header>
      {cycles.map((cycle) => (
        <section key={cycle} aria-label={`Cycle ${cycle}`} className="flex flex-col gap-2">
          <h3 className="text-small font-semibold text-muted">
            Cycle {cycle}
            {cycle === currentCycle ? ' · current' : ''}
          </h3>
          <ul className="flex flex-col gap-2">
            {reports.filter((r) => r.cycleNo === cycle).map((r) => (
              <ReportRow key={r.id} sessionId={sessionId} report={r} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function ReportRow({ sessionId, report }: { sessionId: string; report: ReportSummary }) {
  const { counts } = report;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface p-2">
      <div className="min-w-0">
        <p className="break-words text-small font-medium text-text">{report.filename}</p>
        <p className="text-small text-muted">
          {dateLabel(report.createdAt)} · Parser: {report.parser}
          {report.score !== null ? ` · Reported score: ${scoreLabel(report.score, report.scoreMax)}` : ''}
        </p>
        <p className="text-small text-muted">
          Fail {counts.fail} · Pass {counts.pass} · Unknown {counts.unknown}
        </p>
      </div>
      <Button variant="secondary" aria-label={`Open report ${report.filename}`} onClick={() => getWorkspaceStore(sessionId).getState().openTab(reportTab(report.id, report.filename))}>
        Open
      </Button>
    </li>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* One report                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const ALL = 'all-values';
type StatusFilter = typeof ALL | ReportFinding['status'];
const STATUS_LABEL: Record<ReportFinding['status'], string> = { fail: 'Fail', pass: 'Pass', unknown: 'Unknown' };
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const STATUS_ICON = { fail: X, pass: Check, unknown: CircleHelp } as const;

function ReportView({ sessionId, reportId }: { sessionId: string; reportId: string }) {
  const version = useReportUi((s) => s.version[sessionId] ?? 0);
  const [load, retry] = useLoaded<ReportDetail>(() => loadReportView(sessionId, reportId), [sessionId, reportId, version]);
  const [raw, setRaw] = useState<boolean | null>(null);

  if (load.state === 'loading') return <LoadingState label="Loading report" />;
  if (load.state === 'error') return <ErrorState title="Could not load the report" detail="Check your connection and try again." onRetry={retry} />;
  if (load.state === 'missing') return <EmptyState icon={ScrollText} title="Report not found" description="This report no longer exists." />;

  const { report, findings, requirements, remediation, sessionStatus, currentCycle, cycleOutcome } = load.data;
  const readOnly = sessionStatus === 'completed';
  const showRaw = raw ?? findings.length === 0; // nothing parsed: the raw text is the report
  const counts = { fail: 0, pass: 0, unknown: 0 };
  for (const f of findings) counts[f.status]++;

  const sendToClaude = () =>
    openToolRoute(sessionId, toolRouteFor('inspect_leads', { sessionId, latestReport: { id: report.id, filename: report.filename }, latestSessionScript: null, latestRemediation: null }));
  const reload = () => useReportUi.getState().bumpVersion(sessionId);

  return (
    <article className="mx-auto flex max-w-4xl flex-col gap-4 p-4" aria-label={`Report ${report.filename}`}>
      <header className="flex flex-col gap-2 border-b border-border pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 break-words text-body font-semibold text-text">{report.filename}</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" aria-pressed={showRaw} onClick={() => setRaw(!showRaw)}>
              Raw
            </Button>
            <Button variant="secondary" onClick={sendToClaude}>
              <Bot aria-hidden className="size-4" />
              Send to Claude
            </Button>
            <ProposeRemediation
              sessionId={sessionId}
              reportId={report.id}
              disabledReason={remediationBlockedReason({
                sessionStatus,
                reportCycle: report.cycleNo,
                currentCycle,
                outcome: cycleOutcome,
                hasHardeningScript: !!remediation.hardeningScript,
                findings,
              })}
              onProposed={reload}
            />
          </div>
        </div>
        <p className="flex flex-wrap gap-x-2 text-small text-muted">
          <span>Cycle {report.cycleNo}</span>
          <span aria-hidden>·</span>
          <span>Uploaded {dateLabel(report.createdAt)}</span>
          <span aria-hidden>·</span>
          <span>Parser: {report.parser}</span>
        </p>
        {report.score !== null ? (
          <p className="text-small text-muted">
            Reported score: <span className="font-medium text-text">{scoreLabel(report.score, report.scoreMax)}</span>
            <span> (as stated by the report; not verified by Armadillo)</span>
          </p>
        ) : null}
        {report.parseError ? (
          <p role="status" className="text-small text-warning">
            This report could not be parsed ({report.parseError}). The raw text is kept.
          </p>
        ) : null}
        {report.parseNote ? (
          <p role="status" className="text-small text-warning">
            {report.parseNote}
          </p>
        ) : null}
        {remediation.hardeningScript && !readOnly && report.cycleNo === currentCycle && cycleOutcome !== 'completed' ? (
          <p className="text-small text-muted">
            A remediation covers only the failing findings and is written against {remediation.hardeningScript}; it does not re-run the hardening script.
          </p>
        ) : null}
        {remediation.proposal ? (
          <p className="flex flex-wrap items-center gap-2 text-small text-text">
            <Wrench aria-hidden className="size-4 shrink-0 text-muted" />
            {remediation.proposal.title}: {PROPOSAL_STATUS[remediation.proposal.status]}
            <Button
              variant="ghost"
              className="h-control-sm px-2"
              onClick={() => getWorkspaceStore(sessionId).getState().openTab(proposalTab(remediation.proposal!.id, remediation.proposal!.title))}
            >
              Open remediation proposal
            </Button>
          </p>
        ) : null}
        {report.truncated ? (
          <p role="status" className="text-small text-warning">
            Only the first {MAX_FINDINGS.toLocaleString('en-US')} findings are listed; the rest are in the raw text.
          </p>
        ) : null}
      </header>
      {showRaw ? (
        <RawText sessionId={sessionId} reportId={reportId} total={report.lineCount} />
      ) : (
        <>
          <VerificationBar reportId={report.id} findings={findings} requirements={requirements} readOnly={readOnly} onChanged={reload} />
          <FindingsTable findings={findings} counts={counts} requirements={requirements} readOnly={readOnly} onChanged={reload} />
        </>
      )}
    </article>
  );
}

type MappingProps = { requirements: ReportRequirement[]; readOnly: boolean; onChanged: () => void };

function FindingsTable({ findings, counts, requirements, readOnly, onChanged }: { findings: ReportFinding[]; counts: Record<ReportFinding['status'], number> } & MappingProps) {
  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [severity, setSeverity] = useState<string>(ALL);
  const [shown, setShown] = useState(ROWS_CHUNK);

  const severities = SEVERITY_ORDER.filter((s) => findings.some((f) => f.severity === s));
  const hasUnspecified = findings.some((f) => !f.severity);
  const visible = findings.filter((f) => (status === ALL || f.status === status) && (severity === ALL || (severity === 'unspecified' ? !f.severity : f.severity === severity)));

  return (
    <section className="flex flex-col gap-2" aria-label="Findings">
      <div className="flex flex-wrap items-center gap-4">
        <p className="text-small text-text" aria-label="Finding counts">
          Fail {counts.fail} · Pass {counts.pass} · Unknown {counts.unknown}
        </p>
        <div className="flex flex-wrap gap-2">
          <Select value={status} onValueChange={(v) => (setStatus(v as StatusFilter), setShown(ROWS_CHUNK))}>
            <SelectTrigger aria-label="Status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={(v) => (setSeverity(v), setShown(ROWS_CHUNK))}>
            <SelectTrigger aria-label="Severity" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All severities</SelectItem>
              {severities.map((s) => (
                <SelectItem key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
              {hasUnspecified ? <SelectItem value="unspecified">No severity</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
      </div>
      {visible.length === 0 ? (
        <p role="status" className="py-4 text-small text-muted">
          {findings.length === 0 ? 'No findings could be parsed from this report. Use Raw to read it.' : 'No findings match these filters.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full border-collapse text-left text-small">
            <caption className="sr-only">Findings parsed from the report</caption>
            <thead className="bg-surface text-muted">
              <tr>
                <th scope="col" className="px-2 py-2 font-medium">Status</th>
                <th scope="col" className="px-2 py-2 font-medium">Severity</th>
                <th scope="col" className="px-2 py-2 font-medium">Category</th>
                <th scope="col" className="w-full px-2 py-2 font-medium">Finding</th>
                <th scope="col" className="px-2 py-2 font-medium">Line</th>
                <th scope="col" className="min-w-64 px-2 py-2 font-medium">Requirement</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, shown).map((f) => (
                <FindingRow key={f.id} finding={f} requirements={requirements} readOnly={readOnly} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown < visible.length ? (
        <div className="flex items-center gap-4">
          <p className="text-small text-muted">
            Showing {shown} of {visible.length} findings
          </p>
          <Button variant="secondary" onClick={() => setShown(shown + ROWS_CHUNK)}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const FindingRow = memo(function FindingRow({ finding: f, requirements, readOnly, onChanged }: { finding: ReportFinding } & MappingProps) {
  const Icon = STATUS_ICON[f.status];
  return (
    <tr className="border-t border-border align-top hover:bg-surface-raised">
      <td className="whitespace-nowrap px-2 py-2">
        <span className={cn('inline-flex items-center gap-1', f.status === 'fail' ? 'text-danger' : f.status === 'pass' ? 'text-accent' : 'text-muted')}>
          <Icon aria-hidden className="size-4" />
          {STATUS_LABEL[f.status]}
        </span>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-text">{f.severity ? f.severity[0]!.toUpperCase() + f.severity.slice(1) : <span className="text-muted">None</span>}</td>
      <td className="px-2 py-2 text-muted">{f.category ?? ''}</td>
      <td className="break-words px-2 py-2 text-text">{f.title}</td>
      <td className="whitespace-nowrap px-2 py-2 text-muted">{f.rawLine ?? '—'}</td>
      <td className="px-2 py-2">
        <MappingCell finding={f} requirements={requirements} readOnly={readOnly} onChanged={onChanged} />
      </td>
    </tr>
  );
});

const PROPOSAL_STATUS = { pending: 'pending review', accepted: 'accepted', rejected: 'rejected' } as const;

/** "Propose remediation": Claude writes a targeted script for this report's failing findings; it opens in a diff tab for review. */
function ProposeRemediation({ sessionId, reportId, disabledReason, onProposed }: { sessionId: string; reportId: string; disabledReason: string | null; onProposed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await proposeRemediationAction({ sessionId, reportId });
      if (!r.ok) return setError(r.error);
      getWorkspaceStore(sessionId).getState().openTab(proposalTab(r.proposalId, r.title));
      onProposed();
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Gated reason={disabledReason}>
        <Button onClick={() => void propose()} loading={busy} disabled={!!disabledReason || busy}>
          <Wrench aria-hidden className="size-4" />
          Propose remediation
        </Button>
      </Gated>
      {error ? (
        <p role="alert" className="w-full text-small text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

type Busy = 'suggest' | 'confirm' | 'verify' | null;

/**
 * Passing findings become verification evidence, but only through mappings the user confirmed:
 * "Suggest mappings" (Claude), "Confirm all suggestions", then "Apply verification".
 */
function VerificationBar({ reportId, findings, requirements, readOnly, onChanged }: { reportId: string; findings: ReportFinding[] } & MappingProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ kind: 'status' | 'error'; lines: string[] } | null>(null);
  if (findings.length === 0) return null;
  const pending = findings.filter((f) => f.suggestedRequirementId && !f.requirementId).length;
  const confirmedPasses = findings.filter((f) => f.status === 'pass' && f.requirementId).length;
  const ro = readOnly ? READ_ONLY_REASON : null;

  const run = async (kind: Exclude<Busy, null>) => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'suggest') {
        const r = await suggestMappingsAction({ reportId });
        if (!r.ok) return setNotice({ kind: 'error', lines: [r.error] });
        setNotice({ kind: 'status', lines: [`Claude suggested a requirement for ${r.suggested} of ${r.considered} findings. Confirm, change or clear each suggestion.`] });
      } else if (kind === 'confirm') {
        const r = await confirmAllSuggestionsAction({ reportId });
        if (!r.ok) return setNotice({ kind: 'error', lines: [r.error] });
        setNotice({ kind: 'status', lines: [`Confirmed ${r.confirmed} ${r.confirmed === 1 ? 'suggestion' : 'suggestions'}.`] });
      } else {
        const r = await applyVerificationAction({ reportId });
        if (!r.ok) return setNotice({ kind: 'error', lines: [r.error] });
        const head = `${r.verified} ${r.verified === 1 ? 'requirement' : 'requirements'} verified by this report${r.alreadyVerified ? ` (${r.alreadyVerified} already verified)` : ''}.`;
        setNotice({ kind: 'status', lines: [head, ...r.messages] });
      }
      onChanged();
    } catch {
      setNotice({ kind: 'error', lines: ['Could not reach the server. Try again.'] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Verification evidence" className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-2">
      <p className="text-small text-muted">
        A passing finding is verification evidence for the requirement it checks, once you confirm the mapping. Failing findings never undo a verified requirement.
      </p>
      <div className="flex flex-wrap gap-2">
        <Gated reason={ro ?? (requirements.length === 0 ? 'Extract requirements from the README first' : null)}>
          <Button variant="secondary" onClick={() => void run('suggest')} loading={busy === 'suggest'} disabled={!!ro || requirements.length === 0 || busy !== null}>
            <Sparkles aria-hidden className="size-4" />
            Suggest mappings
          </Button>
        </Gated>
        <Gated reason={ro ?? (pending === 0 ? 'No suggestions waiting for confirmation' : null)}>
          <Button variant="secondary" onClick={() => void run('confirm')} loading={busy === 'confirm'} disabled={!!ro || pending === 0 || busy !== null}>
            <ListChecks aria-hidden className="size-4" />
            Confirm all suggestions{pending ? ` (${pending})` : ''}
          </Button>
        </Gated>
        <Gated reason={ro ?? (confirmedPasses === 0 ? 'Confirm a mapping for a passing finding first' : null)}>
          <Button onClick={() => void run('verify')} loading={busy === 'verify'} disabled={!!ro || confirmedPasses === 0 || busy !== null}>
            <Check aria-hidden className="size-4" />
            Apply verification
          </Button>
        </Gated>
      </div>
      {notice ? (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('flex flex-col gap-1 text-small', notice.kind === 'error' ? 'text-danger' : 'text-text')}>
          {notice.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One finding's mapping: confirmed (Change / Clear), suggested (Confirm / Change / Clear), or none (Map). */
function MappingCell({ finding: f, requirements, readOnly, onChanged }: { finding: ReportFinding } & MappingProps) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textOf = (id: string | null) => (id ? requirements.find((r) => r.id === id)?.text ?? 'Unknown requirement' : null);
  const confirmed = textOf(f.requirementId);
  const suggested = f.requirementId ? null : textOf(f.suggestedRequirementId);

  const save = async (requirementId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await setFindingRequirementAction({ findingId: f.id, requirementId });
      if (!r.ok) return setError(r.error);
      setEditing(false);
      onChanged();
    } catch {
      setError('Could not save the mapping. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice) void save(choice);
        }}
      >
        <select aria-label={`Requirement for ${f.title}`} className={cn(fieldClass, 'h-control-sm')} value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a requirement…</option>
          {requirements.map((r) => (
            <option key={r.id} value={r.id}>
              {clip(r.text)}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          <Button type="submit" className="h-control-sm px-2" loading={busy} disabled={!choice}>
            Save
          </Button>
          <Button type="button" variant="ghost" className="h-control-sm px-2" onClick={() => (setEditing(false), setError(null))}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  const change = () => {
    setChoice(f.requirementId ?? f.suggestedRequirementId ?? '');
    setEditing(true);
  };
  return (
    <div className="flex flex-col gap-1" data-testid="finding-mapping">
      {confirmed ? (
        <p className="break-words text-text">
          <span className="sr-only">Confirmed: </span>
          {confirmed}
        </p>
      ) : suggested ? (
        <p className="break-words text-muted">
          Suggested: <span className="text-text">{suggested}</span>
        </p>
      ) : (
        <p className="text-muted">Not mapped</p>
      )}
      {readOnly || requirements.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {suggested ? (
            <Button variant="secondary" className="h-control-sm px-2" loading={busy} aria-label={`Confirm mapping for ${f.title}`} onClick={() => void save(f.suggestedRequirementId)}>
              Confirm
            </Button>
          ) : null}
          <Button variant="ghost" className="h-control-sm px-2" aria-label={`${confirmed || suggested ? 'Change' : 'Map'} requirement for ${f.title}`} onClick={change} disabled={busy}>
            {confirmed || suggested ? 'Change' : 'Map'}
          </Button>
          {confirmed || suggested ? (
            <Button variant="ghost" className="h-control-sm px-2" aria-label={`Clear mapping for ${f.title}`} onClick={() => void save(null)} disabled={busy}>
              Clear
            </Button>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The report's raw text as plain text (never HTML), loaded and rendered a chunk at a time. */
function RawText({ sessionId, reportId, total }: { sessionId: string; reportId: string; total: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [all, setAll] = useState(total);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const apply = useCallback((offset: number, page: { lines: string[]; total: number } | null) => {
    if (!page) return setState('error');
    setLines((prev) => (offset === 0 ? page.lines : [...prev, ...page.lines]));
    setAll(page.total);
    setState('ready');
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadReportRaw(sessionId, reportId, 0, RAW_CHUNK).then(
      (page) => !cancelled && apply(0, page),
      () => !cancelled && setState('error'),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, reportId, apply]);
  const more = (offset: number) => {
    setState('loading');
    loadReportRaw(sessionId, reportId, offset, RAW_CHUNK).then(
      (page) => apply(offset, page),
      () => setState('error'),
    );
  };

  return (
    <section aria-label="Raw report text" className="flex flex-col gap-2">
      {lines.length > 0 ? (
        <pre data-testid="raw-text" className="overflow-x-auto rounded-sm border border-border bg-surface p-2 font-mono text-small text-text">
          {lines.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span aria-hidden className="w-10 shrink-0 select-none text-right text-muted">
                {i + 1}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-words">{line}</span>
            </div>
          ))}
        </pre>
      ) : null}
      {state === 'loading' ? <LoadingState label="Loading raw text" /> : null}
      {state === 'error' ? <ErrorState title="Could not load the raw text" detail="Check your connection and try again." onRetry={() => more(lines.length)} /> : null}
      {state === 'ready' && lines.length < all ? (
        <div className="flex items-center gap-4">
          <p className="text-small text-muted">
            Showing {lines.length} of {all} lines
          </p>
          <Button variant="secondary" onClick={() => more(lines.length)}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
