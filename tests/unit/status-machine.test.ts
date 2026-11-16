import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvalidTransitionError, transition } from '@/features/requirements/statusMachine';
import { RequirementsMatrix } from '@/features/requirements/RequirementsMatrix';
import type { RequirementRow } from '@/features/requirements/types';
import type { Requirement } from '@/lib/types';

const base = (over: Partial<Requirement> = {}): Requirement => ({
  id: '00000000-0000-4000-8000-000000000001',
  owner_id: '00000000-0000-4000-8000-0000000000aa',
  session_id: '00000000-0000-4000-8000-0000000000bb',
  readme_id: '00000000-0000-4000-8000-0000000000cc',
  text: 'Disable the guest account',
  segment_id: 'p-0-aaaaaaaa',
  category: 'accounts',
  coverage: 'covered',
  work_state: 'proposed',
  disruptive: false,
  automatable: true,
  script_version_id: '00000000-0000-4000-8000-0000000000dd',
  evidence_report_id: null,
  notes: null,
  suggestion: null,
  reviewed_at: null,
  created_at: new Date(0),
  updated_at: new Date(0),
  ...over,
});
const REPORT = { reportId: '00000000-0000-4000-8000-0000000000ee' };

describe('transition (pure state machine)', () => {
  it('covered cannot become verified without evidence', () => {
    const covered = base();
    expect(() => transition(covered, 'verified')).toThrow(InvalidTransitionError);
    // Not even with evidence straight from proposed: only a reported (implemented) requirement can be verified.
    expect(() => transition(covered, 'verified', REPORT)).toThrow(InvalidTransitionError);
    const reported = transition(covered, 'reported');
    expect(() => transition(reported, 'verified')).toThrow(InvalidTransitionError);
    expect(() => transition(reported, 'verified', { reportId: '' })).toThrow(InvalidTransitionError);
    const verified = transition(reported, 'verified', REPORT);
    expect(verified).toMatchObject({ work_state: 'verified', evidence_report_id: REPORT.reportId });
    // Pure: the input is untouched.
    expect(covered.work_state).toBe('proposed');
    expect(reported.work_state).toBe('reported');
  });

  it('proposed → reported needs a covering script version', () => {
    expect(() => transition(base({ script_version_id: null }), 'reported')).toThrow(InvalidTransitionError);
    expect(() => transition(base({ coverage: 'missing' }), 'reported')).toThrow(InvalidTransitionError);
    expect(() => transition(base({ coverage: 'detected', script_version_id: null }), 'reported')).toThrow(InvalidTransitionError);
    expect(transition(base(), 'reported')).toMatchObject({ work_state: 'reported', evidence_report_id: null });
  });

  it('a disruptive covered requirement cannot be reported until it is reviewed', () => {
    const disruptive = base({ disruptive: true });
    expect(() => transition(disruptive, 'reported')).toThrow(InvalidTransitionError);
    expect(transition({ ...disruptive, reviewed_at: new Date(1) }, 'reported')).toMatchObject({ work_state: 'reported' });
  });

  it('a manual requirement may go straight to verified, only with evidence', () => {
    const manual = base({ coverage: 'manual', automatable: false, script_version_id: null });
    expect(() => transition(manual, 'verified')).toThrow(InvalidTransitionError);
    expect(() => transition(manual, 'reported')).toThrow(InvalidTransitionError);
    expect(transition(manual, 'verified', REPORT)).toMatchObject({ work_state: 'verified', evidence_report_id: REPORT.reportId });
  });

  it('verified is final; no move back or in place', () => {
    const verified = base({ work_state: 'verified', evidence_report_id: REPORT.reportId });
    for (const to of ['proposed', 'reported', 'verified'] as const) {
      expect(() => transition(verified, to, REPORT)).toThrow(InvalidTransitionError);
    }
    expect(() => transition(base({ work_state: 'reported' }), 'proposed')).toThrow(InvalidTransitionError);
    expect(() => transition(base(), 'proposed')).toThrow(InvalidTransitionError);
    const err = (() => {
      try {
        transition(base(), 'proposed');
      } catch (e) {
        return e as InvalidTransitionError;
      }
    })();
    expect(err).toMatchObject({ name: 'InvalidTransitionError', from: 'proposed', to: 'proposed' });
  });
});

const row = (over: Partial<RequirementRow> = {}): RequirementRow => ({
  id: crypto.randomUUID(),
  readmeId: 'readme-1',
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
  reviewedAt: null,
  failingInLatest: null,
  ...over,
});

function renderMatrix(rows: RequirementRow[], onOpenSource = vi.fn(), onMarkReviewed = vi.fn(async () => ({ ok: true as const, reviewedAt: '2026-11-14T00:00:00Z' }))) {
  render(
    createElement(RequirementsMatrix, {
      rows,
      readOnly: false,
      onOpenSource,
      onSaveNotes: async (_id: string, notes: string) => ({ ok: true as const, notes: notes || null }),
      onMarkReviewed,
    }),
  );
  return { onOpenSource, onMarkReviewed };
}

const bodyRows = () => within(screen.getByRole('table', { name: 'Requirements' })).getAllByRole('row').slice(1);

