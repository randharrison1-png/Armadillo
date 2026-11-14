import { describe, expect, it } from 'vitest';
import { coverageFor, resolveAssessments, resolveExtracted } from '@/features/requirements/mapping';
import { countRows, droppedMessage, filterRows, sourceLabel } from '@/features/requirements/matrix';
import type { RequirementRow } from '@/features/requirements/types';

const NONCE = '0123456789abcdef0123';
const item = (segment_id: string, text = 'Disable the guest account') => ({
  text,
  segment_id,
  category: 'accounts' as const,
  automatable: true,
  disruptive: false,
});

describe('extraction: citations', () => {
  it('drops items whose segment_id does not exist and reports count', () => {
    const segments = ['p-0-aaaaaaaa', 'p-1-bbbbbbbb', 'page-3'];
    const { kept, dropped } = resolveExtracted(
      [item('p-0-aaaaaaaa'), item('p-9-nothere'), item('page-3'), item(''), item('PAGE-3'), item('p-1-bbbbbbbb')],
      segments,
      NONCE,
    );
    expect(dropped).toBe(3);
    expect(kept.map((k) => k.segment_id)).toEqual(['p-0-aaaaaaaa', 'page-3', 'p-1-bbbbbbbb']);
  });

  it('accepts a segment cited in the full marker form of this request only', () => {
    const segments = ['p-0-aaaaaaaa'];
    const ok = resolveExtracted([item(`[seg-${NONCE} p-0-aaaaaaaa]`)], segments, NONCE);
    expect(ok).toEqual({ kept: [item('p-0-aaaaaaaa')], dropped: 0 });
    const forged = resolveExtracted([item('[seg-ffffffffffffffffffff p-0-aaaaaaaa]')], segments, NONCE);
    expect(forged.dropped).toBe(1);
  });

  it('looks segments up by their sanitized marker id and stores the real id', () => {
    // documents.ts writes ids as [A-Za-z0-9_-]{1,64}; a raw id with other characters is cited in that form.
    const { kept } = resolveExtracted([item('odd_id_1')], ['odd id/1'], NONCE);
    expect(kept.map((k) => k.segment_id)).toEqual(['odd id/1']);
  });
});

describe('assessment mapping (spec §5.3)', () => {
  it('maps covered / missing / disruptive / not automatable', () => {
    expect(coverageFor({ coverage: 'covered', disruptive: false, automatable: true })).toBe('covered');
    expect(coverageFor({ coverage: 'missing', disruptive: false, automatable: true })).toBe('missing');
    expect(coverageFor({ coverage: 'covered', disruptive: true, automatable: true })).toBe('needs_review');
    expect(coverageFor({ coverage: 'missing', disruptive: true, automatable: true })).toBe('needs_review');
    expect(coverageFor({ coverage: 'needs_review', disruptive: false, automatable: true })).toBe('needs_review');
    expect(coverageFor({ coverage: 'covered', disruptive: false, automatable: false })).toBe('manual');
    expect(coverageFor({ coverage: 'manual', disruptive: true, automatable: true })).toBe('manual');
  });

  it('ignores unknown and repeated requirement ids and counts them', () => {
    const keys = new Map([
      ['R1', 'id-1'],
      ['R2', 'id-2'],
    ]);
    const a = (requirement_id: string, coverage: 'covered' | 'missing' | 'needs_review' | 'manual', extra = {}) => ({
      requirement_id,
      coverage,
      disruptive: false,
      automatable: true,
      ...extra,
    });
    const { updates, ignored } = resolveAssessments(
      [a('R1', 'covered'), a('R7', 'covered'), a('r2', 'missing', { suggestion: '  Add Disable-LocalUser Guest  ' }), a('R1', 'missing'), a('id-1', 'missing')],
      keys,
    );
    expect(ignored).toBe(3);
    expect(updates.get('id-1')).toEqual({ coverage: 'covered', suggestion: null, disruptive: false, automatable: true });
    expect(updates.get('id-2')).toEqual({ coverage: 'missing', suggestion: 'Add Disable-LocalUser Guest', disruptive: false, automatable: true });
  });

  it('a manual task is never marked automatable', () => {
    const { updates } = resolveAssessments([{ requirement_id: 'R1', coverage: 'manual', disruptive: false, automatable: true }], new Map([['R1', 'x']]));
    expect(updates.get('x')).toMatchObject({ coverage: 'manual', automatable: false });
  });
});

const row = (over: Partial<RequirementRow> = {}): RequirementRow => ({
  id: crypto.randomUUID(),
  readmeId: 'r1',
  text: 'Disable the guest account',
  segmentId: 'p-2-cccccccc',
  sourceKind: 'paragraph',
  sourceIndex: 2,
  category: 'accounts',
  coverage: 'detected',
  workState: 'proposed',
  disruptive: false,
  automatable: true,
  suggestion: null,
  notes: null,
  scriptVersionId: null,
  scriptLabel: null,
  evidenceReportId: null,
  evidenceLabel: null,
  ...over,
});

describe('matrix helpers', () => {
  it('source labels: "¶ 3" for the third paragraph, "Page 3" for PDF page 3', () => {
    expect(sourceLabel('paragraph', 2)).toBe('¶ 3');
    expect(sourceLabel('page', 3)).toBe('Page 3');
    expect(sourceLabel(null, null)).toBe('Unknown section');
  });

  it('filters by coverage and state, and counts each', () => {
    const rows = [
      row({ coverage: 'covered' }),
      row({ coverage: 'missing' }),
      row({ coverage: 'covered', workState: 'reported' }),
      row({ coverage: 'manual', workState: 'verified', evidenceReportId: 'rep', evidenceLabel: 'leads.txt · cycle 1' }),
    ];
    expect(filterRows(rows, { coverage: 'covered', state: 'all' })).toHaveLength(2);
    expect(filterRows(rows, { coverage: 'covered', state: 'reported' })).toHaveLength(1);
    expect(filterRows(rows, { coverage: 'all', state: 'verified' })).toHaveLength(1);
    const c = countRows(rows);
    expect(c.total).toBe(4);
    expect(c.coverage).toEqual({ detected: 0, covered: 2, missing: 1, needs_review: 0, manual: 1 });
    expect(c.state).toEqual({ proposed: 2, reported: 1, verified: 1 });
  });

  it('dropped-items message', () => {
    expect(droppedMessage(0)).toBeNull();
    expect(droppedMessage(1)).toBe("1 item was dropped because it didn't cite a README section");
    expect(droppedMessage(3)).toBe("3 items were dropped because they didn't cite a README section");
  });
});
