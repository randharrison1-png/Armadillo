import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAnthropicMock, type AnthropicMock } from '../support/anthropic-mock';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';
import { createScriptFor, insertScriptWithV1 } from '@/features/library/service';
import { addReadmeFor } from '@/features/readme/service';
import { recordLeadsReportFor } from '@/features/reports/service';
import { withUser } from '@/server/db/withUser';
import type { HighImpactFlag, Proposal, Script, ScriptVersion } from '@/lib/types';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current, getCurrentUser: async () => current }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const remediation = await import('@/features/reports/remediation');
const cycles = await import('@/features/reports/cycles');
const proposals = await import('@/features/proposals/service');
const flowchart = await import('@/features/flowchart/service');
const { getRequirementsViewFor } = await import('@/features/requirements/service');
const { getReportDetailFor } = await import('@/features/reports/service');
const { GET: download } = await import('@/app/api/files/download/[versionId]/route');

let mock: AnthropicMock;

beforeAll(async () => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
  mock = await startAnthropicMock();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = 'env-test-key-0000';
  process.env.CLAUDE_MAX_RETRIES = '0';
});
afterAll(async () => {
  await mock.close();
  await closePool();
  await sql.end();
});
beforeEach(() => mock.reset());

const enc = (s: string) => new TextEncoder().encode(s);
const HARDENING = 'Write-Host start\r\nSet-NetFirewallProfile -Enabled True\r\nWrite-Host end\r\n';
const FAILING_REPORT = [
  'LEADS Audit Report',
  '[-] Guest account is enabled',
  '[+] Windows Firewall enabled for all profiles',
  '[!] Automatic updates are set to notify only',
  '[+] SMBv1 is disabled',
  'Score: 40/100 points',
].join('\n');
const PASSING_REPORT = ['[+] Guest account is disabled', '[+] Windows Firewall enabled for all profiles', 'Score: 100/100 points'].join('\n');

/** What Claude returns for a remediation (LF; stored with the base's CRLF). */
const REMEDIATION = ['# Targeted remediation', 'Disable-LocalUser -Name Guest', 'Write-Host done', ''].join('\n');
const remediationAnswer = (over: Record<string, unknown> = {}) => ({
  match: 'record_remediation',
  toolUse: { input: { content: REMEDIATION, summary: 'Disable Guest; check updates by hand\nOnly the failing findings.', flags: [], ...over } },
});

async function world() {
  current = await createTestUser();
  const session = await createSessionFor(current.id, { title: 'Cycle round', os: 'windows' });
  const readme = await addReadmeFor(current.id, { sessionId: session.id, pasted: 'Disable the guest account.\n\nKeep the firewall on.\n\nTurn on automatic updates.' });
  const script = await withUser(current.id, (tx) =>
    insertScriptWithV1(tx, {
      name: 'Session hardening', filename: 'harden.ps1', category: 'windows', fn: 'session_generated', osCompat: ['windows', 'windows_server'],
      content: HARDENING, format: { encoding: 'utf-8-bom', lineEnding: 'crlf' }, sessionId: session.id, activity: { action: 'test.seed' },
    }),
  );
  const [guest, firewall, updates] = await sql<{ id: string }[]>`
    insert into public.requirements (owner_id, session_id, readme_id, text, segment_id, coverage, work_state, script_version_id, created_at)
    values (${current.id}, ${session.id}, ${readme.id}, 'Disable the guest account', 'p-0-x', 'covered', 'proposed', ${script.current_version_id}, now()),
           (${current.id}, ${session.id}, ${readme.id}, 'Keep the firewall on', 'p-1-x', 'covered', 'proposed', ${script.current_version_id}, now() + interval '1 ms'),
           (${current.id}, ${session.id}, ${readme.id}, 'Turn on automatic updates', 'p-2-x', 'missing', 'proposed', ${script.current_version_id}, now() + interval '2 ms')
    returning id`;
  return { userId: current.id, sessionId: session.id, readmeId: readme.id, script, req: { guest: guest!.id, firewall: firewall!.id, updates: updates!.id } };
}
type World = Awaited<ReturnType<typeof world>>;

const addReport = (w: World, text = FAILING_REPORT, filename = 'leads.txt') =>
  recordLeadsReportFor(w.userId, { sessionId: w.sessionId, file: { bytes: enc(text), filename } });
const findingsOf = (reportId: string) =>
  sql<{ id: string; title: string; status: string; requirement_id: string | null; suggested_requirement_id: string | null }[]>`
    select id, title, status, requirement_id, suggested_requirement_id from public.leads_findings where report_id = ${reportId} order by raw_line`;
const stepStatus = async (sessionId: string, step: string) =>
  (await sql<{ status: string }[]>`select status from public.workflow_steps where session_id = ${sessionId} and step = ${step}::public.step_key`)[0]!.status;
const reqRow = async (id: string) => (await sql`select work_state, evidence_report_id from public.requirements where id = ${id}`)[0]!;
const versionsOf = (scriptId: string) => sql<ScriptVersion[]>`select * from public.script_versions where script_id = ${scriptId} order by version_no`;

