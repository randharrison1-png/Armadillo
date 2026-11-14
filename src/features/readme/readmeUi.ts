'use client';

import { create } from 'zustand';
import type { TabDescriptor } from '@/lib/types';
import { getWorkspaceStore } from '@/features/workspace/store';

/** DOM id of a segment's element in the README tab (also usable as a `#seg-...` URL hash). */
export const segmentDomId = (segmentId: string) => `seg-${segmentId}`;

/**
 * The README tab. With no `readmeId` it is the session's LATEST README (key `readme`, no
 * resourceId), so it follows re-uploads. With a `readmeId` it is that specific README
 * (key `readme:<id>`, resourceId = id): use this when a record points at a readme_id.
 */
export function readmeTab(readmeId?: string, label?: string): TabDescriptor {
  return readmeId
    ? { key: `readme:${readmeId}`, kind: 'readme', title: label ? `README · ${label}` : 'README', resourceId: readmeId }
    : { key: 'readme', kind: 'readme', title: 'README' };
}

export type IntakeTab = 'paste' | 'upload';

type ReadmeUiState = {
  /** Segment each session's README tab should scroll to and highlight next. Consumed by the tab. */
  pending: Record<string, { segmentId: string; nonce: number } | undefined>;
  /** Bumped when a README is added, so mounted README views reload. */
  version: Record<string, number | undefined>;
  /** Intake dialog state per session: null/absent = closed. */
  intake: Record<string, IntakeTab | null | undefined>;
  requestSegment: (sessionId: string, segmentId: string) => void;
  consumeSegment: (sessionId: string) => void;
  bumpVersion: (sessionId: string) => void;
  openIntake: (sessionId: string, tab?: IntakeTab) => void;
  closeIntake: (sessionId: string) => void;
};

let nonce = 0;

export const useReadmeUi = create<ReadmeUiState>((set) => ({
  pending: {},
  version: {},
  intake: {},
  requestSegment: (sessionId, segmentId) => set((s) => ({ pending: { ...s.pending, [sessionId]: { segmentId, nonce: ++nonce } } })),
  consumeSegment: (sessionId) => set((s) => ({ pending: { ...s.pending, [sessionId]: undefined } })),
  bumpVersion: (sessionId) => set((s) => ({ version: { ...s.version, [sessionId]: (s.version[sessionId] ?? 0) + 1 } })),
  openIntake: (sessionId, tab = 'paste') => set((s) => ({ intake: { ...s.intake, [sessionId]: tab } })),
  closeIntake: (sessionId) => set((s) => ({ intake: { ...s.intake, [sessionId]: null } })),
}));

/**
 * Opens the session's README tab and scrolls to / briefly highlights one segment. Safe to call
 * whether or not the tab is open or mounted: the request is queued in the store and consumed by
 * the README tab once its content has loaded (segment ids are stable, `Segment.id`).
 * Pass `readmeId` to target a specific README (e.g. a requirement's `readme_id`); omit for the latest.
 * Client-side only (call from event handlers or effects).
 */
export function openSegment(sessionId: string, segmentId: string, readmeId?: string): void {
  useReadmeUi.getState().requestSegment(sessionId, segmentId);
  getWorkspaceStore(sessionId).getState().openTab(readmeTab(readmeId));
}
