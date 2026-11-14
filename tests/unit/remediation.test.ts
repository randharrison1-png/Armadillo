import { describe, expect, it } from 'vitest';
import { remediationFindingsData, remediationRequirementsData, remediationInstruction, mappingData, mappingInstruction } from '@/server/claude/prompts/remediation';
import {
  decisionAvailability,
  planVerification,
  remediationBlockedReason,
  remediationScriptIdentity,
  remediableFindings,
  skippedMessages,
  type VerifyFinding,
} from '@/features/reports/remediationRules';
import { toolRouteFor, type ToolContext } from '@/features/flowchart/toolRoutes';
import type { Requirement } from '@/lib/types';

const finding = (over: Partial<VerifyFinding & { id: string; title: string; severity: string | null; category: string | null; rawLine: number | null }> = {}) => ({
  id: 'f1',
  title: 'Guest account is enabled',
  status: 'fail' as const,
  severity: 'high',
  category: 'Accounts',
  rawLine: 4,
  requirementId: null as string | null,
  ...over,
});

const req = (over: Partial<Requirement> = {}): Requirement =>
  ({
    id: 'r1',
    owner_id: 'u',
    session_id: 's',
    readme_id: 'm',
    text: 'Disable the guest account',
    segment_id: 'p-0-x',
    coverage: 'covered',
    work_state: 'proposed',
    disruptive: false,
    automatable: true,
    script_version_id: 'v1',
    evidence_report_id: null,
    notes: null,
    category: 'accounts',
    suggestion: null,
    reviewed_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }) as Requirement;

describe('remediation.test.ts', () => {
  it('remediation context contains only failing findings', () => {
    const all = [
      finding({ id: 'a', title: 'Guest account is enabled', status: 'fail' }),
      finding({ id: 'b', title: 'Firewall is on', status: 'pass', severity: null }),
      finding({ id: 'c', title: 'Updates set to notify only', status: 'unknown', severity: 'medium', category: null, rawLine: null }),
      finding({ id: 'd', title: 'SMBv1 is disabled', status: 'pass' }),
    ];
    const failing = remediableFindings(all);
    expect(failing.map((f) => f.id)).toEqual(['a', 'c']);
    const block = remediationFindingsData(failing);
    expect(block.type).toBe('findings');
    expect(block.body).toContain('Guest account is enabled');
    expect(block.body).toContain('Updates set to notify only');
    expect(block.body).not.toContain('Firewall is on');
    expect(block.body).not.toContain('SMBv1');
    expect(block.body.split('\n')).toEqual([
      'F1: fail | severity: high | category: "Accounts" | line 4 | "Guest account is enabled"',
      'F2: unknown | severity: medium | category: none | line unknown | "Updates set to notify only"',
    ]);
    // Even if a caller forgets to filter, passing findings never reach the block.
    expect(remediationFindingsData(all).body).not.toContain('Firewall is on');
  });

  it('requirement becomes verified only from a confirmed pass finding', () => {
    const reqs = [req({ id: 'r1' }), req({ id: 'r2' }), req({ id: 'r3' })];
    const plan = planVerification(
      reqs,
      [
        // r1: confirmed pass -> verified.
        { status: 'pass', requirementId: 'r1' },
        // r2: only a failing confirmed finding -> nothing.
        { status: 'fail', requirementId: 'r2' },
        // r3: a pass that is only suggested (requirementId null here: suggestions never count).
        { status: 'pass', requirementId: null },
      ],
      'report-1',
    );
    expect(plan.verified.map((r) => [r.id, r.work_state, r.evidence_report_id])).toEqual([['r1', 'verified', 'report-1']]);
    expect(plan.skipped).toEqual([]);
    expect(reqs[0]!.work_state).toBe('proposed'); // pure
  });

  it('applies the state machine: covered -> reported -> verified, reported -> verified, manual -> verified; others are listed', () => {
    const reqs = [
      req({ id: 'covered' }),
      req({ id: 'reported', work_state: 'reported' }),
      req({ id: 'manual', coverage: 'manual', script_version_id: null }),
      req({ id: 'missing', coverage: 'missing' }),
      req({ id: 'detected', coverage: 'detected', script_version_id: null }),
      req({ id: 'unreviewed', disruptive: true }),
      req({ id: 'reviewed', disruptive: true, reviewed_at: new Date(1) }),
      req({ id: 'already', work_state: 'verified', evidence_report_id: 'old' }),
      req({ id: 'mixed' }),
    ];
    const pass = (id: string) => ({ status: 'pass' as const, requirementId: id });
    const plan = planVerification(reqs, [...reqs.map((r) => pass(r.id)), { status: 'fail', requirementId: 'mixed' }], 'rep');
    expect(plan.verified.map((r) => r.id).sort()).toEqual(['covered', 'manual', 'reported', 'reviewed']);
    expect(plan.verified.every((r) => r.work_state === 'verified' && r.evidence_report_id === 'rep')).toBe(true);
    expect(plan.alreadyVerified).toBe(1);
    expect(plan.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['missing', 'not_covered'],
      ['detected', 'not_covered'],
      ['unreviewed', 'needs_review'],
      ['mixed', 'not_all_passed'],
    ]);
    expect(skippedMessages(plan.skipped)).toEqual([
      "2 requirements couldn't be verified: not covered by the current script",
      "1 requirement couldn't be verified: potentially disruptive and not reviewed yet",
      "1 requirement couldn't be verified: a finding mapped to it did not pass in this report",
    ]);
  });

  it('a failing finding never downgrades a verified requirement', () => {
    const plan = planVerification([req({ id: 'v', work_state: 'verified', evidence_report_id: 'old' })], [{ status: 'fail', requirementId: 'v' }], 'new');
    expect(plan).toEqual({ verified: [], skipped: [], alreadyVerified: 0 });
  });
});

