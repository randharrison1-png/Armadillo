'use client';

import { create } from 'zustand';
import type { TabDescriptor } from '@/lib/types';

/** The session's reports list view (with the upload control). */
export const REPORTS_TAB: TabDescriptor = { key: 'report', kind: 'report', title: 'LEADS reports' };

/** One specific report (key `report:<id>`, resourceId = report id). */
export function reportTab(reportId: string, filename?: string): TabDescriptor {
  return { key: `report:${reportId}`, kind: 'report', title: filename ? `Report · ${filename}` : 'Report', resourceId: reportId };
}

type ReportUiState = {
  /** Bumped when a report is added, so mounted report views reload. */
  version: Record<string, number | undefined>;
  bumpVersion: (sessionId: string) => void;
};

export const useReportUi = create<ReportUiState>((set) => ({
  version: {},
  bumpVersion: (sessionId) => set((s) => ({ version: { ...s.version, [sessionId]: (s.version[sessionId] ?? 0) + 1 } })),
}));
