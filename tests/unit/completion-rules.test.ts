import { describe, expect, it } from 'vitest';
import {
  defaultEvidenceKind,
  forensicCountLabel,
  overrideLine,
  reportedMessage,
  storedFilename,
  validPoints,
} from '@/features/sessions/completeRules';
import { tabFromParams } from '@/features/sessions/tabFromLink';
import { sessionHref } from '@/features/sessions/tabLink';

describe('completeRules', () => {
  it('defaults the evidence kind by step', () => {
    expect(defaultEvidenceKind('run_hardening')).toBe('execution_output');
    expect(defaultEvidenceKind('run_remediation')).toBe('execution_output');
    expect(defaultEvidenceKind('check_points')).toBe('verification');
    expect(defaultEvidenceKind('submit_final')).toBe('verification');
    expect(defaultEvidenceKind('open_readme')).toBe('other');
    expect(defaultEvidenceKind('run_leads')).toBe('other');
  });

  it('validates points: 0 to 10000, at most 2 decimals', () => {
    for (const ok of [0, 1, 84.25, 99.99, 10000, 0.1, 1.1, 3.05]) expect(validPoints(ok)).toBe(true);
    for (const bad of [-0.01, 10000.01, 1.005, NaN, Infinity, '5', null, undefined]) expect(validPoints(bad)).toBe(false);
  });

  it('words the counts and the Reported toast', () => {
    expect(forensicCountLabel(5, 2)).toBe('2 of 5 answered');
    expect(forensicCountLabel(0, 0)).toBe('No questions yet');
    expect(reportedMessage(3, 0)).toBe('3 requirements marked Reported');
    expect(reportedMessage(1, 0)).toBe('1 requirement marked Reported');
    expect(reportedMessage(2, 1)).toBe('2 requirements marked Reported; 1 potentially disruptive requirement needs review first');
    expect(reportedMessage(0, 2)).toBe('0 requirements marked Reported; 2 potentially disruptive requirements need review first');
  });

  it('keeps the file name out of a storage path, or null', () => {
    expect(storedFilename(null)).toBeNull();
    expect(storedFilename(`u/s/${'a'.repeat(36)}-shot.png`)).toBe('shot.png');
    expect(overrideLine('moot')).toBe('Submitted with open forensic questions: moot');
  });
});

describe('session deep links', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const params = (href: string) => new URL(href, 'http://x').searchParams;

  it('round-trips each tab link', () => {
    expect(sessionHref(id)).toBe(`/app/sessions/${id}`);
    expect(tabFromParams(params(sessionHref(id, { tab: 'flowchart' })))).toMatchObject({ key: 'flowchart', kind: 'flowchart' });
    expect(tabFromParams(params(sessionHref(id, { tab: 'report', id, name: 'fail.txt' })))).toMatchObject({ key: `report:${id}`, title: 'Report · fail.txt' });
    expect(tabFromParams(params(sessionHref(id, { tab: 'script', id, name: 'r.ps1' })))).toMatchObject({ key: `script:${id}`, kind: 'script' });
    expect(tabFromParams(params(sessionHref(id, { tab: 'proposal', id, name: 'Remediation — Cycle 1' })))).toMatchObject({ key: `diff:proposal:${id}`, kind: 'diff' });
  });

  it('opens nothing for unknown tabs or malformed ids', () => {
    expect(tabFromParams(params('/x?tab=evil'))).toBeNull();
    expect(tabFromParams(params('/x'))).toBeNull();
    expect(tabFromParams(params('/x?tab=report&id=not-a-uuid'))).toBeNull();
  });
});