type Body = { system: string; messages: { role: string; content: { type: string; text?: string }[] | string }[]; tool_choice?: { name: string } };
const requestText = (i = 0) => {
  const first = (mock.requests()[i]!.body as Body).messages[0]!.content;
  return typeof first === 'string' ? first : first.map((b) => b.text ?? '').join('\n');
};
const block = (text: string, type: string) => new RegExp(`<untrusted_document_[0-9a-f]{20} type="${type}"[^>]*>([\\s\\S]*?)</untrusted_document_`).exec(text)?.[1] ?? '';

/** Waits until the mock has received a Claude request (the remediation's pre-checks have passed). */
async function waitForClaude(n = 1) {
  for (let i = 0; i < 200 && mock.requests().length < n; i++) await new Promise((r) => setTimeout(r, 10));
  expect(mock.requests().length).toBeGreaterThanOrEqual(n);
}

async function propose(w: World, reportId: string, answer = remediationAnswer()) {
  mock.enqueue(answer);
  return remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId });
}

/** Claude maps F<n> (report order) to R<n> (requirement order). */
async function suggest(w: World, reportId: string, mappings: { finding: string; requirement: string | null }[]) {
  mock.enqueue({ match: 'record_finding_mappings', toolUse: { input: { mappings } } });
  return remediation.mapFindingsToRequirementsFor(w.userId, reportId);
}

describe('remediation.test.ts', () => {
  it('remediation context contains only failing findings', async () => {
    const w = await world();
    const report = await addReport(w);
    const r = await propose(w, report.id);

    const body = mock.requests()[0]!.body as Body;
    expect(mock.requests()).toHaveLength(1);
    expect(body.tool_choice?.name).toBe('record_remediation');
    const text = requestText();
    // Refs: exactly the report and the session's current hardening script version.
    expect(text).toContain(`type="leads_report" id="${report.id}"`);
    expect(text).toContain(`type="script_version" id="${w.script.current_version_id}"`);
    expect(text).not.toContain('type="readme"');
    // The findings data block: failing and unknown findings only.
    const findings = block(text, 'findings');
    expect(findings).toContain('"Guest account is enabled"');
    expect(findings).toContain('"Automatic updates are set to notify only"');
    expect(findings).not.toContain('Windows Firewall');
    expect(findings).not.toContain('SMBv1');
    expect(findings.trim().split('\n')).toHaveLength(2);
    // Requirements with coverage and work state; a targeted (not full-rerun) instruction.
    expect(block(text, 'requirements')).toContain('"Disable the guest account" | coverage: covered | state: proposed');
    expect(text).toMatch(/only the failing/i);

    expect(r.proposal).toMatchObject({
      kind: 'remediation', status: 'pending', base_version_id: w.script.current_version_id, readme_id: null, session_id: w.sessionId, cycle_no: 1, report_id: report.id,
    });
    expect(r.proposal.proposed_content).toBe(REMEDIATION.replace(/\n/g, '\r\n'));
    expect(r.title).toBe('Remediation — Cycle 1');
    // Scanner flags are stored even when Claude gave none.
    expect(r.proposal.flags.map((f: HighImpactFlag) => [f.line, f.category])).toEqual([[2, 'accounts']]);
    expect(await sql`select cycle_no, report_id, proposal_id, outcome from public.remediation_cycles where session_id = ${w.sessionId}`).toEqual([
      { cycle_no: 1, report_id: report.id, proposal_id: r.proposal.id, outcome: 'open' },
    ]);
    expect(await stepStatus(w.sessionId, 'run_remediation')).toBe('in_progress');
    const act = await sql`select meta from public.activity_log where entity_id = ${r.proposal.id} and action = 'proposal.create'`;
    expect(act[0]!.meta).toMatchObject({ kind: 'remediation', reportId: report.id, findings: 2 });
    expect(JSON.stringify(act[0]!.meta)).not.toMatch(/Guest|Disable-LocalUser/);
  });

  it('requirement becomes verified only from a confirmed pass finding', async () => {
    const w = await world();
    const report = await addReport(w);
    const res = await suggest(w, report.id, [
      { finding: 'F1', requirement: 'R1' }, // fail: Guest
      { finding: 'F2', requirement: 'R2' }, // pass: firewall
      { finding: 'F3', requirement: 'R3' }, // unknown: updates
    ]);
    const [f1, f2, f3] = await findingsOf(report.id);
    expect(res.mappings).toEqual([
      { findingId: f1!.id, requirementId: w.req.guest },
      { findingId: f2!.id, requirementId: w.req.firewall },
      { findingId: f3!.id, requirementId: w.req.updates },
      { findingId: (await findingsOf(report.id))[3]!.id, requirementId: null },
    ]);
    // Suggestions alone verify nothing.
    expect((await remediation.applyVerificationFor(w.userId, report.id)).verified).toBe(0);
    expect(await reqRow(w.req.firewall)).toEqual({ work_state: 'proposed', evidence_report_id: null });

    const confirmed = await remediation.confirmAllSuggestionsFor(w.userId, report.id);
    expect(confirmed.confirmed).toBe(3);
    const out = await remediation.applyVerificationFor(w.userId, report.id);
    expect(out.verified).toBe(1);
    expect(await reqRow(w.req.firewall)).toEqual({ work_state: 'verified', evidence_report_id: report.id });
    // The failing and unknown findings' requirements are untouched.
    expect(await reqRow(w.req.guest)).toEqual({ work_state: 'proposed', evidence_report_id: null });
    expect(await reqRow(w.req.updates)).toEqual({ work_state: 'proposed', evidence_report_id: null });
  });

  it('continue preserves previous cycle history', async () => {
    const w = await world();
    const report = await addReport(w);
    await flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'inspect_leads', status: 'verified', note: 'read it' });
    await propose(w, report.id);
    await flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'check_points', status: 'blocked', note: 'not 100 yet' });
    const before = await sql`select step, from_status, to_status, cycle_no, note from public.workflow_step_events where session_id = ${w.sessionId} order by created_at, id`;

    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' });

    expect((await sql`select current_cycle from public.sessions where id = ${w.sessionId}`)[0]!.current_cycle).toBe(2);
    for (const s of ['run_leads', 'inspect_leads', 'run_remediation', 'check_points']) expect(await stepStatus(w.sessionId, s)).toBe('not_started');
    // Old events are all still there, unchanged, followed by the resets recorded under cycle 2.
    const after = await sql`select step, from_status, to_status, cycle_no, note from public.workflow_step_events where session_id = ${w.sessionId} order by created_at, id`;
    expect(after.slice(0, before.length)).toEqual(before);
    // The resets share one transaction (same created_at): compare in flowchart order.
    const order = ['run_leads', 'inspect_leads', 'run_remediation', 'check_points'];
    const resets = after.slice(before.length).sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
    expect(resets.map((e) => [e.step, e.from_status, e.to_status, e.cycle_no])).toEqual([
      ['run_leads', 'in_progress', 'not_started', 2],
      ['inspect_leads', 'verified', 'not_started', 2],
      ['run_remediation', 'in_progress', 'not_started', 2],
      ['check_points', 'blocked', 'not_started', 2],
    ]);
    expect(await sql`select cycle_no, outcome, report_id from public.remediation_cycles where session_id = ${w.sessionId} order by cycle_no`).toEqual([
      { cycle_no: 1, outcome: 'continued', report_id: report.id },
    ]);
    // Cycle 1's report and proposal stay; a new report lands in cycle 2.
    const next = await addReport(w, PASSING_REPORT, 'leads2.txt');
    expect(next.cycle_no).toBe(2);
    expect(await sql`select cycle_no from public.leads_reports where session_id = ${w.sessionId} order by created_at`).toEqual([{ cycle_no: 1 }, { cycle_no: 2 }]);
    const data = await flowchart.getFlowchartDataFor(w.userId, w.sessionId);
    expect(data!.cycles.map((c) => [c.cycleNo, c.outcome])).toEqual([[1, 'continued']]);
    expect(data!.currentCycle).toBe(2);
    expect(await sql`select 1 from public.activity_log where session_id = ${w.sessionId} and action = 'cycle.continue'`).toHaveLength(1);
  });
});

