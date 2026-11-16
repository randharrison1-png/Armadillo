import 'server-only';
import { withUser } from '@/server/db/withUser';
import type { Session, StepKey, StepStatus } from '@/lib/types';
import { currentStep } from '@/features/flowchart/stepMeta';
import type { CreateSessionInput } from './schema';

export type SessionSummary = Session & { currentStep: StepKey | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Calls the transactional create_session function (session + 9 steps + activity entry). */
export function createSessionFor(userId: string, input: CreateSessionInput): Promise<Session> {
  return withUser(userId, async (tx) => {
    const [row] = await tx<Session[]>`select * from public.create_session(${input.title}, ${input.os}::public.os_type)`;
    return row;
  });
}

/** The user's sessions, most recently updated first, each with its current workflow step. */
export function listSessionsFor(userId: string, limit?: number): Promise<SessionSummary[]> {
  return withUser(userId, async (tx) => {
    const sessions = await tx<Session[]>`
      select * from public.sessions order by updated_at desc, created_at desc
      ${limit === undefined ? tx`` : tx`limit ${limit}`}`;
    if (sessions.length === 0) return [];
    const steps = await tx<{ session_id: string; step: StepKey; status: StepStatus }[]>`
      select session_id, step, status from public.workflow_steps where session_id in ${tx(sessions.map((s) => s.id))}`;
    const by = new Map<string, { step: StepKey; status: StepStatus }[]>();
    for (const s of steps) by.set(s.session_id, [...(by.get(s.session_id) ?? []), s]);
    return sessions.map((s) => ({ ...s, currentStep: currentStep(by.get(s.id) ?? []) }));
  });
}

/** One session if it exists and the user owns it (RLS), else null. A malformed id is null, not an error. */
export function getSessionFor(userId: string, sessionId: string): Promise<SessionSummary | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<Session[]>`select * from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const steps = await tx<{ step: StepKey; status: StepStatus }[]>`
      select step, status from public.workflow_steps where session_id = ${sessionId}`;
    return { ...session, currentStep: currentStep(steps) };
  });
}
