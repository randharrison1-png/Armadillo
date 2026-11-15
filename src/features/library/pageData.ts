import 'server-only';
import { cache } from 'react';
import { requireUser } from '@/server/auth';
import { getScriptEditorDataFor } from './versioning';

/** Memoised per request: the script layout (404 gate) and the page share one query. */
export const loadScriptPage = cache(async (scriptId: string) => {
  const user = await requireUser();
  return getScriptEditorDataFor(user.id, scriptId);
});