describe('proposeRemediation', () => {
  it('refuses without a session hardening script, for another session’s report, and for a completed session', async () => {
    current = await createTestUser();
    const bare = await createSessionFor(current.id, { title: 'No script', os: 'windows' });
    // A universal library script does not count: the remediation targets the session's own script.
    await createScriptFor(current.id, { name: 'Lib', filename: 'lib.ps1', category: 'windows', fn: 'universal_hardening', osCompat: ['windows'], content: 'x' });
    const r = await recordLeadsReportFor(current.id, { sessionId: bare.id, file: { bytes: enc(FAILING_REPORT), filename: 'a.txt' } });
    await expect(remediation.proposeRemediationFor(current.id, { sessionId: bare.id, reportId: r.id })).rejects.toThrow(/hardening script/i);
    expect(mock.requests()).toHaveLength(0);

    const w = await world();
    await expect(remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: r.id })).rejects.toBeInstanceOf(remediation.NotFoundError);
    const mine = await addReport(w);
    const intruder = await createTestUser();
    await expect(remediation.proposeRemediationFor(intruder.id, { sessionId: w.sessionId, reportId: mine.id })).rejects.toBeInstanceOf(remediation.NotFoundError);
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${w.sessionId}`;
    await expect(remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: mine.id })).rejects.toBeInstanceOf(remediation.SessionReadOnlyError);
    expect(mock.requests()).toHaveLength(0);
  });

  it('refuses a report whose parsed findings all pass', async () => {
    const w = await world();
    const report = await addReport(w, PASSING_REPORT);
    await expect(remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: report.id })).rejects.toThrow(/nothing to remediate/i);
    expect(mock.requests()).toHaveLength(0);
  });

  it('a second proposal in the same cycle updates the one cycle row; accepted remediation scripts are never the base', async () => {
    const w = await world();
    const report = await addReport(w);
    const first = await propose(w, report.id);
    await proposals.acceptProposalFor(w.userId, { proposalId: first.proposal.id, acknowledgedFlagIds: first.proposal.flags.map((f: HighImpactFlag) => f.id) });
    const second = await propose(w, report.id);
    expect(second.proposal.base_version_id).toBe(w.script.current_version_id);
    expect(await sql`select proposal_id from public.remediation_cycles where session_id = ${w.sessionId}`).toEqual([{ proposal_id: second.proposal.id }]);
    // The flowchart's "session script" is still the hardening script; the remediation is listed separately.
    const data = await flowchart.getFlowchartDataFor(w.userId, w.sessionId);
    expect(data!.latestSessionScript).toEqual({ scriptId: w.script.id, filename: 'harden.ps1' });
    expect(data!.latestRemediation).toMatchObject({ proposalId: second.proposal.id, status: 'pending', title: 'Remediation — Cycle 1' });
  });
});

describe('remediation cycle integrity', () => {
  it('a new proposal supersedes the pending one; after "Start another cycle" the old proposal cannot be accepted', async () => {
    const w = await world();
    const report = await addReport(w);
    const p1 = await propose(w, report.id);
    const p2 = await propose(w, report.id);
    expect((await sql`select status from public.proposals where id = ${p1.proposal.id}`)[0]!.status).toBe('rejected');
    expect(await sql`select meta from public.activity_log where entity_id = ${p1.proposal.id} and action = 'proposal.supersede'`).toEqual([
      { meta: expect.objectContaining({ kind: 'remediation', cycle: 1, supersededBy: p2.proposal.id }) },
    ]);
    await expect(proposals.acceptProposalFor(w.userId, { proposalId: p1.proposal.id, acknowledgedFlagIds: p1.proposal.flags.map((f: HighImpactFlag) => f.id) })).rejects.toBeInstanceOf(
      proposals.ProposalStateError,
    );

    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' });
    const rowsBefore = await sql`select cycle_no, report_id, proposal_id, outcome, updated_at from public.remediation_cycles where session_id = ${w.sessionId} order by cycle_no`;
    const err = await proposals
      .acceptProposalFor(w.userId, { proposalId: p2.proposal.id, acknowledgedFlagIds: p2.proposal.flags.map((f: HighImpactFlag) => f.id) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(proposals.StaleRemediationError);
    expect((err as Error).message).toBe('This remediation was proposed for cycle 1 — propose again from the current report');
    // Nothing written: no script, the proposal stays pending, cycle 1's row as it was, no cycle 2 row.
    expect(await sql`select 1 from public.scripts where session_id = ${w.sessionId} and name like 'Remediation%'`).toHaveLength(0);
    expect((await sql`select status from public.proposals where id = ${p2.proposal.id}`)[0]!.status).toBe('pending');
    expect(await sql`select cycle_no, report_id, proposal_id, outcome, updated_at from public.remediation_cycles where session_id = ${w.sessionId} order by cycle_no`).toEqual(rowsBefore);
    expect(rowsBefore).toEqual([expect.objectContaining({ cycle_no: 1, proposal_id: p2.proposal.id, outcome: 'continued' })]);
    // The view still names the proposal after its own cycle and report.
    const view = await proposals.getProposalViewFor(w.userId, p2.proposal.id);
    expect(view!.remediation).toEqual({ cycleNo: 1, title: 'Remediation — Cycle 1', reportId: report.id, reportFilename: 'leads.txt' });
  });

  it('refuses a remediation from an earlier cycle’s report, before Claude and without touching any cycle row', async () => {
    const w = await world();
    const old = await addReport(w);
    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' });
    const rowsBefore = await sql`select * from public.remediation_cycles where session_id = ${w.sessionId} order by cycle_no`;
    await expect(remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: old.id })).rejects.toThrow(
      'This report is from cycle 1. Propose a remediation from a report of the current cycle (2).',
    );
    expect(mock.requests()).toHaveLength(0);
    expect(await sql`select * from public.remediation_cycles where session_id = ${w.sessionId} order by cycle_no`).toEqual(rowsBefore);
    expect(await sql`select 1 from public.proposals where session_id = ${w.sessionId}`).toHaveLength(0);
    // A report of cycle 2 works and is recorded under cycle 2.
    const current = await addReport(w, FAILING_REPORT, 'cycle2.txt');
    const r = await propose(w, current.id);
    expect(r).toMatchObject({ cycleNo: 2, title: 'Remediation — Cycle 2' });
    expect(r.proposal).toMatchObject({ cycle_no: 2, report_id: current.id });
  });

  it('a cycle that advances while Claude writes refuses the remediation under the session lock', async () => {
    const w = await world();
    const report = await addReport(w);
    mock.enqueue({ ...remediationAnswer(), initialDelayMs: 400 });
    const pending = remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: report.id });
    await waitForClaude();
    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' });
    await expect(pending).rejects.toThrow('This report is from cycle 1. Propose a remediation from a report of the current cycle (2).');
    expect(await sql`select 1 from public.proposals where session_id = ${w.sessionId}`).toHaveLength(0);
    expect(await sql`select cycle_no, outcome, proposal_id from public.remediation_cycles where session_id = ${w.sessionId}`).toEqual([
      { cycle_no: 1, outcome: 'continued', proposal_id: null },
    ]);
    expect(await stepStatus(w.sessionId, 'run_remediation')).toBe('not_started');
  });
});

describe('acceptProposal (remediation)', () => {
  it('creates a new session script at v1 (author claude); the base script is untouched', async () => {
    const w = await world();
    const report = await addReport(w);
    const { proposal } = await propose(w, report.id);
    const baseBefore = await versionsOf(w.script.id);

    const res = await proposals.acceptProposalFor(w.userId, { proposalId: proposal.id, acknowledgedFlagIds: proposal.flags.map((f: HighImpactFlag) => f.id) });
    expect(res.forked).toBe(false);
    expect(res.script).toMatchObject({
      name: 'Remediation — Cycle 1', filename: 'remediation-cycle-1.ps1', function: 'session_generated', session_id: w.sessionId,
      category: 'windows', os_compat: ['windows', 'windows_server'],
    });
    expect(res.script.id).not.toBe(w.script.id);
    const versions = await versionsOf(res.script.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version_no: 1, author: 'claude', content: REMEDIATION.replace(/\n/g, '\r\n'), encoding: 'utf-8-bom', line_ending: 'crlf', language: 'powershell',
      change_note: 'Claude remediation: Disable Guest; check updates by hand',
    });
    expect(await versionsOf(w.script.id)).toEqual(baseBefore);
    expect((await sql<Script[]>`select * from public.scripts where id = ${w.script.id}`)[0]!.current_version_id).toBe(w.script.current_version_id);
    expect((await sql<Proposal[]>`select status, result_version_id from public.proposals where id = ${proposal.id}`)[0]).toEqual({ status: 'accepted', result_version_id: versions[0]!.id });
    const act = await sql`select meta from public.activity_log where entity_id = ${proposal.id} and action = 'proposal.accept'`;
    expect(act[0]!.meta).toMatchObject({ kind: 'remediation', scriptId: res.script.id, resultVersionId: versions[0]!.id, baseVersionId: w.script.current_version_id });

    // Downloadable as its own file.
    const resp = await download(new Request('http://x/'), { params: Promise.resolve({ versionId: versions[0]!.id }) });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-disposition')).toContain('remediation-cycle-1.ps1');

    // The proposal view says what the accepted remediation produced.
    const view = await proposals.getProposalViewFor(w.userId, proposal.id);
    expect(view!.remediation).toEqual({ cycleNo: 1, title: 'Remediation — Cycle 1', reportId: report.id, reportFilename: 'leads.txt' });
    expect(view!.result).toMatchObject({ scriptName: 'Remediation — Cycle 1', filename: 'remediation-cycle-1.ps1', versionNo: 1 });

    // A second accepted remediation in the same cycle gets its own name.
    const again = await propose(w, report.id);
    const res2 = await proposals.acceptProposalFor(w.userId, { proposalId: again.proposal.id, acknowledgedFlagIds: again.proposal.flags.map((f: HighImpactFlag) => f.id) });
    expect(res2.script).toMatchObject({ name: 'Remediation — Cycle 1 (2)', filename: 'remediation-cycle-1-2.ps1' });
  });

  it('is gated on every flag, including flags of edited content; nothing is written when refused', async () => {
    const w = await world();
    const report = await addReport(w);
    const { proposal } = await propose(w, report.id);
    await expect(proposals.acceptProposalFor(w.userId, { proposalId: proposal.id, acknowledgedFlagIds: [] })).rejects.toBeInstanceOf(proposals.FlagsNotAcknowledgedError);
    const edited = `${proposal.proposed_content}Stop-Service -Name WinRM\r\n`;
    const err = await proposals
      .acceptProposalFor(w.userId, { proposalId: proposal.id, acknowledgedFlagIds: proposal.flags.map((f: HighImpactFlag) => f.id), editedContent: edited })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(proposals.FlagsNotAcknowledgedError);
    // The edited line stops WinRM: a services and a remote-access flag, both new and unacknowledged.
    expect((err as InstanceType<typeof proposals.FlagsNotAcknowledgedError>).missing.map((f) => [f.line, f.category]).sort()).toEqual([
      [4, 'remote_access'],
      [4, 'services'],
    ]);
    expect(await sql`select 1 from public.scripts where session_id = ${w.sessionId} and name like 'Remediation%'`).toHaveLength(0);
    expect((await sql`select status from public.proposals where id = ${proposal.id}`)[0]!.status).toBe('pending');

    const all = [...proposal.flags.map((f: HighImpactFlag) => f.id), ...(err as InstanceType<typeof proposals.FlagsNotAcknowledgedError>).missing.map((f) => f.id)];
    const ok = await proposals.acceptProposalFor(w.userId, { proposalId: proposal.id, acknowledgedFlagIds: all, editedContent: edited });
    expect((await versionsOf(ok.script.id))[0]).toMatchObject({ content: edited, change_note: 'Claude remediation (edited before accepting): Disable Guest; check updates by hand' });
  });
});

describe('finding → requirement mapping', () => {
  it('stores only valid suggestions, sends findings and requirements as data (no documents)', async () => {
    const w = await world();
    const report = await addReport(w);
    const res = await suggest(w, report.id, [
      { finding: 'F1', requirement: 'R1' },
      { finding: 'F2', requirement: 'R99' }, // unknown requirement key: dropped
      { finding: 'F77', requirement: 'R2' }, // unknown finding key: dropped
      { finding: 'F1', requirement: 'R2' }, // repeated finding: dropped
    ]);
    expect(res.dropped).toBe(3);
    const rows = await findingsOf(report.id);
    expect(rows.map((r) => [r.suggested_requirement_id, r.requirement_id])).toEqual([
      [w.req.guest, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
    const text = requestText();
    expect(text).not.toContain('type="leads_report"');
    expect(block(text, 'findings')).toContain('F2: pass | "Windows Firewall enabled for all profiles"');
    expect(block(text, 'requirements')).toContain('R3: "Turn on automatic updates"');
    expect((mock.requests()[0]!.body as Body).tool_choice?.name).toBe('record_finding_mappings');
    expect(await sql`select meta from public.activity_log where entity_id = ${report.id} and action = 'leads_findings.suggest'`).toEqual([
      { meta: expect.objectContaining({ suggested: 1, dropped: 3, findings: 4 }) },
    ]);
  });

  it('confirm, change and clear write requirement_id (logged); requirements of another session are refused', async () => {
    const w = await world();
    const report = await addReport(w);
    await suggest(w, report.id, [{ finding: 'F1', requirement: 'R1' }, { finding: 'F2', requirement: 'R1' }]);
    const [f1, f2] = await findingsOf(report.id);
    await remediation.setFindingRequirementFor(w.userId, { findingId: f1!.id, requirementId: w.req.guest });
    await remediation.setFindingRequirementFor(w.userId, { findingId: f2!.id, requirementId: w.req.firewall }); // "Change"
    let rows = await findingsOf(report.id);
    expect(rows.slice(0, 2).map((r) => r.requirement_id)).toEqual([w.req.guest, w.req.firewall]);
    await remediation.setFindingRequirementFor(w.userId, { findingId: f1!.id, requirementId: null }); // "Clear"
    rows = await findingsOf(report.id);
    expect([rows[0]!.requirement_id, rows[0]!.suggested_requirement_id]).toEqual([null, null]);
    expect(await sql`select meta from public.activity_log where session_id = ${w.sessionId} and action = 'leads_finding.map' order by created_at`).toHaveLength(3);
    // Bulk confirm leaves explicit choices alone.
    expect((await remediation.confirmAllSuggestionsFor(w.userId, report.id)).confirmed).toBe(0);

    const other = await world();
    await expect(remediation.setFindingRequirementFor(w.userId, { findingId: f2!.id, requirementId: other.req.guest })).rejects.toBeInstanceOf(remediation.NotFoundError);
    current = { id: w.userId, email: '' };
    // Defense in depth: the database refuses a cross-session mapping even for the owner.
    const otherSameOwner = await sql<{ id: string }[]>`
      insert into public.sessions (owner_id, title, os) values (${w.userId}, 'Other', 'windows') returning id`;
    const otherReadme = await sql<{ id: string }[]>`
      insert into public.readmes (owner_id, session_id, source, text) values (${w.userId}, ${otherSameOwner[0]!.id}, 'paste', 'x') returning id`;
    const [foreign] = await sql<{ id: string }[]>`
      insert into public.requirements (owner_id, session_id, readme_id, text, segment_id) values (${w.userId}, ${otherSameOwner[0]!.id}, ${otherReadme[0]!.id}, 'x', 'p') returning id`;
    await expect(remediation.setFindingRequirementFor(w.userId, { findingId: f2!.id, requirementId: foreign!.id })).rejects.toBeInstanceOf(remediation.NotFoundError);
    await expect(sql`update public.leads_findings set requirement_id = ${foreign!.id} where id = ${f2!.id}`).rejects.toThrow(/same session|not part of this finding/);
  });

  it('the report detail lists suggestions, confirmations and the session requirements', async () => {
    const w = await world();
    const report = await addReport(w);
    await suggest(w, report.id, [{ finding: 'F1', requirement: 'R1' }]);
    const d = await getReportDetailFor(w.userId, w.sessionId, report.id);
    expect(d!.findings[0]).toMatchObject({ suggestedRequirementId: w.req.guest, requirementId: null });
    expect(d!.requirements.map((r) => r.text)).toEqual(['Disable the guest account', 'Keep the firewall on', 'Turn on automatic updates']);
    expect(d!.remediation).toEqual({ hardeningScript: 'Session hardening · v1', proposal: null });
  });
});

describe('applyVerification', () => {
  it('verifies through the state machine and lists what could not be verified', async () => {
    const w = await world();
    await sql`update public.requirements set coverage = 'manual', script_version_id = null where id = ${w.req.updates}`;
    await sql`update public.requirements set work_state = 'reported' where id = ${w.req.firewall}`;
    const report = await addReport(w, ['[+] Guest account is disabled', '[+] Firewall on', '[+] Updates on', '[+] Extra'].join('\n'));
    await suggest(w, report.id, [{ finding: 'F1', requirement: 'R1' }, { finding: 'F2', requirement: 'R2' }, { finding: 'F3', requirement: 'R3' }]);
    await remediation.confirmAllSuggestionsFor(w.userId, report.id);
    const out = await remediation.applyVerificationFor(w.userId, report.id);
    expect(out).toMatchObject({ verified: 3, skipped: [] });
    for (const id of Object.values(w.req)) expect(await reqRow(id)).toEqual({ work_state: 'verified', evidence_report_id: report.id });
    const act = await sql`select meta from public.activity_log where entity_id = ${report.id} and action = 'requirements.verify'`;
    expect(act[0]!.meta).toMatchObject({ verified: 3, skipped: 0 });

    // A later failing report never downgrades, and the matrix marks the requirement.
    const failing = await addReport(w, '[-] Guest account is enabled', 'later.txt');
    await suggest(w, failing.id, [{ finding: 'F1', requirement: 'R1' }]);
    await remediation.confirmAllSuggestionsFor(w.userId, failing.id);
    expect((await remediation.applyVerificationFor(w.userId, failing.id)).verified).toBe(0);
    expect(await reqRow(w.req.guest)).toEqual({ work_state: 'verified', evidence_report_id: report.id });
    const view = await getRequirementsViewFor(w.userId, w.sessionId);
    const byId = new Map(view!.requirements.map((r) => [r.id, r]));
    expect(byId.get(w.req.guest)!.failingInLatest).toEqual({ reportId: failing.id, label: 'later.txt · cycle 1' });
    expect(byId.get(w.req.firewall)!.failingInLatest).toBeNull();
    expect(byId.get(w.req.guest)!.evidenceLabel).toBe('leads.txt · cycle 1');
  });

  it('counts requirements that cannot transition, with reasons', async () => {
    const w = await world();
    await sql`update public.requirements set disruptive = true where id = ${w.req.firewall}`;
    const report = await addReport(w, ['[+] Guest disabled', '[+] Firewall on', '[+] Updates on'].join('\n'));
    await suggest(w, report.id, [{ finding: 'F1', requirement: 'R1' }, { finding: 'F2', requirement: 'R2' }, { finding: 'F3', requirement: 'R3' }]);
    await remediation.confirmAllSuggestionsFor(w.userId, report.id);
    const out = await remediation.applyVerificationFor(w.userId, report.id);
    expect(out.verified).toBe(1);
    expect(out.skipped.map((s) => [s.requirementId, s.reason])).toEqual([
      [w.req.firewall, 'needs_review'],
      [w.req.updates, 'not_covered'],
    ]);
    expect(out.messages).toEqual([
      "1 requirement couldn't be verified: potentially disruptive and not reviewed yet",
      "1 requirement couldn't be verified: not covered by the current script",
    ]);
  });

  it('refuses a completed session', async () => {
    const w = await world();
    const report = await addReport(w);
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${w.sessionId}`;
    await expect(remediation.applyVerificationFor(w.userId, report.id)).rejects.toBeInstanceOf(remediation.SessionReadOnlyError);
  });
});

