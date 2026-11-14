import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current }));

const { addReadmeFor, getReadmeFor, listReadmesFor, NotFoundError, ReadmeInputError, SessionReadOnlyError, MAX_PASTED_BYTES } = await import(
  '@/features/readme/service'
);

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

async function fresh() {
  current = await createTestUser();
  const session = await createSessionFor(current.id, { title: 'Readme', os: 'windows' });
  return session;
}
const stepStatus = async (sessionId: string) =>
  (await sql`select status from public.workflow_steps where session_id = ${sessionId} and step = 'open_readme'`)[0].status as string;

describe('addReadmeFor', () => {
  it('stores pasted text with paragraph segments, logs activity, and moves open_readme to in_progress', async () => {
    const s = await fresh();
    const r = await addReadmeFor(current.id, { sessionId: s.id, pasted: 'First paragraph.\n\nSecond paragraph.\n' });
    expect(r).toMatchObject({ session_id: s.id, owner_id: current.id, source: 'paste', filename: null, storage_path: null, has_text_layer: true });
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({ kind: 'paragraph', index: 0, text: 'First paragraph.' });
    expect(r.segments[0].id).toMatch(/^p-0-[0-9a-f]{8}$/);
    expect(await stepStatus(s.id)).toBe('in_progress');
    const acts = await sql`select action, entity_id from public.activity_log where session_id = ${s.id} and action = 'readme.add'`;
    expect(acts).toEqual([{ action: 'readme.add', entity_id: r.id }]);
  });

  it('commits the README and the open_readme step change together', async () => {
    const s = await fresh();
    const r = await addReadmeFor(current.id, { sessionId: s.id, pasted: 'Atomic.' });
    expect(await stepStatus(s.id)).toBe('in_progress');
    const ev = await sql`select to_status from public.workflow_step_events where session_id = ${s.id} and step = 'open_readme'`;
    expect(ev).toEqual([{ to_status: 'in_progress' }]);
    expect(await sql`select 1 from public.readmes where id = ${r.id}`).toHaveLength(1);
  });

  it('rolls the README back when the step change fails', async () => {
    const s = await fresh();
    await sql.unsafe(`create or replace function public.test_fail_step() returns trigger language plpgsql as $$ begin raise exception 'forced step failure'; end $$`);
    await sql.unsafe(`create trigger test_fail_step before insert on public.workflow_step_events for each row execute function public.test_fail_step()`);
    try {
      await expect(addReadmeFor(current.id, { sessionId: s.id, pasted: 'Will not stick.' })).rejects.toThrow(/forced step failure/);
    } finally {
      await sql.unsafe('drop trigger test_fail_step on public.workflow_step_events');
      await sql.unsafe('drop function public.test_fail_step()');
    }
    expect(await sql`select 1 from public.readmes where session_id = ${s.id}`).toHaveLength(0);
    expect(await sql`select 1 from public.activity_log where session_id = ${s.id} and action = 'readme.add'`).toHaveLength(0);
    expect(await stepStatus(s.id)).toBe('not_started');
  });

  it('gives identical text identical segment ids (paste and upload agree)', async () => {
    const s = await fresh();
    const text = new TextDecoder().decode(fixture('readme.md'));
    const pasted = await addReadmeFor(current.id, { sessionId: s.id, pasted: text });
    const uploaded = await addReadmeFor(current.id, {
      sessionId: s.id,
      file: { bytes: fixture('readme.md'), filename: 'readme.md', storagePath: `${current.id}/${s.id}/x-readme.md` },
    });
    expect(uploaded).toMatchObject({ source: 'upload', filename: 'readme.md', storage_path: `${current.id}/${s.id}/x-readme.md` });
    expect(uploaded.segments.map((x) => x.id)).toEqual(pasted.segments.map((x) => x.id));
  });

  it('stores PDF pages as page segments', async () => {
    const s = await fresh();
    const r = await addReadmeFor(current.id, { sessionId: s.id, file: { bytes: fixture('readme.pdf'), filename: 'readme.pdf' } });
    expect(r.has_text_layer).toBe(true);
    expect(r.segments.map((x) => x.id)).toEqual(['page-1', 'page-2', 'page-3']);
  });

  it('stores a scanned PDF with no text layer and leaves open_readme untouched', async () => {
    const s = await fresh();
    const r = await addReadmeFor(current.id, { sessionId: s.id, file: { bytes: fixture('scanned.pdf'), filename: 'scanned.pdf' } });
    expect(r).toMatchObject({ has_text_layer: false, segments: [], text: '' });
    expect(await stepStatus(s.id)).toBe('not_started');
  });

  it('does not move a step that is already past not_started', async () => {
    const s = await fresh();
    await sql`update public.workflow_steps set status = 'verified' where session_id = ${s.id} and step = 'open_readme'`;
    await addReadmeFor(current.id, { sessionId: s.id, pasted: 'Something.' });
    expect(await stepStatus(s.id)).toBe('verified');
  });

  it('rejects empty and oversized pasted text, and unsupported or unreadable files', async () => {
    const s = await fresh();
    await expect(addReadmeFor(current.id, { sessionId: s.id, pasted: '  \n ' })).rejects.toBeInstanceOf(ReadmeInputError);
    await expect(addReadmeFor(current.id, { sessionId: s.id, pasted: 'a'.repeat(MAX_PASTED_BYTES + 1) })).rejects.toBeInstanceOf(ReadmeInputError);
    await expect(addReadmeFor(current.id, { sessionId: s.id, file: { bytes: fixture('sample.exe'), filename: 'sample.exe' } })).rejects.toThrow(/Unsupported/);
    await expect(addReadmeFor(current.id, { sessionId: s.id, file: { bytes: new Uint8Array([1, 2, 3]), filename: 'bad.pdf' } })).rejects.toThrow(/Could not read/);
    await expect(addReadmeFor(current.id, { sessionId: s.id })).rejects.toBeInstanceOf(ReadmeInputError);
    expect(await sql`select 1 from public.readmes where session_id = ${s.id}`).toHaveLength(0);
  });

  it("refuses another user's session and writes nothing", async () => {
    const s = await fresh();
    const other = await createTestUser();
    await expect(addReadmeFor(other.id, { sessionId: s.id, pasted: 'Intruder.' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addReadmeFor(other.id, { sessionId: 'not-a-uuid', pasted: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    expect(await sql`select 1 from public.readmes where session_id = ${s.id}`).toHaveLength(0);
    expect(await sql`select 1 from public.activity_log where session_id = ${s.id} and action = 'readme.add'`).toHaveLength(0);
  });

  it('refuses a completed session', async () => {
    const s = await fresh();
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${s.id}`;
    await expect(addReadmeFor(current.id, { sessionId: s.id, pasted: 'Late.' })).rejects.toBeInstanceOf(SessionReadOnlyError);
    expect(await sql`select 1 from public.readmes where session_id = ${s.id}`).toHaveLength(0);
  });
});

describe('listReadmesFor / getReadmeFor', () => {
  it('lists newest first, never mutates older rows, and hides other users', async () => {
    const s = await fresh();
    const a = await addReadmeFor(current.id, { sessionId: s.id, pasted: 'Old text.' });
    await new Promise((r) => setTimeout(r, 15));
    const b = await addReadmeFor(current.id, { sessionId: s.id, pasted: 'New text.' });
    const list = await listReadmesFor(current.id, s.id);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(list[0]).not.toHaveProperty('text');
    expect(await getReadmeFor(current.id, a.id)).toMatchObject({ text: 'Old text.', segments: a.segments });
    const other = await createTestUser();
    expect(await listReadmesFor(other.id, s.id)).toEqual([]);
    expect(await getReadmeFor(other.id, a.id)).toBeNull();
    expect(await getReadmeFor(current.id, 'nope')).toBeNull();
  });
});
