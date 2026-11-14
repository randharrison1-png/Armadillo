// Type-only (client-safe) shapes shared by the versioning service, its server actions and the editor UI.
import type { Script, ScriptVersion } from '@/lib/types';

export type SaveResult =
  | { status: 'created' | 'unchanged'; version: ScriptVersion }
  | { status: 'conflict'; latest: ScriptVersion };

/** A version without its content, for history lists. */
export type VersionSummary = Omit<ScriptVersion, 'content'>;

/** `readOnly`: the script belongs to a completed session (the database refuses writes). */
export type ScriptEditorData = { script: Script; current: ScriptVersion; versions: VersionSummary[]; readOnly: boolean };

/** An active session a script can be forked into / used with. */
export type SessionChoice = { id: string; title: string };
