// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let user: { id: string; email: string } | null = null;
const streamClaude = vi.fn();
const after = vi.fn();

vi.mock('@/server/auth', () => ({ getCurrentUser: async () => user }));
vi.mock('@/server/claude/client', () => ({ streamClaude: (...a: unknown[]) => streamClaude(...a) }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (...a: unknown[]) => after(...a) }));

const { POST, maxDuration, runtime } = await import('@/app/api/claude/messages/route');

const valid = () => ({ sessionId: randomUUID(), text: 'hello', refs: [{ type: 'readme', id: randomUUID() }], mode: 'general', clientRequestId: randomUUID() });

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://127.0.0.1:3100/api/claude/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  user = { id: randomUUID(), email: 'u@example.test' };
  streamClaude.mockReset();
  after.mockReset();
  streamClaude.mockImplementation((_input: unknown, opts: { waitUntil: (p: Promise<unknown>) => void }) => {
    opts.waitUntil(Promise.resolve());
    return new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n')), c.close()) });
  });
});

describe('POST /api/claude/messages', () => {
  it('route config: node runtime with a 300 s duration', () => {
    expect(runtime).toBe('nodejs');
    expect(maxDuration).toBe(300);
  });

  it('streams SSE with no-store and no proxy buffering, for the signed-in user only', async () => {
    const body = valid();
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(await res.text()).toContain('event: done');
    expect(streamClaude).toHaveBeenCalledWith(expect.objectContaining({ userId: user!.id, sessionId: body.sessionId, text: 'hello', conversationId: null }), expect.anything());
    expect(after).toHaveBeenCalledTimes(1); // the reply is persisted even if the browser goes away
  });

  it('refuses anonymous, cross-origin, non-JSON and invalid requests before streaming', async () => {
    const cases: [NextRequest, number][] = [];
    user = null;
    expect((await POST(req(valid()))).status).toBe(401);
    user = { id: randomUUID(), email: 'u@example.test' };
    cases.push(
      [req(valid(), { origin: 'https://evil.example' }), 403],
      [req(valid(), { 'content-type': 'text/plain' }), 415],
      [req('{not json'), 400],
      [req({ ...valid(), text: '   ' }), 400],
      [req({ ...valid(), text: 'x'.repeat(20_001) }), 400],
      [req({ ...valid(), clientRequestId: 'not-a-uuid' }), 400],
      [req({ ...valid(), refs: [{ type: 'secrets', id: randomUUID() }] }), 400],
      [req({ ...valid(), refs: [{ type: 'readme', id: randomUUID(), extra: 1 }] }), 400],
      [req({ ...valid(), mode: 'admin' }), 400],
    );
    for (const [r, status] of cases) expect((await POST(r)).status).toBe(status);
    expect(streamClaude).not.toHaveBeenCalled();
    const tooLong = await POST(req({ ...valid(), text: 'x'.repeat(20_001) }));
    expect(await tooLong.json()).toMatchObject({ error: 'Messages can be at most 20,000 characters.' });
  });

  it('de-duplicates refs', async () => {
    const id = randomUUID();
    await POST(req({ ...valid(), refs: [{ type: 'readme', id }, { type: 'readme', id }] }));
    expect(streamClaude.mock.calls[0][0].refs).toEqual([{ type: 'readme', id }]);
  });
});
