import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor';
// Editor features (find, folding, diff editor, clipboard, …) without any language services.
import 'monaco-editor/features/register.all';
// Only the languages scripts can have (Monarch tokenizers; no workers needed).
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/bat/register';
import 'monaco-editor/languages/definitions/markdown/register';
import type { ScriptLanguage } from '@/lib/types';

/*
 * Client-only: imported from CodeEditor, which is itself loaded with next/dynamic({ ssr: false }).
 * @monaco-editor/react would otherwise fetch Monaco from a CDN (jsdelivr); loader.config({ monaco })
 * hands it this locally bundled instance instead, and getWorker serves the worker from our origin.
 */
type MonacoEnv = { getWorker: (workerId: string, label: string) => Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker: () => new Worker(new URL('./editor.worker.ts', import.meta.url), { type: 'module', name: 'monaco-editor-worker' }),
};

loader.config({ monaco });

monaco.editor.defineTheme('armadillo', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#111713',
    'editor.foreground': '#F0F4EF',
    'editorLineNumber.foreground': '#66776B',
    'editorLineNumber.activeForeground': '#F0F4EF',
    'editorCursor.foreground': '#A8D477',
    'editor.lineHighlightBackground': '#1C2520',
    'editor.selectionBackground': '#3A4A3F',
    'editorWidget.background': '#1C2520',
    'editorWidget.border': '#2C3830',
    'focusBorder': '#A8D477',
    'diffEditor.insertedTextBackground': '#A8D47733',
    'diffEditor.removedTextBackground': '#E5735C33',
  },
});

export const MONACO_LANGUAGE: Record<ScriptLanguage, string> = {
  powershell: 'powershell',
  bash: 'shell',
  batch: 'bat',
  markdown: 'markdown',
  text: 'plaintext',
};

export { monaco };
