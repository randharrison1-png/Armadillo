// Pure step metadata: safe to import from client and server code.
import type { StepKey, StepStatus } from '@/lib/types';

/** Flowchart order (spec 5.3). */
export const STEP_ORDER: readonly StepKey[] = [
  'open_readme',
  'forensic_questions',
  'claude_adaptation',
  'run_hardening',
  'run_leads',
  'inspect_leads',
  'run_remediation',
  'check_points',
  'submit_final',
];

export const STEP_LABEL: Record<StepKey, string> = {
  open_readme: 'Open README',
  forensic_questions: 'Forensic questions',
  claude_adaptation: 'Claude adaptation',
  run_hardening: 'Run hardening script',
  run_leads: 'Run LEADS',
  inspect_leads: 'Inspect LEADS report',
  run_remediation: 'Targeted remediation',
  check_points: 'Check final points',
  submit_final: 'Submit final',
};

/** First step in flowchart order that is not verified; null when all nine are. Missing rows count as not started. */
export function currentStep(steps: readonly { step: StepKey; status: StepStatus }[]): StepKey | null {
  const status = new Map(steps.map((s) => [s.step, s.status]));
  return STEP_ORDER.find((k) => (status.get(k) ?? 'not_started') !== 'verified') ?? null;
}

/** Text for a session's workflow stage. Never claims security beyond what is verified. */
export function stageLabel(sessionStatus: 'active' | 'completed', step: StepKey | null): string {
  if (sessionStatus === 'completed') return 'Completed';
  return step ? STEP_LABEL[step] : 'All steps verified';
}
