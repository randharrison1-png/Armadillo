import { describe, expect, it } from 'vitest';
import { createSessionSchema, OS_LABEL } from '@/features/sessions/schema';
import { currentStep, stageLabel, STEP_LABEL, STEP_ORDER } from '@/features/flowchart/stepMeta';
import type { StepKey, StepStatus } from '@/lib/types';

describe('createSessionSchema', () => {
  it('trims the title and accepts the three supported systems', () => {
    for (const os of ['windows', 'windows_server', 'linux'] as const) {
      expect(createSessionSchema.parse({ title: '  Round 1  ', os })).toEqual({ title: 'Round 1', os });
    }
  });

  it('rejects empty, whitespace-only and over-long titles and unknown systems', () => {
    expect(createSessionSchema.safeParse({ title: '   ', os: 'linux' }).success).toBe(false);
    expect(createSessionSchema.safeParse({ title: 'x'.repeat(121), os: 'linux' }).success).toBe(false);
    expect(createSessionSchema.safeParse({ title: 'x'.repeat(120), os: 'linux' }).success).toBe(true);
    expect(createSessionSchema.safeParse({ title: 'ok', os: 'macos' }).success).toBe(false);
  });

  it('has a label for every OS', () => {
    expect(OS_LABEL).toEqual({ windows: 'Windows', windows_server: 'Windows Server', linux: 'Linux' });
  });
});

const steps = (over: Partial<Record<StepKey, StepStatus>>) =>
  STEP_ORDER.map((step) => ({ step, status: over[step] ?? ('not_started' as StepStatus) }));

describe('current stage', () => {
  it('orders the nine steps as the flowchart does and labels each', () => {
    expect(STEP_ORDER).toEqual([
      'open_readme', 'forensic_questions', 'claude_adaptation', 'run_hardening', 'run_leads',
      'inspect_leads', 'run_remediation', 'check_points', 'submit_final',
    ]);
    expect(STEP_LABEL.run_hardening).toBe('Run hardening script');
    expect(STEP_LABEL.submit_final).toBe('Submit final');
  });

  it('is the first step that is not verified', () => {
    expect(currentStep(steps({}))).toBe('open_readme');
    expect(currentStep(steps({ open_readme: 'verified', forensic_questions: 'in_progress' }))).toBe('forensic_questions');
    // A later verified step does not skip an earlier unfinished one.
    expect(currentStep(steps({ open_readme: 'blocked', forensic_questions: 'verified' }))).toBe('open_readme');
  });

  it('is null when every step is verified, and treats missing rows as not started', () => {
    expect(currentStep(STEP_ORDER.map((step) => ({ step, status: 'verified' as const })))).toBeNull();
    expect(currentStep([])).toBe('open_readme');
  });

  it('labels completed sessions "Completed"', () => {
    expect(stageLabel('completed', null)).toBe('Completed');
    expect(stageLabel('active', 'run_leads')).toBe('Run LEADS');
    expect(stageLabel('active', null)).toBe('All steps verified');
  });
});
