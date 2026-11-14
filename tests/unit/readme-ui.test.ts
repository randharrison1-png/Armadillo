import { beforeEach, describe, expect, it } from 'vitest';
import { getWorkspaceStore, resetWorkspaceStores } from '@/features/workspace/store';
import { openSegment, readmeTab, segmentDomId, useReadmeUi } from '@/features/readme/readmeUi';

beforeEach(() => {
  window.localStorage.clear();
  resetWorkspaceStores();
  useReadmeUi.setState({ pending: {}, version: {}, intake: {} });
});

describe('readme tab descriptors', () => {
  it('is the latest README without a resourceId, and a specific one with readme_id', () => {
    expect(readmeTab()).toEqual({ key: 'readme', kind: 'readme', title: 'README' });
    expect(readmeTab('abc', 'Nov 12')).toEqual({ key: 'readme:abc', kind: 'readme', title: 'README · Nov 12', resourceId: 'abc' });
  });
  it('segment anchors are seg-<segment id>', () => {
    expect(segmentDomId('p-3-deadbeef')).toBe('seg-p-3-deadbeef');
    expect(segmentDomId('page-3')).toBe('seg-page-3');
  });
});

describe('openSegment', () => {
  it('opens and activates the README tab and queues the segment for the tab to consume', () => {
    openSegment('s1', 'p-0-aaaa1111');
    const ws = getWorkspaceStore('s1').getState();
    expect(ws.activeKey).toBe('readme');
    expect(ws.tabs.map((t) => t.key)).toEqual(['claude', 'flowchart', 'readme']);
    expect(useReadmeUi.getState().pending.s1).toMatchObject({ segmentId: 'p-0-aaaa1111' });
    useReadmeUi.getState().consumeSegment('s1');
    expect(useReadmeUi.getState().pending.s1).toBeUndefined();
  });

  it('targets a specific README and keeps sessions separate', () => {
    openSegment('s2', 'page-3', 'r9');
    expect(getWorkspaceStore('s2').getState().activeKey).toBe('readme:r9');
    expect(getWorkspaceStore('s2').getState().tabs.at(-1)).toMatchObject({ resourceId: 'r9' });
    expect(useReadmeUi.getState().pending.s1).toBeUndefined();
  });

  it('re-requesting the same segment issues a new request (re-highlights)', () => {
    openSegment('s3', 'page-1');
    const a = useReadmeUi.getState().pending.s3;
    useReadmeUi.getState().consumeSegment('s3');
    openSegment('s3', 'page-1');
    expect(useReadmeUi.getState().pending.s3?.nonce).not.toBe(a?.nonce);
  });
});
