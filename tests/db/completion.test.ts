import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { withUser } from '@/server/db/withUser';
import { createSessionFor } from '@/features/sessions/service';
import { insertScriptWithV1 } from '@/features/library/service';
import type { StepKey } from '@/lib/types';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current, getCurrentUser: async () => current }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

process.env.LOCAL_FILE_STORE_DIR = mkdtempSync(path.join(tmpdir(), 'armadillo-completion-'));

const c = await import('@/features/sessions/complete');
const { setStepStatus } = await import('@/features/flowchart/steps');
const { decideCycleFor } = await import('@/features/reports/cycles');
const { getFlowchartDataFor } = await import('@/features/flowchart/service');
const { GET: downloadEvidence } = await import('@/app/api/files/evidence/[evidenceId]/route');

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

const FORENSIC_GATE = 'Answer the open forensic questions or give a reason to submit anyway';

async function world() {
  current = await createTestUser();
  const session = await createSessionFor(current.id, { title: 'Completion', os: 'windows' });
  const script = await withUser(current.id, (tx) =>
    insertScriptWithV1(tx, {
      name: 'Session hardening', filename: 'harden.ps1', category: 'windows', fn: 'session_generated', osCompat: ['windows'],
      content: 'Write-Host v1\r\n', format: { encoding: 'utf-8-bom', lineEnding: 'crlf' }, sessionId: session.id, activity: { action: 'test.seed' },
    }),
  );
  const v1 = script.current_version_id!;
  const [v2row] = await sql<{ id: string }[]>`
    insert into public.script_versions (owner_id, script_id, version_no, content, encoding, line_ending, language, sha256, author)
    values (${current.id}, ${script.id}, 2, 'Write-Host v2', 'utf-8', 'lf', 'powershell', ${'a'.repeat(64)}, 'user') returning id`;
  const v2 = v2row!.id;
  const [readme] = await sql<{ id: string }[]>`
    insert into public.readmes (owner_id, session_id, source, text) values (${current.id}, ${session.id}, 'paste', 'x') returning id`;
  const req = async (text: string, o: { coverage?: string; disruptive?: boolean; reviewed?: boolean; version?: string | null; sessionId?: string; readmeId?: string } = {}) => {
    const [r] = await sql<{ id: string }[]>`
      insert into public.requirements (owner_id, session_id, readme_id, text, segment_id, coverage, disruptive, reviewed_at, script_version_id)
      values (${current.id}, ${o.sessionId ?? session.id}, ${o.readmeId ?? readme!.id}, ${text}, 'p-0-x', ${o.coverage ?? 'covered'}, ${o.disruptive ?? false},
              ${o.reviewed ? sql`now()` : null}, ${o.version === undefined ? v2 : o.version}) returning id`;
    return r!.id;
  };
  const state = async (id: string) => (await sql<{ work_state: string; evidence_report_id: string | null }[]>`select work_state, evidence_report_id from public.requirements where id = ${id}`)[0]!;
  return { userId: current.id, sessionId: session.id, scriptId: script.id, v1, v2, readmeId: readme!.id, req, state };
}
type World = Awaited<ReturnType<typeof world>>;

const stepStatus = async (sessionId: string, step: StepKey) =>
  (await sql<{ status: string }[]>`select status from public.workflow_steps where session_id = ${sessionId} and step = ${step}::public.step_key`)[0]!.status;
