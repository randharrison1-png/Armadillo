import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/server/auth';
import { streamClaude } from '@/server/claude/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Long replies stream for minutes; the upstream client times out at 270 s.
export const maxDuration = 300;

const MAX_BODY_BYTES = 256 * 1024;

const bodySchema = z.object({
  conversationId: z.uuid().nullish(),
  sessionId: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine((t) => t.trim().length > 0, 'Message is empty'),
  refs: z
    .array(z.object({ type: z.enum(['readme', 'script_version', 'leads_report', 'evidence']), id: z.uuid() }).strict())
    .max(50)
    .default([]),
  mode: z.enum(['general', 'adaptation', 'remediation']).default('general'),
  clientRequestId: z.uuid(),
});

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin non-browser clients; the session cookie is still required
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim().toLowerCase();
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

const json = (status: number, error: string, code: string) => NextResponse.json({ error, code }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/claude/messages — send a chat message and stream Claude's reply as SSE
 * (`event: start|delta|done|error`, see ClaudeStreamEvents). The Claude key never leaves the
 * server. Request errors (auth, origin, body) are JSON with a 4xx status; everything after the
 * stream starts, including upstream failures, is an SSE `error` event.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return json(401, 'Sign in again to use Claude.', 'unauthorized');

  // CSRF: browsers always send Origin on cross-origin POSTs; its host must be this app's (the same
  // check Next applies to server actions). JSON-only bodies also force a CORS preflight for
  // cross-site fetches, which this route never answers.
  if (!sameOrigin(request)) return json(403, 'Cross-origin request refused.', 'forbidden');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json(415, 'Expected application/json.', 'invalid');
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, 'Message is too large.', 'invalid');

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, 'Message is too large.', 'invalid');
    raw = JSON.parse(text);
  } catch {
    return json(400, 'Invalid JSON.', 'invalid');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((i) => i.path[0] === 'text' && i.code === 'too_big');
    return json(400, tooLong ? 'Messages can be at most 20,000 characters.' : 'Invalid message.', 'invalid');
  }
  const body = parsed.data;

  // De-duplicate refs (the same resource selected twice is sent once).
  const seen = new Set<string>();
  const refs = body.refs.filter((r) => {
    const k = `${r.type}:${r.id}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });

  const stream = streamClaude(
    {
      userId: user.id,
      sessionId: body.sessionId,
      conversationId: body.conversationId ?? null,
      text: body.text,
      refs,
      mode: body.mode,
      clientRequestId: body.clientRequestId,
    },
    // Keep the function alive until the reply is persisted, even if the browser disconnects.
    { waitUntil: (task) => after(task) },
  );

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
