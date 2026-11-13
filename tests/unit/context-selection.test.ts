import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getContextStore, resetContextStores, useContextSelection } from '@/features/claude/contextSelection';

const key = (id: string) => `armadillo.context.${id}`;
const ref = (id: string, type: 'script_version' | 'readme' = 'script_version') => ({ type, id });

beforeEach(() => {
  window.localStorage.clear();
  resetContextStores();
});

describe('context selection store', () => {
  it('adds, dedupes by type+id, removes and clears', () => {
    const s = getContextStore('s1');
    s.getState().add(ref('a'));
    s.getState().add(ref('a'));
    s.getState().add(ref('a', 'readme'));
    expect(s.getState().refs).toEqual([ref('a'), ref('a', 'readme')]);
    s.getState().remove(ref('a'));
    expect(s.getState().refs).toEqual([ref('a', 'readme')]);
    s.getState().clear();
    expect(s.getState().refs).toEqual([]);
  });

  it('persists per session under armadillo.context.{sessionId}', () => {
    getContextStore('s1').getState().add(ref('a'));
    expect(JSON.parse(window.localStorage.getItem(key('s1'))!)).toEqual([ref('a')]);
    expect(window.localStorage.getItem(key('s2'))).toBeNull();
    resetContextStores();
    expect(getContextStore('s1').getState().refs).toEqual([]); // not hydrated until used
    getContextStore('s1').getState().add(ref('b'));
    expect(getContextStore('s1').getState().refs).toEqual([ref('a'), ref('b')]); // add hydrates first
  });

  it('ignores corrupt or invalid persisted data', () => {
    window.localStorage.setItem(key('s1'), '{not json');
    getContextStore('s1').getState().hydrate();
    expect(getContextStore('s1').getState().refs).toEqual([]);
    resetContextStores();
    window.localStorage.setItem(key('s1'), JSON.stringify([ref('ok'), { type: 'bogus', id: 'x' }, { type: 'readme' }, 5]));
    getContextStore('s1').getState().hydrate();
    expect(getContextStore('s1').getState().refs).toEqual([ref('ok')]);
  });

  it('survives unavailable storage', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      const s = getContextStore('s9');
      s.getState().add(ref('a'));
      expect(s.getState().refs).toEqual([ref('a')]);
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it('useContextSelection exposes refs and actions, hydrating after mount', () => {
    window.localStorage.setItem(key('s1'), JSON.stringify([ref('a')]));
    const { result } = renderHook(() => useContextSelection('s1'));
    expect(result.current.refs).toEqual([ref('a')]);
    act(() => result.current.add(ref('b')));
    expect(result.current.refs).toEqual([ref('a'), ref('b')]);
    act(() => result.current.remove(ref('a')));
    expect(result.current.refs).toEqual([ref('b')]);
    act(() => result.current.clear());
    expect(result.current.refs).toEqual([]);
  });
});
