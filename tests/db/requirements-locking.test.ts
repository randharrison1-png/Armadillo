import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';
import { addReadmeFor } from '@/features/readme/service';

const service = await import('@/features/requirements/service');
const { SessionReadOnlyError } = service;

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

async function world() {
  const user = await createTestUser();
  const session = await createSessionFor(user.id, { title: 'Locking', os: 'windows' });
  const readme = await addReadmeFor(user.id, { sessionId: session.id, pasted: 'The guest account must be disabled.' });
  const [req] = await sql<{ id: string }[]>`
    insert into public.requirements (owner_id, session_id, readme_id, text, segment_id, coverage, work_state, disruptive)
    values (${user.id}, ${session.id}, ${readme.id}, 'Disable the guest account', 'p-0-x', 'detected', 'proposed', true)
    returning id`;
  return { userId: user.id, sessionId: session.id, requirementId: req.id };
}

/**
 * Holds the session row the way submitFinal does (FOR UPDATE, then status = 'completed') in an open
 * transaction, starts `write`, and commits only after a pause. With the session locked first (LOCK
 * ORDER), the write waits for the commit and then sees the completed session.
 */
async function raceWithSubmit<T>(sessionId: string, write: () => Promise<T>) {
  const conn = await sql.reserve();
  try {
    await conn`begin`;
    await conn`select 1 from public.sessions where id = ${sessionId} for update`;
    await conn`update public.sessions set status = 'completed', completed_at = now() where id = ${sessionId}`;
    let settled = false;
    const pending = write().then(
      (v) => ((settled = true), { ok: true as const, v }),
      (e: unknown) => ((settled = true), { ok: false as const, e }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const settledBeforeCommit = settled;
    await conn`commit`;
    return { settledBeforeCommit, result: await pending };
  } finally {
    conn.release();
  }
}

describe('requirement writes lock the session row first', () => {
  it('notes: a write racing submitFinal waits, then is refused (nothing lands in the completed session)', async () => {
    const w = await world();
    const { settledBeforeCommit, result } = await raceWithSubmit(w.sessionId, () =>
      service.updateRequirementNotesFor(w.userId, { requirementId: w.requirementId, notes: 'late note' }),
    );
    expect(settledBeforeCommit).toBe(false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.e).toBeInstanceOf(SessionReadOnlyError);
    const [r] = await sql<{ notes: string | null }[]>`select notes from public.requirements where id = ${w.requirementId}`;
    expect(r.notes).toBeNull();
  });

  it('mark reviewed: same', async () => {
    const w = await world();
    const { settledBeforeCommit, result } = await raceWithSubmit(w.sessionId, () => service.markRequirementReviewedFor(w.userId, { requirementId: w.requirementId }));
    expect(settledBeforeCommit).toBe(false);
    expect(!result.ok && result.e).toBeInstanceOf(SessionReadOnlyError);
    const [r] = await sql<{ reviewed_at: Date | null }[]>`select reviewed_at from public.requirements where id = ${w.requirementId}`;
    expect(r.reviewed_at).toBeNull();
  });
});
