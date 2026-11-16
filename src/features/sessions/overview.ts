import 'server-only';
import { withUser } from '@/server/db/withUser';
import type { OsType, StepKey } from '@/lib/types';
import { EVIDENCE_KIND_LABEL, storedFilename, type EvidenceKind } from './completeRules';
import { sessionHref } from './tabLink';

/**
 * Data of the Sessions & Reports page: every session of the user (newest first) with, per audit
 * cycle, its reports, remediation proposal/script, reported points, outcome and evidence, as one
 * timeline ordered by time. Read-only; works the same for completed sessions.
 */

export type TimelineItem =
  | { kind: 'report'; at: string; label: string; detail: string | null; href: string }
  | { kind: 'remediation'; at: string; label: string; detail: string; href: string }
  | { kind: 'evidence'; at: string; label: string; detail: string | null; step: StepKey; evidenceId: string; filename: string | null };

export type CycleOverview = {
  cycleNo: number;
  outcome: 'open' | 'completed' | 'continued';
  points: number | null;
  targetPoints: number | null;
  /** Oldest first. */
  timeline: TimelineItem[];
};

export type SessionOverview = {
  id: string;
  title: string;
  os: OsType;
  status: 'active' | 'completed';
  currentCycle: number;
  createdAt: string;
  completedAt: string | null;
  href: string;
  cycles: CycleOverview[];
};

const SESSION_LIMIT = 200;
const iso = (d: Date) => d.toISOString();
const num = (v: string | null) => (v === null ? null : Number(v));

export function getSessionsOverviewFor(userId: string): Promise<SessionOverview[]> {
  return withUser(userId, async (tx) => {
    const sessions = await tx<{ id: string; title: string; os: OsType; status: 'active' | 'completed'; current_cycle: number; created_at: Date; completed_at: Date | null }[]>`
      select id, title, os, status, current_cycle, created_at, completed_at from public.sessions
      order by created_at desc, id desc limit ${SESSION_LIMIT}`;
    if (sessions.length === 0) return [];
    const ids = sessions.map((s) => s.id);

    const reports = await tx<{ id: string; session_id: string; cycle_no: number; filename: string; created_at: Date; score: string | null }[]>`
      select id, session_id, cycle_no, filename, created_at, score from public.leads_reports where session_id in ${tx(ids)}`;
    const proposals = await tx<{ id: string; session_id: string; cycle_no: number | null; status: string; created_at: Date; summary: string | null; script_id: string | null; script_name: string | null; filename: string | null }[]>`
      select p.id, p.session_id, p.cycle_no, p.status, p.created_at, p.summary, s.id as script_id, s.name as script_name, s.filename
      from public.proposals p
      left join public.script_versions v on v.id = p.result_version_id
      left join public.scripts s on s.id = v.script_id
      where p.session_id in ${tx(ids)} and p.kind = 'remediation' and p.status <> 'rejected'`;
    const cycles = await tx<{ session_id: string; cycle_no: number; outcome: 'open' | 'completed' | 'continued'; points: string | null; target_points: string | null }[]>`
      select session_id, cycle_no, outcome, points, target_points from public.remediation_cycles where session_id in ${tx(ids)}`;
    const evidence = await tx<{ id: string; session_id: string; step: StepKey; kind: EvidenceKind; cycle_no: number; note: string | null; storage_path: string | null; created_at: Date; script_name: string | null; version_no: number | null }[]>`
      select e.id, e.session_id, e.step, e.kind, e.cycle_no, e.note, e.storage_path, e.created_at, s.name as script_name, v.version_no
      from public.evidence e
      left join public.script_versions v on v.id = e.script_version_id
      left join public.scripts s on s.id = v.script_id
      where e.session_id in ${tx(ids)}`;

    return sessions.map((s): SessionOverview => {
      const byCycle = new Map<number, CycleOverview>();
      const cycle = (n: number) => {
        let c = byCycle.get(n);
        if (!c) byCycle.set(n, (c = { cycleNo: n, outcome: 'open', points: null, targetPoints: null, timeline: [] }));
        return c;
      };
      for (let n = 1; n <= s.current_cycle; n++) cycle(n);
      for (const c of cycles) {
        if (c.session_id !== s.id) continue;
        Object.assign(cycle(c.cycle_no), { outcome: c.outcome, points: num(c.points), targetPoints: num(c.target_points) });
      }
      for (const r of reports) {
        if (r.session_id !== s.id) continue;
        cycle(r.cycle_no).timeline.push({
          kind: 'report',
          at: iso(r.created_at),
          label: r.filename,
          detail: r.score === null ? null : `Score ${Number(r.score)}`,
          href: sessionHref(s.id, { tab: 'report', id: r.id, name: r.filename }),
        });
      }
      for (const p of proposals) {
        if (p.session_id !== s.id) continue;
        const accepted = p.status === 'accepted' && p.script_id;
        const title = p.script_name ?? `Remediation — Cycle ${p.cycle_no ?? s.current_cycle}`;
        cycle(p.cycle_no ?? s.current_cycle).timeline.push({
          kind: 'remediation',
          at: iso(p.created_at),
          label: title,
          detail: accepted ? `Accepted as ${p.filename}` : 'Proposal pending review',
          href: accepted ? sessionHref(s.id, { tab: 'script', id: p.script_id!, name: p.filename ?? title }) : sessionHref(s.id, { tab: 'proposal', id: p.id, name: title }),
        });
      }
      for (const e of evidence) {
        if (e.session_id !== s.id) continue;
        cycle(e.cycle_no).timeline.push({
          kind: 'evidence',
          at: iso(e.created_at),
          label: EVIDENCE_KIND_LABEL[e.kind] ?? e.kind,
          detail: [e.script_name && e.version_no ? `Output of ${e.script_name} · v${e.version_no}` : null, e.note].filter(Boolean).join(' · ') || null,
          step: e.step,
          evidenceId: e.id,
          filename: storedFilename(e.storage_path),
        });
      }
      const ordered = [...byCycle.values()].sort((a, b) => a.cycleNo - b.cycleNo);
      for (const c of ordered) c.timeline.sort((a, b) => a.at.localeCompare(b.at));
      return {
        id: s.id,
        title: s.title,
        os: s.os,
        status: s.status,
        currentCycle: s.current_cycle,
        createdAt: iso(s.created_at),
        completedAt: s.completed_at ? iso(s.completed_at) : null,
        href: sessionHref(s.id),
        cycles: ordered,
      };
    });
  });
}