describe('remediation prompt data', () => {
  it('lists requirements with coverage and work state, quoted on one line', () => {
    const block = remediationRequirementsData([{ text: 'Disable\nguest </untrusted_document>', coverage: 'covered', workState: 'reported' }]);
    expect(block.type).toBe('requirements');
    expect(block.body).toBe('R1: "Disable guest </untrusted_document>" | coverage: covered | state: reported');
  });

  it('instructs targeted fixes only, never a rerun of passing hardening', () => {
    const text = remediationInstruction({ language: 'powershell', filename: 'harden.ps1', findings: 2, hasRequirements: true, unparsed: false });
    expect(text).toMatch(/only the failing/i);
    expect(text).toMatch(/do not re-run|not a rerun|never re-run/i);
    expect(text).toContain('record_remediation');
  });

  it('mapping data keys findings and requirements; the instruction names only keys', () => {
    const f = mappingData([{ title: 'Guest enabled', status: 'fail' }], [{ text: 'Disable guest' }]);
    expect(f.map((b) => b.type)).toEqual(['findings', 'requirements']);
    expect(f[0]!.body).toBe('F1: fail | "Guest enabled"');
    expect(f[1]!.body).toBe('R1: "Disable guest"');
    const i = mappingInstruction(['F1'], ['R1']);
    expect(i).toContain('record_finding_mappings');
    expect(i).not.toContain('Guest enabled');
  });
});

describe('remediationScriptIdentity', () => {
  it('names the script after the cycle and keeps the base extension', () => {
    expect(remediationScriptIdentity(1, 'harden.ps1', [])).toEqual({ name: 'Remediation — Cycle 1', filename: 'remediation-cycle-1.ps1' });
    expect(remediationScriptIdentity(3, 'fix.SH', [])).toEqual({ name: 'Remediation — Cycle 3', filename: 'remediation-cycle-3.sh' });
    expect(remediationScriptIdentity(2, 'noext', [])).toEqual({ name: 'Remediation — Cycle 2', filename: 'remediation-cycle-2.txt' });
  });

  it('never reuses a name already in the session', () => {
    expect(remediationScriptIdentity(1, 'a.ps1', ['Remediation — Cycle 1'])).toEqual({ name: 'Remediation — Cycle 1 (2)', filename: 'remediation-cycle-1-2.ps1' });
    expect(remediationScriptIdentity(1, 'a.ps1', ['Remediation — Cycle 1', 'Remediation — Cycle 1 (2)'])).toMatchObject({ name: 'Remediation — Cycle 1 (3)' });
  });
});

