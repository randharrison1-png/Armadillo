import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { SetInspector, useInspectorStore } from '@/components/shell/inspectorStore';

let writes = 0;
beforeEach(() => {
  writes = 0;
  useInspectorStore.setState({ open: false, sections: [] });
  useInspectorStore.subscribe(() => void writes++);
});

function Page() {
  const [n, setN] = useState(0);
  // Subscribes to the store like a real page might.
  useInspectorStore((s) => s.sections);
  return (
    <div>
      <button onClick={() => setN(n + 1)}>rerender {n}</button>
      <SetInspector sections={[{ id: 'a', title: 'A', content: <span>{n}</span> }]} />
    </div>
  );
}

describe('SetInspector', () => {
  it('does not loop or rewrite the store on re-renders with inline sections', () => {
    render(<Page />);
    const btn = screen.getByRole('button');
    for (let i = 0; i < 5; i++) btn.click();
    expect(useInspectorStore.getState().sections.map((s) => s.id)).toEqual(['a']);
    expect(writes).toBeLessThanOrEqual(1);
  });

  it('clears sections on unmount', () => {
    const { unmount } = render(<Page />);
    unmount();
    expect(useInspectorStore.getState().sections).toEqual([]);
  });
});
