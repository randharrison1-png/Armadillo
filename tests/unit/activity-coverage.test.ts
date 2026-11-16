// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeServerActions, type SourceFiles } from '../support/activityCoverage';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function loadSources(): SourceFiles {
  const files: SourceFiles = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files[path.relative(ROOT, full).split(path.sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(path.join(ROOT, 'src'));
  return files;
}

/**
 * Exported server actions that do not mutate user data. Every other exported action of a
 * 'use server' module must reach logActivity (spec section 10: important actions and file/version
 * changes are recorded). Keys are `<file>#<export>`; keep one line of reasoning each.
 */
const READ_ONLY_ACTIONS: Record<string, string> = {
  'src/features/claude/actions.ts#loadClaudeTab': 'read: conversations for the Claude tab',
  'src/features/claude/actions.ts#loadConversation': 'read: one conversation',
  'src/features/claude/actions.ts#loadContextOptions': 'read: context-picker labels',
  'src/features/flowchart/actions.ts#loadFlowchart': 'read: flowchart data',
  'src/features/library/actions.ts#prepareScriptUpload': 'validates and issues an upload target; writes no row (recordUploadedScript logs)',
  'src/features/library/actions.ts#getPublishSource': 'read: script text for the publish dialog (publishing itself logs)',
  'src/features/library/actions.ts#getScriptContent': 'read: current version text for copy to clipboard',
  'src/features/library/versionActions.ts#loadScriptEditor': 'read: editor data',
  'src/features/library/versionActions.ts#loadVersion': 'read: one version',
  'src/features/pastebin/actions.ts#loadOwnPaste': 'read: own paste for the editor',
  'src/features/proposals/actions.ts#loadProposal': 'read: proposal diff data',
  'src/features/proposals/actions.ts#loadAdaptationOptions': 'read: READMEs of the session',
  'src/features/readme/actions.ts#prepareReadmeUpload': 'validates and issues an upload target; writes no row (recordUploadedReadme logs)',
  'src/features/readme/actions.ts#loadReadmeView': 'read: README tab data',
  'src/features/reports/actions.ts#prepareReportUpload': 'validates and issues an upload target; writes no row (recordUploadedLeadsReport logs)',
  'src/features/reports/actions.ts#loadReportsView': 'read: reports list',
  'src/features/reports/actions.ts#loadReportView': 'read: one report',
  'src/features/reports/actions.ts#loadReportRaw': 'read: a page of raw report text',
  'src/features/requirements/actions.ts#loadRequirementsView': 'read: requirements tab data',
  'src/features/sessions/completeActions.ts#loadForensic': 'read: forensic questions',
  'src/features/sessions/completeActions.ts#prepareEvidenceUpload': 'validates and issues an upload target; writes no row (recordEvidenceAction logs)',
  'src/features/settings/actions.ts#getClaudeKeyStatus': 'read: last4 and presence of the saved key',
  'src/features/settings/actions.ts#testConnectionAction': 'sends one minimal request to Claude; stores nothing',
};

/** Mutating actions that cannot write to activity_log, with the reason. Do not add to this casually. */
const NOT_LOGGABLE_ACTIONS: Record<string, string> = {
  'src/features/pastebin/actions.ts#reportPasteAction':
    'anonymous abuse report: activity_log rows belong to auth.uid() and a reporter has none; paste.reports (with a pseudonymous reporter hash) is the record',
  'src/features/settings/actions.ts#deleteAccountAction':
    'account deletion cascades the account\'s activity_log away; there is nothing left to attach an entry to',
  'src/server/auth/actions.ts#signInWithEmail': 'authentication (test provider): establishes a session, no user content changes',
  'src/server/auth/actions.ts#signInWithPassword': 'authentication: establishes a session, no user content changes',
  'src/server/auth/actions.ts#signUpWithPassword': 'authentication: creates the auth user (no profile content, no session to own an entry)',
  'src/server/auth/actions.ts#signOut': 'authentication: clears the session, no user content changes',
};

const sources = loadSources();
const { actions, unanalysable } = analyzeServerActions(sources);
const key = (a: { file: string; name: string }) => `${a.file}#${a.name}`;

describe('activity coverage: every mutating server action reaches logActivity', () => {
  it('finds the server action modules (guards against the scan silently matching nothing)', () => {
    const files = new Set(actions.map((a) => a.file));
    expect(files.size).toBeGreaterThanOrEqual(12);
    for (const f of ['src/features/library/actions.ts', 'src/features/library/versionActions.ts', 'src/features/sessions/completeActions.ts', 'src/features/pastebin/actions.ts']) {
      expect(files.has(f), `${f} should be scanned`).toBe(true);
    }
    expect(actions.length).toBeGreaterThan(60);
  });

  it('every exported function of a use-server module is analysable (no re-exports or default exports)', () => {
    expect(unanalysable).toEqual([]);
  });

  it('no mutating action is missing a logActivity call', () => {
    const exempt = new Set([...Object.keys(READ_ONLY_ACTIONS), ...Object.keys(NOT_LOGGABLE_ACTIONS)]);
    const offenders = actions.filter((a) => !a.logs && !exempt.has(key(a))).map(key);
    expect(
      offenders,
      `These exported server actions never reach logActivity. Log the mutation in its transaction (no content or key material), ` +
        `or, if it only reads, add it to READ_ONLY_ACTIONS with a reason:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('allowlists stay honest: every entry names a real action, and none of them already logs', () => {
    const byKey = new Map(actions.map((a) => [key(a), a]));
    const stale = [...Object.keys(READ_ONLY_ACTIONS), ...Object.keys(NOT_LOGGABLE_ACTIONS)].filter((k) => !byKey.has(k));
    expect(stale, `allowlist entries without a matching exported action:\n  ${stale.join('\n  ')}`).toEqual([]);

    const nowLogging = [...Object.keys(READ_ONLY_ACTIONS), ...Object.keys(NOT_LOGGABLE_ACTIONS)].filter((k) => byKey.get(k)?.logs);
    expect(nowLogging, `these allowlisted actions now log activity; remove them from the allowlist:\n  ${nowLogging.join('\n  ')}`).toEqual([]);
  });

  it('every allowlist entry has a reason', () => {
    for (const [k, reason] of [...Object.entries(READ_ONLY_ACTIONS), ...Object.entries(NOT_LOGGABLE_ACTIONS)]) {
      expect(reason.trim().length, k).toBeGreaterThan(10);
    }
  });

  it('create_session (logged inside the SQL function, so the static check accepts it) really inserts into activity_log', () => {
    const dir = path.join(ROOT, 'supabase', 'migrations');
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    const fn = /create or replace function public\.create_session\([\s\S]*?\n\$\$;/g;
    const bodies = sql.match(fn) ?? [];
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[bodies.length - 1]).toMatch(/insert into public\.activity_log/);
  });
});

describe('the analyzer itself bites', () => {
  const run = (files: SourceFiles) => analyzeServerActions(files).actions.map((a) => `${a.name}:${a.logs}`).sort();

  it('flags an action whose service never logs, and accepts direct and delegated logging', () => {
    const files: SourceFiles = {
      'src/features/x/actions.ts': `'use server';
        import { addFor, silentFor, deepFor } from './service';
        import { logActivity } from '@/server/activity';
        export async function direct(tx) { await logActivity(tx, { action: 'a' }); }
        export async function delegated() { return addFor(1); }
        export const arrow = async () => addFor(2);
        export async function silent() { return silentFor(1); }
        export async function deep() { return deepFor(1); }
        function notExported() {}`,
      'src/features/x/service.ts': `
        import { logActivity } from '@/server/activity';
        import { helper } from './helpers';
        export function addFor(id) { return withUser(id, async (tx) => { await tx\`insert into t\`; await logActivity(tx, {}); }); }
        export function silentFor(id) { return withUser(id, async (tx) => { await tx\`insert into t\`; }); }
        export function deepFor(id) { return helper(id); }`,
      'src/features/x/helpers.ts': `
        import { logActivity } from '@/server/activity';
        export function helper(id) { return logActivity(id, {}); }`,
    };
    expect(run(files)).toEqual(['arrow:true', 'deep:true', 'delegated:true', 'direct:true', 'silent:false']);
  });

  it('removing the logActivity call from a service turns its action into an offender', () => {
    const base = (log: string) => ({
      'src/features/x/actions.ts': `'use server';\nimport { addFor } from './service';\nexport async function add() { return addFor(1); }`,
      'src/features/x/service.ts': `import { logActivity } from '@/server/activity';\nexport function addFor(id) { return withUser(id, async (tx) => { await tx\`insert into t\`; ${log} }); }`,
    });
    expect(run(base('await logActivity(tx, {});'))).toEqual(['add:true']);
    expect(run(base(''))).toEqual(['add:false']);
  });

  it('does not count a mention of logActivity that is not a call, and ignores non use-server modules', () => {
    const files: SourceFiles = {
      'src/features/x/actions.ts': `'use server';\nimport { logActivity } from '@/server/activity';\nexport async function a() { const f = logActivity; return 1; }`,
      'src/features/x/service.ts': `export function notAnAction() {}`,
    };
    expect(run(files)).toEqual(['a:false']);
  });

  it('reports re-exports it cannot see into', () => {
    const r = analyzeServerActions({ 'src/features/x/actions.ts': `'use server';\nexport { a } from './other';` });
    expect(r.unanalysable).toHaveLength(1);
  });
});
