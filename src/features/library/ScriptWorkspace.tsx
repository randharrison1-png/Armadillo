'use client';

import { useMemo } from 'react';
import { WorkspaceTabs } from '@/components/shell/WorkspaceTabs';
import { libraryWorkspace } from '@/features/workspace/store';
import { ScriptEditorProvider } from './editorContext';
import { scriptTab } from './scriptTabs';
import type { ScriptEditorData, SessionChoice } from './versionTypes';

/**
 * /app/library/[scriptId] outside any session: its own tab strip (namespace `library:<scriptId>`)
 * that starts with — and pins — this script's editor, so "Compare" and "View" open next to it.
 */
export function ScriptWorkspace({ initial, forkTargets }: { initial: ScriptEditorData; forkTargets: SessionChoice[] }) {
  const { script } = initial;
  const config = useMemo(() => libraryWorkspace(scriptTab(script.id, script.filename)), [script.id, script.filename]);
  const extras = useMemo(() => ({ initial, forkTargets }), [initial, forkTargets]);
  return (
    <ScriptEditorProvider value={extras}>
      <WorkspaceTabs namespace={config.namespace} config={config} />
    </ScriptEditorProvider>
  );
}