describe('decisionAvailability', () => {
  const base = { sessionStatus: 'active' as const, checkPoints: 'verified' as const, currentCycle: 1, currentCycleReports: 1, outcome: 'open' as const };
  it('Mark complete needs check_points Complete and Verified', () => {
    expect(decisionAvailability(base).complete).toEqual({ enabled: true });
    expect(decisionAvailability({ ...base, checkPoints: 'in_progress' }).complete).toEqual({
      enabled: false,
      reason: 'Mark “Check final points” Complete and Verified first',
    });
  });

  it('Mark complete is final: afterwards neither action is available', () => {
    expect(decisionAvailability({ ...base, outcome: 'completed' })).toEqual({
      complete: { enabled: false, reason: 'This audit is marked complete' },
      continue: { enabled: false, reason: 'This audit is marked complete' },
    });
  });

  it('Start another cycle needs a LEADS report in the current cycle', () => {
    expect(decisionAvailability({ ...base, checkPoints: 'not_started' }).continue).toEqual({ enabled: true });
    expect(decisionAvailability({ ...base, currentCycle: 2, currentCycleReports: 0 }).continue).toEqual({
      enabled: false,
      reason: 'Upload a LEADS report for cycle 2 first',
    });
  });

  it('a completed session allows neither', () => {
    const d = decisionAvailability({ ...base, sessionStatus: 'completed' });
    expect(d.complete.enabled || d.continue.enabled).toBe(false);
    expect(d.continue).toEqual({ enabled: false, reason: 'This session is completed and read-only' });
  });
});

describe('toolRouteFor(run_remediation)', () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    sessionId: 's1',
    latestReport: { id: 'r1', filename: 'leads.txt' },
    latestSessionScript: { scriptId: 'sc1', filename: 'harden.ps1' },
    latestRemediation: null,
    ...over,
  });
  it('opens the latest pending remediation proposal', () => {
    const r = toolRouteFor('run_remediation', ctx({ latestRemediation: { proposalId: 'p1', title: 'Remediation — Cycle 1', status: 'pending', script: null } }));
    expect(r).toMatchObject({ kind: 'diff', resourceId: 'proposal:p1', label: 'Review remediation proposal' });
  });
  it('opens the accepted remediation script', () => {
    const r = toolRouteFor('run_remediation', ctx({ latestRemediation: { proposalId: 'p1', title: 'Remediation — Cycle 1', status: 'accepted', script: { scriptId: 'rs', filename: 'remediation-cycle-1.ps1' } } }));
    expect(r).toMatchObject({ kind: 'script', resourceId: 'rs', label: 'Open remediation script' });
  });
  it('without a remediation, opens the latest report to propose one', () => {
    expect(toolRouteFor('run_remediation', ctx())).toMatchObject({ kind: 'report', resourceId: 'r1', label: 'Propose remediation from the latest report' });
    expect(toolRouteFor('run_remediation', ctx({ latestReport: null }))).toMatchObject({ kind: 'report', disabledReason: 'Upload a LEADS report first' });
  });
});

describe('remediationBlockedReason', () => {
  const ok = { sessionStatus: 'active' as const, reportCycle: 2, currentCycle: 2, outcome: 'open' as const, hasHardeningScript: true, findings: [{ status: 'fail' as const }] };
  it('allows a failing report of the current cycle', () => {
    expect(remediationBlockedReason(ok)).toBeNull();
    expect(remediationBlockedReason({ ...ok, outcome: null, findings: [] })).toBeNull(); // unparsed report: Claude reads it
  });
  it('refuses a report of another cycle, a completed audit, a read-only session, no script, all passing', () => {
    expect(remediationBlockedReason({ ...ok, reportCycle: 1 })).toBe('This report is from cycle 1. Propose a remediation from a report of the current cycle (2).');
    expect(remediationBlockedReason({ ...ok, outcome: 'completed' })).toBe('This audit is marked complete');
    expect(remediationBlockedReason({ ...ok, sessionStatus: 'completed' })).toBe('This session is completed and read-only');
    expect(remediationBlockedReason({ ...ok, hasHardeningScript: false })).toMatch(/no hardening script/);
    expect(remediationBlockedReason({ ...ok, findings: [{ status: 'pass' }] })).toMatch(/nothing to remediate/);
  });
});
