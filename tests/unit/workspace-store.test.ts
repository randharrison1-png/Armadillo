import { beforeEach, describe, expect, it } from 'vitest';
import { getWorkspaceStore, libraryWorkspace, resetWorkspaceStores } from '@/features/workspace/store';
import type { TabDescriptor } from '@/lib/types';

const script = (n: number): TabDescriptor => ({ key: `script:${n}`, kind: 'script', title: `Script ${n}`, resourceId: `${n}` });
const keys = (id: string) => getWorkspaceStore(id).getState().tabs.map((t) => t.key);

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStores();
});

describe('workspace store', () => {
  it('starts with claude and flowchart tabs, claude active', () => {
    const s = getWorkspaceStore('a').getState();
    expect(s.tabs.map((t) => t.key)).toEqual(['claude', 'flowchart']);
    expect(s.activeKey).toBe('claude');
  });

  it('openTab dedupes by key and activates existing', () => {
    const st = getWorkspaceStore('a');
    st.getState().openTab(script(1));
    st.getState().openTab(script(2));
    st.getState().openTab(script(1));
    expect(keys('a')).toEqual(['claude', 'flowchart', 'script:1', 'script:2']);
    expect(st.getState().activeKey).toBe('script:1');
  });

  it('opening a script tab keeps the claude tab open', () => {
    const st = getWorkspaceStore('a');
    st.getState().openTab(script(1));
    expect(keys('a')).toContain('claude');
    expect(st.getState().activeKey).toBe('script:1');
  });

  it('claude tab is pinned: closeTab is a no-op for it', () => {
    const st = getWorkspaceStore('a');
    st.getState().closeTab('claude');
    expect(keys('a')).toContain('claude');
    expect(st.getState().activeKey).toBe('claude');
  });

  it('closing active tab activates right neighbor, else left', () => {
    const st = getWorkspaceStore('a');
    st.getState().openTab(script(1));
    st.getState().openTab(script(2));
    st.getState().openTab(script(3));
    st.getState().activate('script:2');
    st.getState().closeTab('script:2');
    expect(st.getState().activeKey).toBe('script:3');
    st.getState().closeTab('script:3');
    expect(st.getState().activeKey).toBe('script:1');
  });

  it('closing a non-active tab keeps the active tab', () => {
    const st = getWorkspaceStore('a');
    st.getState().openTab(script(1));
    st.getState().closeTab('flowchart');
    expect(st.getState().activeKey).toBe('script:1');
    expect(keys('a')).toEqual(['claude', 'script:1']);
  });

  it('activate ignores unknown keys', () => {
    const st = getWorkspaceStore('a');
    st.getState().activate('nope');
    expect(st.getState().activeKey).toBe('claude');
  });

  it('persists per session under armadillo.tabs.{sessionId} and restores', () => {
    getWorkspaceStore('a').getState().openTab(script(1));
    expect(localStorage.getItem('armadillo.tabs.a')).toContain('script:1');
    expect(localStorage.getItem('armadillo.tabs.b')).toBeNull();
    resetWorkspaceStores();
    const s = getWorkspaceStore('a').getState();
    s.hydrate();
    expect(getWorkspaceStore('a').getState().tabs.map((t) => t.key)).toEqual(['claude', 'flowchart', 'script:1']);
    expect(getWorkspaceStore('a').getState().activeKey).toBe('script:1');
    expect(keys('b')).toEqual(['claude', 'flowchart']);
  });

  it.each(['{not json', '"str"', '{"tabs":42}', '{"tabs":[{"nope":1}],"activeKey":"x"}'])(
    'corrupt localStorage (%s) falls back to [claude, flowchart]',
    (raw) => {
      localStorage.setItem('armadillo.tabs.a', raw);
      getWorkspaceStore('a').getState().hydrate();
      expect(keys('a')).toEqual(['claude', 'flowchart']);
      expect(getWorkspaceStore('a').getState().activeKey).toBe('claude');
    },
  );

  it('survives localStorage throwing', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      const st = getWorkspaceStore('a');
      expect(() => st.getState().openTab(script(1))).not.toThrow();
      expect(st.getState().activeKey).toBe('script:1');
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it('a library namespace starts with (and pins) its script editor tab, stored separately', () => {
    const cfg = libraryWorkspace({ key: 'script:x', kind: 'script', title: 'x.ps1', resourceId: 'x' });
    expect(cfg.namespace).toBe('library:x');
    const st = getWorkspaceStore(cfg.namespace, cfg);
    expect(st.getState().tabs.map((t) => t.key)).toEqual(['script:x']);
    expect(st.getState().activeKey).toBe('script:x');
    st.getState().closeTab('script:x');
    expect(st.getState().tabs.map((t) => t.key)).toEqual(['script:x']);
    st.getState().openTab({ key: 'diff:x', kind: 'diff', title: 'd' });
    expect(localStorage.getItem('armadillo.tabs.library:x')).toContain('diff:x');
    // A persisted list that lost the pinned tab gets it back (not the Claude tab).
    localStorage.setItem('armadillo.tabs.library:y', JSON.stringify({ tabs: [{ key: 'diff:y', kind: 'diff', title: 'd' }], activeKey: 'diff:y' }));
    const y = libraryWorkspace({ key: 'script:y', kind: 'script', title: 'y.ps1', resourceId: 'y' });
    const sy = getWorkspaceStore(y.namespace, y);
    sy.getState().hydrate();
    expect(sy.getState().tabs.map((t) => t.key)).toEqual(['script:y', 'diff:y']);
    // Session stores are unaffected.
    expect(keys('a')).toEqual(['claude', 'flowchart']);
  });
});