const evidenceCount = async (sessionId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from public.evidence where session_id = ${sessionId}`)[0]!.n;
const png = (name = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

describe('evidence is per cycle', () => {
  it('addEvidence records the current cycle and a note-only row has no file', async () => {
    const w = await world();
    const r = await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', note: 'Scoring page shows 100 points' });
    expect(r.evidence).toMatchObject({ step: 'check_points', kind: 'verification', cycle_no: 1, storage_path: null, note: 'Scoring page shows 100 points' });
    await sql`update public.sessions set current_cycle = 2 where id = ${w.sessionId}`;
    const r2 = await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', note: 'Cycle two' });
    expect(r2.evidence.cycle_no).toBe(2);
  });

  it('cycle 1 evidence does not satisfy Complete and Verified in cycle 2; cycle 2 evidence does', async () => {
    const w = await world();
    await c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'ran in cycle 1' });
    await setStepStatus({ sessionId: w.sessionId, step: 'run_hardening', status: 'verified' });
    // Another step with only cycle-1 evidence, then the cycle moves on.
    await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', note: 'cycle 1 score' });
    await sql`update public.sessions set current_cycle = 2 where id = ${w.sessionId}`;
    await expect(setStepStatus({ sessionId: w.sessionId, step: 'check_points', status: 'verified' })).rejects.toThrow(/Attach evidence/);
    await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', note: 'cycle 2 score' });
    await expect(setStepStatus({ sessionId: w.sessionId, step: 'check_points', status: 'verified' })).resolves.toMatchObject({ status: 'verified' });
  });

  it('evidence inserted behind the app\'s back still gets the session cycle (never null)', async () => {
    const w = await world();
    await sql`update public.sessions set current_cycle = 3 where id = ${w.sessionId}`;
    const [e] = await sql`insert into public.evidence (owner_id, session_id, step, kind) values (${w.userId}, ${w.sessionId}, 'run_hardening', 'other') returning cycle_no`;
    expect(e!.cycle_no).toBe(3);
  });
});

describe('addEvidence / recordEvidenceFor', () => {
  it('needs a file or a note', async () => {
    const w = await world();
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening' })).rejects.toThrow('Attach a file or write a note');
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: '   ' })).rejects.toThrow('Attach a file or write a note');
    expect(await evidenceCount(w.sessionId)).toBe(0);
  });

  it('stores an uploaded screenshot: path under the user and session, downloadable by the owner only', async () => {
    const w = await world();
    const r = await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', kind: 'screenshot', file: png() });
    expect(r.evidence.kind).toBe('screenshot');
    expect(r.evidence.storage_path).toMatch(new RegExp(`^${w.userId}/${w.sessionId}/[0-9a-f-]{36}-shot\\.png$`));
    const ok = await downloadEvidence(new Request('http://x'), { params: Promise.resolve({ evidenceId: r.evidence.id }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment; filename="shot\.png"/);
    expect(ok.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const owner = current;
    current = await createTestUser();
    const foreign = await downloadEvidence(new Request('http://x'), { params: Promise.resolve({ evidenceId: r.evidence.id }) });
    expect(foreign.status).toBe(404);
    current = owner;
  });

  it('the download route is 404 for a note-only row, a malformed id and an unknown id', async () => {
    const w = await world();
    const r = await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', note: 'only a note' });
    for (const id of [r.evidence.id, 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const res = await downloadEvidence(new Request('http://x'), { params: Promise.resolve({ evidenceId: id }) });
      expect(res.status).toBe(404);
    }
  });

  it('refuses a file type outside the evidence allowlist', async () => {
    const w = await world();
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', file: new File(['x'], 'tool.exe') })).rejects.toThrow(/Unsupported file type/);
    expect(await evidenceCount(w.sessionId)).toBe(0);
  });

  it('refuses a storage path from another session or another user, and the same path is recorded once', async () => {
    const w = await world();
    const other = await createSessionFor(w.userId, { title: 'Other', os: 'linux' });
    const good = `${w.userId}/${w.sessionId}/${'1'.repeat(8)}-${'2'.repeat(4)}-${'3'.repeat(4)}-${'4'.repeat(4)}-${'5'.repeat(12)}-out.txt`;
    const wrongSession = good.replace(w.sessionId, other.id);
    const wrongUser = good.replace(w.userId, (await createTestUser()).id);
    for (const p of [wrongSession, wrongUser, `${w.userId}/${w.sessionId}/../x.txt`]) {
      await expect(c.recordEvidenceFor(w.userId, { sessionId: w.sessionId, step: 'run_hardening', storagePath: p })).rejects.toThrow(/does not belong to this session/);
    }
    const a = await c.recordEvidenceFor(w.userId, { sessionId: w.sessionId, step: 'run_hardening', storagePath: good });
    const b = await c.recordEvidenceFor(w.userId, { sessionId: w.sessionId, step: 'run_hardening', storagePath: good });
    expect(b.evidence.id).toBe(a.evidence.id);
    expect(await evidenceCount(w.sessionId)).toBe(1);
  });

  it('accepts a session script version and a universal one; refuses another session\'s and unknown versions', async () => {
    const w = await world();
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'ran', scriptVersionId: w.v1 })).resolves.toBeTruthy();
    const universal = await withUser(w.userId, (tx) =>
      insertScriptWithV1(tx, {
        name: 'Universal', filename: 'u.ps1', category: 'windows', fn: 'universal_hardening', osCompat: ['windows'],
        content: 'x', format: { encoding: 'utf-8', lineEnding: 'lf' }, sessionId: undefined, activity: { action: 'test.seed' },
      }),
    );
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'ran', scriptVersionId: universal.current_version_id! })).resolves.toBeTruthy();
    const other = await createSessionFor(w.userId, { title: 'Other', os: 'windows' });
    const foreignScript = await withUser(w.userId, (tx) =>
      insertScriptWithV1(tx, {
        name: 'Other', filename: 'o.ps1', category: 'windows', fn: 'session_generated', osCompat: ['windows'],
        content: 'x', format: { encoding: 'utf-8', lineEnding: 'lf' }, sessionId: other.id, activity: { action: 'test.seed' },
      }),
    );
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'ran', scriptVersionId: foreignScript.current_version_id! })).rejects.toThrow(/does not belong to this session/);
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'ran', scriptVersionId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/does not belong/);
  });

  it('logs the addition (no note text) and defaults the kind by step', async () => {
    const w = await world();
    const a = await c.addEvidence({ sessionId: w.sessionId, step: 'run_remediation', note: 'secret-note-text' });
    const b = await c.addEvidence({ sessionId: w.sessionId, step: 'open_readme', note: 'n' });
    const d = await c.addEvidence({ sessionId: w.sessionId, step: 'submit_final', note: 'n' });
    expect([a.evidence.kind, b.evidence.kind, d.evidence.kind]).toEqual(['execution_output', 'other', 'verification']);
    const log = await sql`select meta from public.activity_log where session_id = ${w.sessionId} and action = 'evidence.add' order by created_at`;
    expect(log).toHaveLength(3);
    expect(log[0]!.meta).toMatchObject({ step: 'run_remediation', kind: 'execution_output', cycle: 1, hasFile: false, hasNote: true });
    expect(JSON.stringify(log)).not.toContain('secret-note-text');
  });

  it("cannot attach to another user's session", async () => {
    const w = await world();
    current = await createTestUser();
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'x' })).rejects.toThrow('Session not found');
    expect(await evidenceCount(w.sessionId)).toBe(0);
  });
});

describe('markReported (execution output → Reported, never Verified)', () => {
  it('moves the version\'s covered requirements proposed → reported when execution output is attached', async () => {
    const w = await world();
    const covered = await w.req('Disable guest');
    const covered2 = await w.req('Disable spooler');
    const missing = await w.req('Updates', { coverage: 'missing' });
    const otherVersion = await w.req('Bound to v1', { version: w.v1 });
    const r = await c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', kind: 'execution_output', note: 'output of v2', scriptVersionId: w.v2 });
    expect(r).toMatchObject({ reported: 2, skipped: 0 });
    expect(await w.state(covered)).toEqual({ work_state: 'reported', evidence_report_id: null });
    expect((await w.state(covered2)).work_state).toBe('reported');
    expect((await w.state(missing)).work_state).toBe('proposed');
    expect((await w.state(otherVersion)).work_state).toBe('proposed');
    const [{ n }] = await sql`select count(*)::int as n from public.requirements where session_id = ${w.sessionId} and work_state = 'verified'`;
    expect(n).toBe(0);
    const log = await sql`select meta from public.activity_log where session_id = ${w.sessionId} and action = 'requirements.report'`;
    expect(log[0]!.meta).toMatchObject({ reported: 2, skipped: 0 });
  });

  it('skips a disruptive requirement the user has not reviewed (and counts it); a reviewed one moves', async () => {
    const w = await world();
    const unreviewed = await w.req('Disable RDP', { disruptive: true });
    const reviewed = await w.req('Reset passwords', { disruptive: true, reviewed: true });
    const plain = await w.req('Plain');
    const r = await c.addEvidence({ sessionId: w.sessionId, step: 'run_remediation', note: 'ran', scriptVersionId: w.v2 });
    expect(r).toMatchObject({ reported: 2, skipped: 1 });
    expect((await w.state(unreviewed)).work_state).toBe('proposed');
    expect((await w.state(reviewed)).work_state).toBe('reported');
    expect((await w.state(plain)).work_state).toBe('reported');
  });

  it('does nothing for other kinds, other steps, no version, or already reported/verified requirements', async () => {
    const w = await world();
    const r1 = await w.req('A');
    await c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', kind: 'screenshot', note: 's', scriptVersionId: w.v2 });
    await c.addEvidence({ sessionId: w.sessionId, step: 'run_leads', kind: 'execution_output', note: 's', scriptVersionId: w.v2 });
    await c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', kind: 'execution_output', note: 'no version' });
    expect((await w.state(r1)).work_state).toBe('proposed');
    const verified = await w.req('Already verified');
    const [rep] = await sql<{ id: string }[]>`insert into public.leads_reports (owner_id, session_id, cycle_no, filename) values (${w.userId}, ${w.sessionId}, 1, 'r.txt') returning id`;
    await sql`update public.requirements set work_state = 'verified', evidence_report_id = ${rep!.id} where id = ${verified}`;
    const res = await c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', kind: 'execution_output', note: 'real', scriptVersionId: w.v2 });
    expect(res.reported).toBe(1);
    expect((await w.state(verified)).work_state).toBe('verified');
  });

  it("leaves another session's requirements alone", async () => {
    const w = await world();
    const other = await createSessionFor(w.userId, { title: 'Other', os: 'windows' });
    const [readme] = await sql<{ id: string }[]>`insert into public.readmes (owner_id, session_id, source, text) values (${w.userId}, ${other.id}, 'paste', 'x') returning id`;
    const foreign = await w.req('Foreign', { sessionId: other.id, readmeId: readme!.id });
    await c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'ran', scriptVersionId: w.v2 });
    expect((await w.state(foreign)).work_state).toBe('proposed');
  });

  it('markReported (brief) returns the count and rolls back with a failing evidence insert', async () => {
    const w = await world();
    await w.req('A');
    await w.req('B');
    expect(await c.markReported({ sessionId: w.sessionId, scriptVersionId: w.v2 })).toBe(2);
    expect(await c.markReported({ sessionId: w.sessionId, scriptVersionId: w.v2 })).toBe(0);
  });
});

describe('recordPoints', () => {
  it('upserts the current cycle row; the target is kept when omitted', async () => {
    const w = await world();
    expect(await c.recordPoints({ sessionId: w.sessionId, score: 84.25, target: 100 })).toEqual({ cycleNo: 1, points: 84.25, target: 100 });
    await c.recordPoints({ sessionId: w.sessionId, score: 90 });
    const rows = await sql`select cycle_no, points, target_points, outcome from public.remediation_cycles where session_id = ${w.sessionId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cycle_no: 1, points: '90', target_points: '100', outcome: 'open' });
    const log = await sql`select meta from public.activity_log where session_id = ${w.sessionId} and action = 'points.record'`;
    expect(log).toHaveLength(2);
  });

  it('validates 0 to 10000 with at most 2 decimals', async () => {
    const w = await world();
    for (const bad of [-1, 10000.01, 1.005, NaN, Infinity]) {
      await expect(c.recordPoints({ sessionId: w.sessionId, score: bad })).rejects.toThrow(/Points must be/);
    }
    await expect(c.recordPoints({ sessionId: w.sessionId, score: 10, target: 20000 })).rejects.toThrow(/target must be/);
    await expect(c.recordPoints({ sessionId: w.sessionId, score: 0 })).resolves.toBeTruthy();
    await expect(c.recordPoints({ sessionId: w.sessionId, score: 10000 })).resolves.toBeTruthy();
  });

  it('later cycles get their own row, and a completed cycle keeps its outcome', async () => {
    const w = await world();
    await c.recordPoints({ sessionId: w.sessionId, score: 50 });
    await c.addEvidence({ sessionId: w.sessionId, step: 'check_points', note: 'x' });
    await setStepStatus({ sessionId: w.sessionId, step: 'check_points', status: 'verified' });
    await decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'complete' });
    await c.recordPoints({ sessionId: w.sessionId, score: 95, target: 100 });
    const [row] = await sql`select outcome, points, target_points from public.remediation_cycles where session_id = ${w.sessionId} and cycle_no = 1`;
    expect(row).toMatchObject({ outcome: 'completed', points: '95', target_points: '100' });
    expect(row!.outcome).toBe('completed');
  });

  it('a cycle that was continued records the next cycle separately', async () => {
    const w = await world();
    await c.recordPoints({ sessionId: w.sessionId, score: 50 });
    await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename) values (${w.userId}, ${w.sessionId}, 1, 'r.txt')`;
    await decideCycleFor(w.userId, { sessionId: w.sessionId, decision: 'continue' });
    await c.recordPoints({ sessionId: w.sessionId, score: 70 });
    const rows = await sql`select cycle_no, points, outcome from public.remediation_cycles where session_id = ${w.sessionId} order by cycle_no`;
    expect(rows.map((r) => [r.cycle_no, r.points, r.outcome])).toEqual([[1, '50', 'continued'], [2, '70', 'open']]);
  });
});

describe('forensic questions', () => {
  it('adds, answers, edits and reopens; counts come from status', async () => {
    const w = await world();
    const q = await c.addForensicQuestion({ sessionId: w.sessionId, prompt: '  What is the hidden user?  ' });
    expect(q).toMatchObject({ prompt: 'What is the hidden user?', status: 'open', answer: null });
    const a = await c.answerForensicQuestion({ id: q.id, answer: 'backdoor' });
    expect(a).toMatchObject({ status: 'answered', answer: 'backdoor' });
    const edited = await c.answerForensicQuestion({ id: q.id, answer: 'backdoor2' });
    expect(edited.answer).toBe('backdoor2');
    const reopened = await c.reopenForensicQuestionFor(w.userId, { id: q.id });
    expect(reopened).toMatchObject({ status: 'open', answer: 'backdoor2' });
    const view = await c.getForensicFor(w.userId, w.sessionId);
    expect(view!.questions).toHaveLength(1);
    const log = await sql`select action from public.activity_log where session_id = ${w.sessionId} and action like 'forensic.%' order by created_at`;
    expect(log.map((l) => l.action)).toEqual(['forensic.add', 'forensic.answer', 'forensic.edit', 'forensic.reopen']);
  });

  it('validates lengths and empties', async () => {
    const w = await world();
    await expect(c.addForensicQuestion({ sessionId: w.sessionId, prompt: '   ' })).rejects.toThrow('Write the question first');
    await expect(c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'x'.repeat(2001) })).rejects.toThrow(/2000/);
    await expect(c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'x'.repeat(2000) })).resolves.toBeTruthy();
    const q = await c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'q' });
    await expect(c.answerForensicQuestion({ id: q.id, answer: ' ' })).rejects.toThrow('Write an answer first');
    await expect(c.answerForensicQuestion({ id: q.id, answer: 'x'.repeat(10001) })).rejects.toThrow(/10000/);
    await expect(c.answerForensicQuestion({ id: q.id, answer: 'x'.repeat(10000) })).resolves.toBeTruthy();
  });

  it("is invisible and read-only to other users", async () => {
    const w = await world();
    const q = await c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'q' });
    current = await createTestUser();
    await expect(c.answerForensicQuestion({ id: q.id, answer: 'a' })).rejects.toThrow('Question not found');
    await expect(c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'q2' })).rejects.toThrow('Session not found');
    expect(await c.getForensicFor(current.id, w.sessionId)).toBeNull();
  });
});

/** Everything submitFinal needs: verification evidence on submit_final; optionally forensic questions. */
async function ready(w: World, forensic: 'none' | 'open' | 'answered' = 'none') {
  if (forensic !== 'none') {
    const q = await c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'Who owns the box?' });
    if (forensic === 'answered') await c.answerForensicQuestion({ id: q.id, answer: 'Nobody' });
  }
  await c.addEvidence({ sessionId: w.sessionId, step: 'submit_final', note: 'Scoreboard screenshot description' });
}
const sessionRow = async (id: string) => (await sql<{ status: string; completed_at: Date | null }[]>`select status, completed_at from public.sessions where id = ${id}`)[0]!;

describe('submitFinal', () => {
  it('is refused while a forensic question is open, with the exact message; nothing changes', async () => {
    const w = await world();
    await ready(w, 'open');
    await expect(c.submitFinal(w.sessionId, {})).rejects.toThrow(FORENSIC_GATE);
    await expect(c.submitFinal(w.sessionId, { overrideForensics: 'too short' })).rejects.toThrow(FORENSIC_GATE); // 9 chars
    expect(await sessionRow(w.sessionId)).toMatchObject({ status: 'active', completed_at: null });
    expect(await stepStatus(w.sessionId, 'submit_final')).toBe('not_started');
  });

  it('with an override note: completes, records the reason in notes, event and activity', async () => {
    const w = await world();
    await ready(w, 'open');
    await setStepStatus({ sessionId: w.sessionId, step: 'submit_final', status: 'in_progress', note: 'my own note' });
    await c.submitFinal(w.sessionId, { overrideForensics: '  Question is moot for this image  ' });
    const s = await sessionRow(w.sessionId);
    expect(s.status).toBe('completed');
    expect(s.completed_at).toBeInstanceOf(Date);
    expect(await stepStatus(w.sessionId, 'submit_final')).toBe('verified');
    const [step] = await sql`select notes from public.workflow_steps where session_id = ${w.sessionId} and step = 'submit_final'`;
    expect(step!.notes).toBe('my own note\nSubmitted with open forensic questions: Question is moot for this image');
    const [ev] = await sql`select note, cycle_no from public.workflow_step_events where session_id = ${w.sessionId} and step = 'submit_final' and to_status = 'verified'`;
    expect(ev).toMatchObject({ note: 'Submitted with open forensic questions: Question is moot for this image', cycle_no: 1 });
    const [log] = await sql`select meta from public.activity_log where session_id = ${w.sessionId} and action = 'session.submit'`;
    expect(log!.meta).toMatchObject({ cycle: 1, openForensicQuestions: 1, override: true, overrideReason: 'Question is moot for this image' });
  });

  it('completes without an override when every question is answered or there are none', async () => {
    for (const mode of ['none', 'answered'] as const) {
      const w = await world();
      await ready(w, mode);
      await c.submitFinal(w.sessionId, { overrideForensics: mode === 'answered' ? 'unneeded reason here' : undefined });
      expect((await sessionRow(w.sessionId)).status).toBe('completed');
      const [log] = await sql`select meta from public.activity_log where session_id = ${w.sessionId} and action = 'session.submit'`;
      expect(log!.meta).toMatchObject({ override: false, openForensicQuestions: 0 });
      const [step] = await sql`select notes from public.workflow_steps where session_id = ${w.sessionId} and step = 'submit_final'`;
      expect(step!.notes).toBeNull();
    }
  });

  it('is refused without verification evidence for Submit final in the current cycle, and rolls back whole', async () => {
    const w = await world();
    await expect(c.submitFinal(w.sessionId, {})).rejects.toThrow('Attach verification evidence to Submit final');
    expect(await sessionRow(w.sessionId)).toMatchObject({ status: 'active', completed_at: null });
    // Evidence of an earlier cycle does not count.
    await c.addEvidence({ sessionId: w.sessionId, step: 'submit_final', note: 'cycle 1' });
    await sql`update public.sessions set current_cycle = 2 where id = ${w.sessionId}`;
    await expect(c.submitFinal(w.sessionId, {})).rejects.toThrow('Attach verification evidence');
    expect(await stepStatus(w.sessionId, 'submit_final')).toBe('not_started');
    const [{ n }] = await sql`select count(*)::int as n from public.activity_log where session_id = ${w.sessionId} and action = 'session.submit'`;
    expect(n).toBe(0);
  });

  it('completes the session LAST: the step event and the log entry precede completed_at; then everything is read-only', async () => {
    const w = await world();
    await ready(w);
    await c.submitFinal(w.sessionId, {});
    const [{ ev, lg, done }] = await sql<{ ev: Date; lg: Date; done: Date }[]>`
      select (select created_at from public.workflow_step_events where session_id = ${w.sessionId} and to_status = 'verified' and step = 'submit_final') as ev,
             (select created_at from public.activity_log where session_id = ${w.sessionId} and action = 'session.submit') as lg,
             (select completed_at from public.sessions where id = ${w.sessionId}) as done`;
    // One transaction: now() is the same instant, but the order of writes is fixed by the statement order.
    expect(ev.getTime()).toBeLessThanOrEqual(done.getTime());
    expect(lg.getTime()).toBeLessThanOrEqual(done.getTime());
    await expect(c.addEvidence({ sessionId: w.sessionId, step: 'run_hardening', note: 'late' })).rejects.toThrow('This session is completed and read-only');
    await expect(c.addForensicQuestion({ sessionId: w.sessionId, prompt: 'late' })).rejects.toThrow('This session is completed and read-only');
    await expect(c.recordPoints({ sessionId: w.sessionId, score: 1 })).rejects.toThrow('This session is completed and read-only');
    await expect(c.submitFinal(w.sessionId, {})).rejects.toThrow('This session is completed and read-only');
    await expect(sql`update public.sessions set status = 'active', completed_at = null where id = ${w.sessionId}`).rejects.toThrow(/read-only/);
  });

  it('a completed session still loads (flowchart data) with its evidence and forensic counts', async () => {
    const w = await world();
    await ready(w, 'answered');
    await c.submitFinal(w.sessionId, {});
    const data = await getFlowchartDataFor(w.userId, w.sessionId);
    expect(data).toMatchObject({ sessionStatus: 'completed', forensic: { total: 1, answered: 1 } });
    expect(data!.completedAt).toBeTruthy();
    expect(data!.evidence.some((e) => e.step === 'submit_final')).toBe(true);
  });

  it("cannot submit another user's session", async () => {
    const w = await world();
    await ready(w);
    current = await createTestUser();
    await expect(c.submitFinal(w.sessionId, {})).rejects.toThrow('Session not found');
    expect((await sessionRow(w.sessionId)).status).toBe('active');
  });
});
