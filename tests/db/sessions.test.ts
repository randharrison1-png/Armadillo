import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAnon, createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor, getSessionFor, listSessionsFor } from '@/features/sessions/service';

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

const STEPS = [
  'open_readme', 'forensic_questions', 'claude_adaptation', 'run_hardening', 'run_leads',
  'inspect_leads', 'run_remediation', 'check_points', 'submit_final',
];

describe('createSession', () => {
  it('createSession creates 9 not_started steps', async () => {
    const user = await createTestUser();
    const s = await createSessionFor(user.id, { title: '  Round 1  ', os: 'windows_server' });
    expect(s).toMatchObject({ title: 'Round 1', os: 'windows_server', status: 'active', current_cycle: 1, owner_id: user.id });
    const rows = await sql`select step, status from public.workflow_steps where session_id = ${s.id}`;
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.step).sort()).toEqual([...STEPS].sort());
    expect(rows.every((r) => r.status === 'not_started')).toBe(true);
  });

  it('createSession does not change script count', async () => {
    const user = await createTestUser();
    const [{ n: before }] = await sql`select count(*)::int as n from public.scripts`;
    await createSessionFor(user.id, { title: 'No scripts', os: 'linux' });
    const [{ n: after }] = await sql`select count(*)::int as n from public.scripts`;
    expect(after).toBe(before);
  });

  it('records one activity entry for the session in the same transaction', async () => {
    const user = await createTestUser();
    const s = await createSessionFor(user.id, { title: 'Logged', os: 'linux' });
    const rows = await sql`select action, entity_type, entity_id, meta from public.activity_log where session_id = ${s.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'session.created', entity_type: 'session', entity_id: s.id });
    expect(rows[0].meta).toMatchObject({ title: 'Logged', os: 'linux' });
  });

  it('is all-or-nothing: an invalid title leaves no session, steps or activity', async () => {
    const user = await createTestUser();
    await expect(createSessionFor(user.id, { title: '   ', os: 'linux' })).rejects.toThrow();
    await expect(createSessionFor(user.id, { title: 'x'.repeat(121), os: 'linux' })).rejects.toThrow();
    const [{ n }] = await sql`select count(*)::int as n from public.sessions where owner_id = ${user.id}`;
    expect(n).toBe(0);
    const [{ a }] = await sql`select count(*)::int as a from public.activity_log where owner_id = ${user.id}`;
    expect(a).toBe(0);
  });

  it('is not callable by anon', async () => {
    await expect(asAnon((tx) => tx`select * from public.create_session('x', 'linux')`)).rejects.toThrow(/permission denied/);
  });
});

describe('listing sessions', () => {
  it('lists only the owner, most recently updated first, with the current stage inputs', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const first = await createSessionFor(a.id, { title: 'First', os: 'linux' });
    const second = await createSessionFor(a.id, { title: 'Second', os: 'windows' });
    await createSessionFor(b.id, { title: 'Other user', os: 'linux' });
    await sql`update public.workflow_steps set status = 'verified' where session_id = ${first.id} and step = 'open_readme'`;
    await sql`update public.sessions set updated_at = now() + interval '1 minute' where id = ${first.id}`;

    const list = await listSessionsFor(a.id, 10);
    expect(list.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(list[0].currentStep).toBe('forensic_questions');
    expect(list[1].currentStep).toBe('open_readme');
    expect((await listSessionsFor(a.id, 1)).map((s) => s.id)).toEqual([first.id]);
  });

  it('getSessionFor returns null for another user, a missing id, or a non-uuid', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const s = await createSessionFor(a.id, { title: 'Mine', os: 'linux' });
    expect((await getSessionFor(a.id, s.id))?.title).toBe('Mine');
    expect(await getSessionFor(b.id, s.id)).toBeNull();
    expect(await getSessionFor(a.id, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await getSessionFor(a.id, 'not-a-uuid')).toBeNull();
  });
});