describe('decideCycle', () => {
  it('Mark complete needs check_points Complete and Verified; then closes the cycle and starts submit_final', async () => {
    const w = await world();
    await addReport(w);
    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'complete' })).rejects.toThrow('Mark “Check final points” Complete and Verified first');
    expect(await sql`select 1 from public.remediation_cycles where session_id = ${w.sessionId}`).toHaveLength(0);

    await sql`insert into public.evidence (owner_id, session_id, step, kind, note) values (${w.userId}, ${w.sessionId}, 'check_points', 'verification', '100 points')`;
    await flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'check_points', status: 'verified' });
    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'complete' });
    expect(await sql`select cycle_no, outcome from public.remediation_cycles where session_id = ${w.sessionId}`).toEqual([{ cycle_no: 1, outcome: 'completed' }]);
    expect(await stepStatus(w.sessionId, 'submit_final')).toBe('in_progress');
    expect((await sql`select current_cycle from public.sessions where id = ${w.sessionId}`)[0]!.current_cycle).toBe(1);
    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'complete' })).rejects.toThrow('This audit is marked complete');
    const data = await flowchart.getFlowchartDataFor(w.userId, w.sessionId);
    expect(data!.decision).toEqual({
      complete: { enabled: false, reason: 'This audit is marked complete' },
      continue: { enabled: false, reason: 'This audit is marked complete' },
    });
  });

  it('Mark complete is final: Start another cycle and new remediations are refused; the outcome stays completed', async () => {
    const w = await world();
    const report = await addReport(w);
    await sql`insert into public.evidence (owner_id, session_id, step, kind, note) values (${w.userId}, ${w.sessionId}, 'check_points', 'verification', '100 points')`;
    await flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'check_points', status: 'verified' });
    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'complete' });
    const eventsBefore = await sql`select id from public.workflow_step_events where session_id = ${w.sessionId}`;

    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' })).rejects.toThrow('This audit is marked complete');
    await expect(remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: report.id })).rejects.toThrow('This audit is marked complete');
    expect(mock.requests()).toHaveLength(0);
    expect(await sql`select cycle_no, outcome from public.remediation_cycles where session_id = ${w.sessionId}`).toEqual([{ cycle_no: 1, outcome: 'completed' }]);
    expect((await sql`select current_cycle from public.sessions where id = ${w.sessionId}`)[0]!.current_cycle).toBe(1);
    expect(await stepStatus(w.sessionId, 'submit_final')).toBe('in_progress');
    expect(await stepStatus(w.sessionId, 'run_leads')).toBe('in_progress');
    expect(await sql`select id from public.workflow_step_events where session_id = ${w.sessionId}`).toHaveLength(eventsBefore.length);
    // submit_final moved only through the complete path (one event, cycle 1).
    expect(await sql`select from_status, to_status, cycle_no from public.workflow_step_events where session_id = ${w.sessionId} and step = 'submit_final'`).toEqual([
      { from_status: 'not_started', to_status: 'in_progress', cycle_no: 1 },
    ]);
    const detail = await getReportDetailFor(w.userId, w.sessionId, report.id);
    expect(detail).toMatchObject({ currentCycle: 1, cycleOutcome: 'completed' });
  });

  it('a cycle marked complete while Claude writes a remediation refuses it under the session lock', async () => {
    const w = await world();
    const report = await addReport(w);
    await sql`insert into public.evidence (owner_id, session_id, step, kind, note) values (${w.userId}, ${w.sessionId}, 'check_points', 'verification', '100 points')`;
    await flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'check_points', status: 'verified' });
    mock.enqueue({ ...remediationAnswer(), initialDelayMs: 400 });
    const pending = remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: report.id });
    await waitForClaude();
    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'complete' });
    await expect(pending).rejects.toThrow('This audit is marked complete');
    expect(await sql`select 1 from public.proposals where session_id = ${w.sessionId}`).toHaveLength(0);
    expect(await sql`select outcome from public.remediation_cycles where session_id = ${w.sessionId}`).toEqual([{ outcome: 'completed' }]);
  });

  it('Start another cycle needs a LEADS report in the current cycle', async () => {
    const w = await world();
    const data = await flowchart.getFlowchartDataFor(w.userId, w.sessionId);
    expect(data!.decision.continue).toEqual({ enabled: false, reason: 'Upload a LEADS report for cycle 1 first' });
    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' })).rejects.toThrow('Upload a LEADS report for cycle 1 first');
    await addReport(w);
    expect((await flowchart.getFlowchartDataFor(w.userId, w.sessionId))!.decision.continue).toEqual({ enabled: true });
    await cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' });
    // Cycle 2 has no report yet.
    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' })).rejects.toThrow('Upload a LEADS report for cycle 2 first');
  });

  it('refuses a completed or foreign session and an invalid decision', async () => {
    const w = await world();
    await addReport(w);
    const intruder = await createTestUser();
    await expect(cycles.decideCycleFor(intruder.id, { sessionId: w.sessionId, decision: 'continue' })).rejects.toBeInstanceOf(cycles.CycleDecisionError);
    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'restart' as never })).rejects.toBeInstanceOf(cycles.CycleDecisionError);
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${w.sessionId}`;
    await expect(cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' })).rejects.toThrow('This session is completed and read-only');
  });

  it('concurrent "Start another cycle" requests advance exactly one cycle', async () => {
    const w = await world();
    await addReport(w);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toContain('Upload a LEADS report for cycle 2 first');
    expect((await sql`select current_cycle from public.sessions where id = ${w.sessionId}`)[0]!.current_cycle).toBe(2);
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${w.sessionId} and cycle_no = 2 and step = 'run_leads'`).toHaveLength(1);
  });

  it('never deadlocks with concurrent step changes, report uploads, proposals and accepts (lock order)', async () => {
    const w = await world();
    const report = await addReport(w);
    const { proposal } = await propose(w, report.id);
    mock.enqueue({ ...remediationAnswer(), times: 3 });
    const ops = [
      cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' }),
      flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'run_leads', status: 'blocked' }),
      flowchart.changeStepStatusFor(w.userId, { sessionId: w.sessionId, step: 'check_points', status: 'in_progress' }),
      recordLeadsReportFor(w.userId, { sessionId: w.sessionId, file: { bytes: enc(FAILING_REPORT), filename: 'c.txt' } }),
      proposals.acceptProposalFor(w.userId, { proposalId: proposal.id, acknowledgedFlagIds: proposal.flags.map((f: HighImpactFlag) => f.id) }),
      remediation.proposeRemediationFor(w.userId, { sessionId: w.sessionId, reportId: report.id }),
      cycles.decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' }),
    ];
    const results = await Promise.allSettled(ops);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect((r.reason as { code?: string }).code).not.toBe('40P01');
        // Whichever order the session lock gives: a second continue needs a new report; after a continue,
        // the cycle-1 report and proposal belong to an earlier cycle; a newer proposal supersedes the old one.
        expect(String(r.reason)).toMatch(/Upload a LEADS report for cycle|This report is from cycle 1|proposed for cycle 1|already rejected/);
      }
    }
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(4);
  });
});
