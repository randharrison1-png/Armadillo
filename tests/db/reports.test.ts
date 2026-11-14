import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const storeDir = mkdtempSync(path.join(tmpdir(), 'armadillo-reports-'));
process.env.LOCAL_FILE_STORE_DIR = storeDir;

const { recordLeadsReportFor, getReportsOverviewFor, getReportDetailFor, getReportRawLinesFor, SessionReadOnlyError, NotFoundError, ReportInputError } = await import(
  '@/features/reports/service'
);
const { recordUploadedLeadsReport, uploadLeadsReport } = await import('@/features/reports/actions');
const { LocalFileStore } = await import('@/server/files/storage');

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'leads');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIX, name)));
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

async function fresh() {
  current = await createTestUser();
  return createSessionFor(current.id, { title: 'Reports', os: 'windows' });
}
const step = async (sessionId: string) =>
  (await sql`select status from public.workflow_steps where session_id = ${sessionId} and step = 'run_leads'`)[0]!.status as string;
const events = (sessionId: string) => sql`select from_status, to_status, cycle_no from public.workflow_step_events where session_id = ${sessionId} and step = 'run_leads' order by created_at`;

describe('recordLeadsReportFor', () => {
  it('stores raw text, parser, score and findings; logs counts only', async () => {
    const s = await fresh();
    const r = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: fixture('plain-markers.txt'), filename: 'plain-markers.txt', storagePath: `${current.id}/${s.id}/x-plain-markers.txt` } });
    expect(r).toMatchObject({ session_id: s.id, owner_id: current.id, cycle_no: 1, filename: 'plain-markers.txt', parser: 'generic', score: '84' });
    expect(r.raw_text).toContain('[-] Remote Desktop is enabled');
    expect(r.parsed).toMatchObject({ parser: 'generic', score: 84, scoreMax: 100, findingCount: 6, truncated: false, parseError: null });
    const f = await sql`select title, status, raw_line from public.leads_findings where report_id = ${r.id} order by raw_line`;
    expect(f).toHaveLength(6);
    expect(f[1]).toMatchObject({ status: 'fail', raw_line: 6 });
    const act = await sql`select meta from public.activity_log where session_id = ${s.id} and action = 'leads_report.add'`;
    expect(act).toHaveLength(1);
    expect(act[0]!.meta).toMatchObject({ cycle: 1, parser: 'generic', findings: 6, hasScore: true });
    expect(JSON.stringify(act[0]!.meta)).not.toMatch(/plain-markers|Remote Desktop/);
  });

  it('assigns cycle_no = the session current_cycle', async () => {
    const s = await fresh();
    const a = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] ok one'), filename: 'a.txt' } });
    await sql`update public.sessions set current_cycle = 3 where id = ${s.id}`;
    const b = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] ok two'), filename: 'b.txt' } });
    expect([a.cycle_no, b.cycle_no]).toEqual([1, 3]);
    const overview = await getReportsOverviewFor(current.id, s.id);
    expect(overview!.currentCycle).toBe(3);
    expect(overview!.reports.map((x) => [x.filename, x.cycleNo])).toEqual([['b.txt', 3], ['a.txt', 1]]);
  });

  it('moves run_leads not_started -> in_progress once, in the same transaction', async () => {
    const s = await fresh();
    expect(await step(s.id)).toBe('not_started');
    await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] a'), filename: 'a.txt' } });
    expect(await step(s.id)).toBe('in_progress');
    await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] b'), filename: 'b.txt' } });
    expect(await events(s.id)).toEqual([{ from_status: 'not_started', to_status: 'in_progress', cycle_no: 1 }]);
  });

  it.each(['verified', 'blocked'])('never regresses a %s run_leads step', async (status) => {
    const s = await fresh();
    await sql`update public.workflow_steps set status = ${status}::public.step_status where session_id = ${s.id} and step = 'run_leads'`;
    await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] a'), filename: 'a.txt' } });
    expect(await step(s.id)).toBe(status);
    expect(await events(s.id)).toEqual([]);
  });

  it('rolls everything back when the step change fails', async () => {
    const s = await fresh();
    await sql.unsafe(`create or replace function public.test_fail_leads_step() returns trigger language plpgsql as $$ begin raise exception 'forced step failure'; end $$`);
    await sql.unsafe(`create trigger test_fail_leads_step before insert on public.workflow_step_events for each row execute function public.test_fail_leads_step()`);
    try {
      await expect(recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] a'), filename: 'a.txt' } })).rejects.toThrow(/forced step failure/);
    } finally {
      await sql.unsafe('drop trigger test_fail_leads_step on public.workflow_step_events');
      await sql.unsafe('drop function public.test_fail_leads_step()');
    }
    expect(await sql`select 1 from public.leads_reports where session_id = ${s.id}`).toHaveLength(0);
    expect(await sql`select 1 from public.leads_findings where owner_id = ${current.id}`).toHaveLength(0);
    expect(await step(s.id)).toBe('not_started');
  });

  it('refuses a completed session and a foreign or malformed session', async () => {
    const s = await fresh();
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${s.id}`;
    await expect(recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[+] a'), filename: 'a.txt' } })).rejects.toBeInstanceOf(SessionReadOnlyError);
    expect(await sql`select 1 from public.leads_reports where session_id = ${s.id}`).toHaveLength(0);

    const mine = await fresh();
    const intruder = await createTestUser();
    await expect(recordLeadsReportFor(intruder.id, { sessionId: mine.id, file: { bytes: enc('[+] a'), filename: 'a.txt' } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordLeadsReportFor(current.id, { sessionId: 'not-a-uuid', file: { bytes: enc('[+] a'), filename: 'a.txt' } })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects empty text, unsupported types and a PDF with no text', async () => {
    const s = await fresh();
    await expect(recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('  \n '), filename: 'a.txt' } })).rejects.toBeInstanceOf(ReportInputError);
    await expect(recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('x'), filename: 'a.exe' } })).rejects.toThrow(/not supported|Unsupported|allowed/i);
  });

  it('keeps an unparseable report as raw text (parser raw, no findings)', async () => {
    const s = await fresh();
    const r = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: fixture('unknown-format.txt'), filename: 'unknown-format.txt' } });
    expect(r).toMatchObject({ parser: 'raw', score: null });
    expect(r.raw_text).toContain('nobody has documented');
    expect(await sql`select 1 from public.leads_findings where report_id = ${r.id}`).toHaveLength(0);
    expect(await step(s.id)).toBe('in_progress');
  });

  it('is idempotent for a replayed storagePath', async () => {
    const s = await fresh();
    const file = { bytes: enc('[+] a'), filename: 'a.txt', storagePath: `${current.id}/${s.id}/same-a.txt` };
    const a = await recordLeadsReportFor(current.id, { sessionId: s.id, file });
    const b = await recordLeadsReportFor(current.id, { sessionId: s.id, file });
    expect(b.id).toBe(a.id);
    expect(await sql`select 1 from public.leads_reports where session_id = ${s.id}`).toHaveLength(1);
  });

  it('stores HTML as converted text and JSON pretty-printed, with findings', async () => {
    const s = await fresh();
    const h = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: fixture('report.html'), filename: 'report.html' } });
    expect(h.raw_text).not.toMatch(/<|pwned/);
    expect(h).toMatchObject({ parser: 'generic', score: '67' });
    const j = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: fixture('findings.json'), filename: 'findings.json' } });
    expect(j.parser).toBe('json');
    expect((await sql`select 1 from public.leads_findings where report_id = ${j.id}`)).toHaveLength(3);
  });

  it('stores unlocated JSON items with a null line (0 in the column)', async () => {
    const s = await fresh();
    const r = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc('[{"title":"A","status":"pass"}]'), filename: 'min.txt' } });
    expect(r.parser).toBe('json');
    const d = await getReportDetailFor(current.id, s.id, r.id);
    expect(d!.findings.map((f) => f.rawLine)).toEqual([null]);
  });

  it('stores up to 5,000 findings from a big report', async () => {
    const s = await fresh();
    const big = Array.from({ length: 6000 }, (_, i) => `[-] finding ${i}`).join('\n');
    const r = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc(big), filename: 'big.log' } });
    expect(r.parsed).toMatchObject({ findingCount: 5000, truncated: true });
    expect(await sql`select 1 from public.leads_findings where report_id = ${r.id}`).toHaveLength(5000);
  });
});

describe('lock order', () => {
  it('concurrent uploads and step changes on one session do not deadlock', async () => {
    const s = await fresh();
    const { setStepStatus } = await import('@/features/flowchart/steps');
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: enc(`[+] c${i}`), filename: `c${i}.txt` } }));
      jobs.push(setStepStatus({ sessionId: s.id, step: 'run_leads', status: i % 2 ? 'blocked' : 'in_progress' }));
    }
    await expect(Promise.all(jobs)).resolves.toBeDefined();
    expect(await sql`select 1 from public.leads_reports where session_id = ${s.id}`).toHaveLength(6);
  });
});

describe('report queries', () => {
  it('returns counts, details and raw line pages, scoped to the owner', async () => {
    const s = await fresh();
    const r = await recordLeadsReportFor(current.id, { sessionId: s.id, file: { bytes: fixture('plain-markers.txt'), filename: 'plain-markers.txt' } });
    const overview = await getReportsOverviewFor(current.id, s.id);
    expect(overview!.reports[0]).toMatchObject({ id: r.id, score: 84, scoreMax: 100, counts: { pass: 3, fail: 2, unknown: 1 } });
    const detail = await getReportDetailFor(current.id, s.id, r.id);
    expect(detail!.findings).toHaveLength(6);
    expect(detail!.report).toMatchObject({ parser: 'generic', lineCount: 13 });
    const page = await getReportRawLinesFor(current.id, s.id, r.id, 4, 3);
    expect(page).toEqual({ lines: ['[+] Guest account is disabled', '[-] Password history is not enforced (remembered passwords: 0)', '[+] Windows Firewall enabled for all profiles'], total: 13 });

    const other = await createTestUser();
    expect(await getReportsOverviewFor(other.id, s.id)).toBeNull();
    expect(await getReportDetailFor(other.id, s.id, r.id)).toBeNull();
    expect(await getReportRawLinesFor(other.id, s.id, r.id, 0, 10)).toBeNull();
    const s2 = await createSessionFor(current.id, { title: 'Other', os: 'linux' });
    expect(await getReportDetailFor(current.id, s2.id, r.id)).toBeNull();
  });
});

describe('recordUploadedLeadsReport (action)', () => {
  const put = async (relative: string, bytes: Uint8Array) => {
    await new LocalFileStore(storeDir).put(relative, bytes, 'text/plain');
    return relative;
  };

  it('records an uploaded object under the user and session prefix', async () => {
    const s = await fresh();
    const p = await put(`${current.id}/${s.id}/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}-lab-report.txt`, fixture('sectioned.txt'));
    const res = await recordUploadedLeadsReport({ sessionId: s.id, storagePath: p });
    expect(res).toMatchObject({ ok: true, filename: 'lab-report.txt', parser: 'generic', findings: 9 });
    expect(await step(s.id)).toBe('in_progress');
  });

  it("refuses another user's path, another session's segment and traversal", async () => {
    const s = await fresh();
    const s2 = await createSessionFor(current.id, { title: 'Second', os: 'linux' });
    const victim = await createTestUser();
    const uuid = '11111111-1111-1111-1111-111111111111';
    const foreign = await put(`${victim.id}/${s.id}/${uuid}-secret.txt`, enc('[+] stolen'));
    const otherSession = await put(`${current.id}/${s2.id}/${uuid}-mine.txt`, enc('[+] other session'));
    expect(await recordUploadedLeadsReport({ sessionId: s.id, storagePath: foreign })).toMatchObject({ ok: false, error: expect.stringMatching(/does not belong/) });
    expect(await recordUploadedLeadsReport({ sessionId: s.id, storagePath: otherSession })).toMatchObject({ ok: false, error: expect.stringMatching(/does not belong/) });
    expect(await recordUploadedLeadsReport({ sessionId: s.id, storagePath: `${current.id}/${s.id}/../${s2.id}/${uuid}-mine.txt` })).toMatchObject({ ok: false });
    expect(await sql`select 1 from public.leads_reports where session_id in ${sql([s.id, s2.id])}`).toHaveLength(0);
  });

  it('refuses a missing object, a wrong extension and a completed session', async () => {
    const s = await fresh();
    const uuid = '22222222-2222-2222-2222-222222222222';
    expect(await recordUploadedLeadsReport({ sessionId: s.id, storagePath: `${current.id}/${s.id}/${uuid}-gone.txt` })).toMatchObject({ ok: false });
    const exe = await put(`${current.id}/${s.id}/${uuid}-bad.exe`, enc('MZ'));
    expect(await recordUploadedLeadsReport({ sessionId: s.id, storagePath: exe })).toMatchObject({ ok: false });
    const ok = await put(`${current.id}/${s.id}/${uuid}-late.txt`, enc('[+] a'));
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${s.id}`;
    expect(await recordUploadedLeadsReport({ sessionId: s.id, storagePath: ok })).toMatchObject({ ok: false, error: expect.stringMatching(/completed/) });
  });

  it('uploadLeadsReport({ sessionId, file }) stores the file and records the report', async () => {
    const s = await fresh();
    const file = new File([fixture('plain-markers.txt')], 'run 1.txt', { type: 'text/plain' });
    const r = await uploadLeadsReport({ sessionId: s.id, file });
    expect(r).toMatchObject({ cycle_no: 1, parser: 'generic', filename: 'run 1.txt' });
    expect(r.storage_path).toMatch(new RegExp(`^${current.id}/${s.id}/[0-9a-f-]{36}-run_1\\.txt$`));
    expect(await step(s.id)).toBe('in_progress');
  });
});
