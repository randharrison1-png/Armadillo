import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startAnthropicMock, type AnthropicMock } from '../support/anthropic-mock';
import { asAnon, asUser, createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';
import { createSseParser } from '@/lib/sse';

const { streamClaude, callClaudeTool, testClaudeConnection, ClaudeUpstreamError } = await import('@/server/claude/client');
const { CLAUDE_CALL_LIMIT, CLAUDE_TEST_LIMIT } = await import('@/server/claude/budget');
const { ForbiddenError } = await import('@/server/claude/context');

let mock: AnthropicMock;

beforeAll(async () => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
  mock = await startAnthropicMock();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = 'env-test-key-0000';
  process.env.KEY_ENCRYPTION_SECRET = 'db-test-key-encryption-secret-0123456789abcdef';
  process.env.CLAUDE_MAX_RETRIES = '0';
  delete process.env.CLAUDE_MODEL;
});
afterAll(async () => {
  await mock.close();
  await closePool();
  await sql.end();
});
beforeEach(() => mock.reset());

/** Fills the current fixed window of `key` up to `count` hits (as the DB owner, like check_rate_limit). */
async function spend(key: string, count: number, windowSec = 3600) {
  await sql`
    insert into public.rate_limit_hits (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from clock_timestamp()) / ${windowSec}) * ${windowSec}), ${count})
    on conflict (key, window_start) do update set count = excluded.count`;
}
const hits = async (key: string) => {
  const [row] = await sql<{ n: number }[]>`select coalesce(sum(count), 0)::int as n from public.rate_limit_hits where key = ${key}`;
  return row.n;
};

async function chat(userId: string, sessionId: string) {
  const tasks: Promise<unknown>[] = [];
  const stream = streamClaude({ userId, sessionId, clientRequestId: randomUUID(), refs: [], mode: 'general', text: 'Hello' }, { waitUntil: (p) => tasks.push(p) });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const parser = createSseParser((e) => events.push(e as (typeof events)[number]));
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(dec.decode(value, { stream: true }));
  }
  parser.end();
  await Promise.all(tasks);
  return events.at(-1)!;
}

const tool = { name: 'answer', description: 'Carries the answer.', input_schema: { properties: { ok: { type: 'boolean' } }, required: ['ok'] } };

describe('check_rate_limit Claude keys', () => {
  it('accepts claude:/claudetest: keys only for the caller’s own id', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const [own] = await asUser(a.id, (tx) => tx`select ok from public.check_rate_limit(${`claude:${a.id}`}, 60, 3600)`);
    expect(own.ok).toBe(true);
    const [ownTest] = await asUser(a.id, (tx) => tx`select ok from public.check_rate_limit(${`claudetest:${a.id}`}, 10, 3600)`);
    expect(ownTest.ok).toBe(true);
    await expect(asUser(a.id, (tx) => tx`select * from public.check_rate_limit(${`claude:${b.id}`}, 60, 3600)`)).rejects.toMatchObject({ code: '42501' });
    await expect(asUser(a.id, (tx) => tx`select * from public.check_rate_limit(${`claudetest:${b.id}`}, 10, 3600)`)).rejects.toMatchObject({ code: '42501' });
    await expect(asAnon((tx) => tx`select * from public.check_rate_limit(${`claude:${a.id}`}, 60, 3600)`)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Claude budget in the gateway', () => {
  it('limits are 60 calls and 10 connection tests per hour', () => {
    expect(CLAUDE_CALL_LIMIT).toEqual({ limit: 60, windowSec: 3600 });
    expect(CLAUDE_TEST_LIMIT).toEqual({ limit: 10, windowSec: 3600 });
  });

  it('a chat turn counts one hit; an exhausted budget refuses the turn without calling Claude', async () => {
    const u = await createTestUser();
    const s = await createSessionFor(u.id, { title: 'Budget', os: 'windows' });
    mock.enqueue({ chunks: ['Hi'] });
    expect((await chat(u.id, s.id)).event).toBe('done');
    expect(await hits(`claude:${u.id}`)).toBe(1);

    await spend(`claude:${u.id}`, 60);
    mock.reset();
    const last = await chat(u.id, s.id);
    expect(last.event).toBe('error');
    expect(last.data).toMatchObject({ code: 'budget' });
    expect(String(last.data.message)).toMatch(/limit of 60 Claude requests per hour.*Try again in \d+ minutes?\./);
    expect(mock.requests()).toHaveLength(0);
  });

  it('a structured call is refused when the budget is exhausted, with zero API calls', async () => {
    const u = await createTestUser();
    const s = await createSessionFor(u.id, { title: 'Budget tool', os: 'windows' });
    mock.enqueue({ toolUse: { name: 'answer', input: { ok: true } } });
    const ok = await callClaudeTool({ userId: u.id, sessionId: s.id, refs: [], instruction: () => 'Answer.', tool, schema: z.object({ ok: z.boolean() }) });
    expect(ok.data).toEqual({ ok: true });
    expect(await hits(`claude:${u.id}`)).toBe(1);

    await spend(`claude:${u.id}`, 60);
    mock.reset();
    const err = await callClaudeTool({ userId: u.id, sessionId: s.id, refs: [], instruction: () => 'Answer.', tool, schema: z.object({ ok: z.boolean() }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeUpstreamError);
    expect(err).toMatchObject({ code: 'budget', retryable: false });
    expect((err as Error).message).toMatch(/Try again in \d+ minutes?\./);
    expect(mock.requests()).toHaveLength(0);
  });

  it('a call refused by validation (a ref the user does not own) spends no budget', async () => {
    const u = await createTestUser();
    const s = await createSessionFor(u.id, { title: 'Budget forbidden', os: 'windows' });
    const err = await callClaudeTool({
      userId: u.id,
      sessionId: s.id,
      refs: [{ type: 'readme', id: randomUUID() }],
      instruction: () => 'Answer.',
      tool,
      schema: z.object({ ok: z.boolean() }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(await hits(`claude:${u.id}`)).toBe(0);
    expect(mock.requests()).toHaveLength(0);
  });

  it('one user’s exhausted budget does not limit another user', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await spend(`claude:${a.id}`, 60);
    const s = await createSessionFor(b.id, { title: 'Other user', os: 'windows' });
    mock.enqueue({ chunks: ['Hi'] });
    expect((await chat(b.id, s.id)).event).toBe('done');
  });

  it('Test connection has its own 10/hour budget and makes no API call when refused', async () => {
    const u = await createTestUser();
    mock.enqueue({ chunks: ['p'] });
    expect(await testClaudeConnection(u.id)).toMatchObject({ status: 'ok' });
    expect(await hits(`claudetest:${u.id}`)).toBe(1);
    expect(await hits(`claude:${u.id}`)).toBe(0);
    await spend(`claudetest:${u.id}`, 10);
    mock.reset();
    const r = await testClaudeConnection(u.id);
    expect(r).toMatchObject({ status: 'error' });
    expect((r as { message: string }).message).toMatch(/limit of 10 connection tests per hour.*Try again in \d+ minutes?\./);
    expect(mock.requests()).toHaveLength(0);
  });
});
