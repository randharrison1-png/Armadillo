'use client';

// The client half of the deep links in tabLink.ts: the tab descriptor a `?tab=` link asks for.
import type { TabDescriptor } from '@/lib/types';
import { scriptTab } from '@/features/library/scriptTabs';
import { proposalTab } from '@/features/proposals/review';
import { readmeTab } from '@/features/readme/readmeUi';
import { REPORTS_TAB, reportTab } from '@/features/reports/reportUi';
import { REQUIREMENTS_TAB } from '@/features/requirements/matrix';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tab a link asks for, or null (unknown or malformed links open nothing). */
export function tabFromParams(params: { get(name: string): string | null }): TabDescriptor | null {
  const tab = params.get('tab');
  const id = params.get('id') ?? '';
  const name = params.get('name') ?? undefined;
  switch (tab) {
    case 'flowchart':
      return { key: 'flowchart', kind: 'flowchart', title: 'Flowchart' };
    case 'requirements':
      return { ...REQUIREMENTS_TAB };
    case 'readme':
      return readmeTab();
    case 'reports':
      return { ...REPORTS_TAB };
    case 'report':
      return UUID_RE.test(id) ? reportTab(id, name) : null;
    case 'script':
      return UUID_RE.test(id) ? scriptTab(id, name ?? 'Script') : null;
    case 'proposal':
      return UUID_RE.test(id) ? proposalTab(id, name ?? 'Remediation') : null;
    default:
      return null;
  }
}