describe('requirements matrix', () => {
  it('manual requirements create a manual task row visible in the matrix', () => {
    renderMatrix([
      row({ text: 'Verify the forensic answers with the team captain', coverage: 'manual', automatable: false }),
      row({ text: 'Disable the guest account', coverage: 'covered', scriptVersionId: 'v', scriptLabel: 'Guest hardening · v1' }),
    ]);
    const manual = bodyRows().find((r) => r.textContent?.includes('Verify the forensic answers'))!;
    expect(manual).toBeTruthy();
    expect(within(manual).getByText('Manual task')).toBeInTheDocument();
    expect(within(manual).getByText('Proposed')).toBeInTheDocument();
    expect(screen.getByTestId('requirements-summary')).toHaveTextContent('Manual task 1');
  });

  it('columns, source buttons, three distinct states, and Verified only with its evidence report', async () => {
    const { onOpenSource } = renderMatrix([
      row({ text: 'Remote Desktop must stay disabled', sourceKind: 'page', sourceIndex: 3, segmentId: 'page-3', coverage: 'covered', workState: 'reported', scriptVersionId: 'v', scriptLabel: 'S · v2' }),
      row({ text: 'Guest disabled', coverage: 'covered', workState: 'verified', evidenceReportId: 'rep-1', evidenceLabel: 'leads.txt · cycle 1' }),
      row({ text: 'Enable the firewall', disruptive: true, coverage: 'covered', scriptVersionId: 'v', scriptLabel: 'S · v2' }),
    ]);
    const headers = within(screen.getByRole('table', { name: 'Requirements' }))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Requirement', 'Source', 'Coverage', 'State', 'Notes']);

    const [reported, verified, disruptive] = bodyRows();
    expect(within(reported).getByText('Reported')).toBeInTheDocument();
    expect(within(verified).getByText('Verified')).toBeInTheDocument();
    expect(within(verified).getByText(/leads\.txt · cycle 1/)).toBeInTheDocument();
    expect(within(reported).queryByText('Verified')).toBeNull();
    // Disruptive rows carry a visible "Needs review" marker (text, not colour alone).
    expect(within(disruptive).getByTestId('disruptive-marker')).toHaveTextContent('Needs review');

    await userEvent.click(within(reported).getByRole('button', { name: /Page 3/ }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 'page-3', readmeId: 'readme-1' }));
    expect(within(bodyRows()[1]).getByRole('button', { name: /¶ 3/ })).toBeInTheDocument();
  });

  it('Mark reviewed clears the "Needs review" marker; coverage is unchanged', async () => {
    const r = row({ text: 'Stop the FTP service', disruptive: true, coverage: 'covered', scriptVersionId: 'v', scriptLabel: 'S · v1' });
    const { onMarkReviewed } = renderMatrix([r]);
    const tr = bodyRows()[0];
    expect(within(tr).getByTestId('disruptive-marker')).toHaveTextContent('Needs review');
    expect(within(tr).getByText('Covered')).toBeInTheDocument();
    await userEvent.click(within(tr).getByRole('button', { name: 'Mark reviewed: Stop the FTP service' }));
    expect(onMarkReviewed).toHaveBeenCalledWith(r.id);
    expect(await within(bodyRows()[0]).findByText('Disruptive · reviewed')).toBeInTheDocument();
    expect(within(bodyRows()[0]).queryByTestId('disruptive-marker')).toBeNull();
    expect(screen.getByTestId('requirements-summary')).toHaveTextContent('Needs review 0');
  });

  it('a reviewed disruptive row shows no marker', () => {
    renderMatrix([row({ disruptive: true, reviewedAt: '2026-11-14T00:00:00Z' })]);
    expect(screen.queryByTestId('disruptive-marker')).toBeNull();
    expect(screen.getByText('Disruptive · reviewed')).toBeInTheDocument();
  });

  it('a verified row without an evidence reference is never shown as Verified', () => {
    renderMatrix([row({ workState: 'verified', evidenceReportId: null })]);
    expect(within(bodyRows()[0]).queryByText('Verified')).toBeNull();
  });

  it('filters by coverage and by state', async () => {
    renderMatrix([
      row({ text: 'Alpha', coverage: 'covered' }),
      row({ text: 'Beta', coverage: 'missing' }),
      row({ text: 'Gamma', coverage: 'covered', workState: 'reported', scriptVersionId: 'v' }),
    ]);
    expect(bodyRows()).toHaveLength(3);
    await userEvent.selectOptions(screen.getByLabelText('Coverage'), 'covered');
    expect(bodyRows().map((r) => r.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Gamma')]);
    await userEvent.selectOptions(screen.getByLabelText('State'), 'reported');
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('Gamma');
    await userEvent.selectOptions(screen.getByLabelText('Coverage'), 'missing');
    expect(screen.getByText('No requirements match these filters.')).toBeInTheDocument();
  });

  it('edits a note', async () => {
    renderMatrix([row({ text: 'Alpha' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Add note to requirement: Alpha' }));
    await userEvent.type(screen.getByLabelText('Note for requirement: Alpha'), 'checked by hand');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('checked by hand')).toBeInTheDocument();
  });
});
