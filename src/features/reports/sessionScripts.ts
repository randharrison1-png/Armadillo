import 'server-only';
import type { Tx } from '@/server/db/withUser';
import type { Script, ScriptVersion } from '@/lib/types';

/**
 * Which session script is "the hardening script" (Task 17): the newest non-archived session script
 * with a current version that is NOT an accepted remediation (a script whose version is the result
 * of an accepted remediation proposal). Remediation proposals are written against it, and the
 * flowchart's "Run hardening script" opens it; remediation scripts are listed separately.
 */
export const notRemediationScript = (tx: Tx) => tx`
  not exists (
    select 1 from public.proposals p join public.script_versions rv on rv.id = p.result_version_id
    where p.session_id = s.session_id and p.kind = 'remediation' and p.status = 'accepted' and rv.script_id = s.id)`;

export async function latestHardeningScriptTx(tx: Tx, sessionId: string): Promise<{ script: Script; version: ScriptVersion } | null> {
  const [script] = await tx<Script[]>`
    select s.* from public.scripts s
    where s.session_id = ${sessionId} and s.function = 'session_generated' and s.archived_at is null
      and s.current_version_id is not null and ${notRemediationScript(tx)}
    order by s.updated_at desc, s.created_at desc, s.id limit 1`;
  if (!script) return null;
  const [version] = await tx<ScriptVersion[]>`select * from public.script_versions where id = ${script.current_version_id}`;
  return version ? { script, version } : null;
}
