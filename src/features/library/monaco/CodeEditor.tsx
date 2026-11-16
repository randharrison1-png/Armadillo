'use client';

import { useEffect, useRef, useState } from 'react';
import { DiffEditor, Editor, type DiffOnMount, type OnMount } from '@monaco-editor/react';
import { LoadingState } from '@/components/shell/states/LoadingState';
import type { LineEnding } from '@/server/db/types';
import type { ScriptLanguage } from '@/lib/types';
import { MONACO_LANGUAGE, monaco } from './setup';

export type ModifiedEditor = monaco.editor.ICodeEditor;

/*
 * Monaco wrappers. Load this module with next/dynamic({ ssr: false }) only: importing it pulls in
 * Monaco (browser-only) and configures @monaco-editor/react to use the local bundle.
 *
 * Line endings: a 'crlf' / 'lf' version gets that model EOL, so every newline the user types and
 * every getValue() uses it — saved text keeps the version's line ending. A 'mixed' version cannot be
 * represented by one model EOL: Monaco normalizes it to the dominant ending when the model is
 * created. `onReady` reports the text as the editor holds it so callers can compare edits against
 * that (not the stored string) and tell the user what a save will do.
 */

const BASE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 14,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
  // Never prompt to strip U+2028 etc.: content must stay exactly as stored unless the user edits it.
  unusualLineTerminators: 'off',
  padding: { top: 8, bottom: 8 },
};

const loading = <LoadingState label="Loading editor" />;

type EditorProps = {
  value: string;
  language: ScriptLanguage;
  lineEnding: LineEnding;
  ariaLabel: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Called once after mount with the text as the editor holds it (EOL applied / normalized). */
  onReady?: (value: string) => void;
  /** Ctrl/Cmd+S inside the editor. */
  onSave?: () => void;
};

export function CodeEditor({ value, language, lineEnding, ariaLabel, readOnly = false, onChange, onReady, onSave }: EditorProps) {
  const handlers = useRef({ onReady, onSave });
  useEffect(() => {
    handlers.current = { onReady, onSave };
  });

  const onMount: OnMount = (editor, m) => {
    const model = editor.getModel();
    if (model && lineEnding !== 'mixed') {
      model.setEOL(lineEnding === 'crlf' ? m.editor.EndOfLineSequence.CRLF : m.editor.EndOfLineSequence.LF);
    }
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => handlers.current.onSave?.());
    handlers.current.onReady?.(editor.getValue());
  };

  return (
    <Editor
      value={value}
      language={MONACO_LANGUAGE[language]}
      theme="armadillo"
      loading={loading}
      options={{ ...BASE_OPTIONS, readOnly, ariaLabel, domReadOnly: readOnly }}
      onMount={onMount}
      onChange={(v) => onChange?.(v ?? '')}
    />
  );
}

type DiffProps = { original: string; modified: string; language: ScriptLanguage; ariaLabel: string };

export function CodeDiff({ original, modified, language, ariaLabel }: DiffProps) {
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={MONACO_LANGUAGE[language]}
      theme="armadillo"
      loading={loading}
      options={{
        ...BASE_OPTIONS,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        // Whitespace matters in scripts: show whitespace-only changes too.
        ignoreTrimWhitespace: false,
        ariaLabel,
        originalAriaLabel: `${ariaLabel}, older version`,
        modifiedAriaLabel: `${ariaLabel}, newer version`,
      }}
    />
  );
}

type ReviewDiffProps = {
  /** Left side, never editable. */
  original: string;
  /** Right side's starting text. Read once at mount: later changes to this prop are ignored (remount with a new `key` to reset). */
  modified: string;
  language: ScriptLanguage;
  lineEnding: LineEnding;
  ariaLabel: string;
  /** Right side read-only too (decided proposals, completed sessions). */
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Called once after mount with the right side's text as the editor holds it (EOL applied). */
  onReady?: (value: string) => void;
  /** The right-hand editor, for "go to line". Called with null on unmount. */
  onModifiedEditor?: (editor: ModifiedEditor | null) => void;
};

/**
 * Side-by-side review of a proposed script: original on the left (read-only), the proposal on the
 * right, editable unless `readOnly`. Both models get the base version's line ending, like CodeEditor.
 */
export function ReviewDiff({ original, modified, language, lineEnding, ariaLabel, readOnly = false, onChange, onReady, onModifiedEditor }: ReviewDiffProps) {
  const handlers = useRef({ onChange, onReady, onModifiedEditor });
  useEffect(() => {
    handlers.current = { onChange, onReady, onModifiedEditor };
  });
  const [initial] = useState(modified);
  useEffect(() => () => handlers.current.onModifiedEditor?.(null), []);

  const onMount: DiffOnMount = (editor, m) => {
    const eol = lineEnding === 'crlf' ? m.editor.EndOfLineSequence.CRLF : m.editor.EndOfLineSequence.LF;
    const right = editor.getModifiedEditor();
    if (lineEnding !== 'mixed') {
      editor.getOriginalEditor().getModel()?.setEOL(eol);
      right.getModel()?.setEOL(eol);
    }
    right.onDidChangeModelContent(() => handlers.current.onChange?.(right.getValue()));
    handlers.current.onReady?.(right.getValue());
    handlers.current.onModifiedEditor?.(right);
  };

  return (
    <DiffEditor
      original={original}
      modified={initial}
      language={MONACO_LANGUAGE[language]}
      theme="armadillo"
      loading={loading}
      onMount={onMount}
      options={{
        ...BASE_OPTIONS,
        readOnly,
        domReadOnly: readOnly,
        originalEditable: false,
        renderSideBySide: true,
        ignoreTrimWhitespace: false,
        ariaLabel,
        originalAriaLabel: `${ariaLabel}, current version`,
        modifiedAriaLabel: `${ariaLabel}, proposed version${readOnly ? '' : ' (editable)'}`,
      }}
    />
  );
}
