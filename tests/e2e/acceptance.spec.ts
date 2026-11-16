import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request as playwrightRequest, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';
import {
  ADAPTATION_SUMMARY,
  ADAPTED_SCRIPT,
  AcceptanceClaude,
  ASSESSMENTS,
  EXTRACTED_REQUIREMENTS,
  README_MARKER,
  REMEDIATION_SCRIPT,
  REMEDIATION_SUMMARY,
} from './claude-mock';
import { forensicPanel, inspector, newSession, node, openFlowchart, panel, paragraphIds, pasteReadme, showInspector, signIn } from './support/helpers';

/**
 * Spec 13.1, the minimum end-to-end acceptance test, as ONE walk through all eleven steps. At every
 * step it also asserts that nothing from the session is public: an anonymous visitor's pastebin
 * search finds none of the session's strings, and the session's private routes refuse the visitor.
 *
 * Two modes (see docs/testing.md):
 *  - default: Claude is the local mock (tests/e2e/claude-mock.ts), answers are exact, so are assertions.
 *  - ACCEPTANCE_REAL_CLAUDE=1 (nightly): the real Claude API. Answers vary, so those assertions
 *    check structure only (rows exist, every flag can be acknowledged, downloads equal what was saved).
 *    Everything else is identical.
 */

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'acceptance');
const fixturePath = (name: string) => path.join(FIXTURES, name);
const text = (name: string) => readFileSync(fixturePath(name), 'utf8');

const claude = new AcceptanceClaude();

/**
 * How many high-impact flags the open proposal lists, once its review is loaded. Mock mode knows the
 * exact number and waits for it (web-first); real mode cannot, so it waits for the checklist and the
 * Accept button to render and reads the count after that.
 */
async function flagCount(page: Page, expected: number): Promise<{ boxes: Locator; total: number }> {
  const checklist = inspector(page).getByRole('region', { name: 'High-impact changes' });
  const boxes = checklist.getByRole('checkbox');
  await expect(checklist).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /^Accept/ })).toBeVisible();
  if (!claude.real) await expect(boxes).toHaveCount(expected);
  return { boxes, total: await boxes.count() };
}
const SCRIPT_FILE = 'universal-hardening.ps1';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type SavedVersion = { id: string; version_no: number; content: string; encoding: string; line_ending: string; author: string; change_note: string | null };

/** A script version of the session, straight from the database (the test's own ground truth for "what was saved"). */
async function savedVersion(sessionId: string, filename: string, versionNo: number): Promise<SavedVersion> {
  const rows = await sql<SavedVersion[]>`
    select v.id, v.version_no, v.content, v.encoding, v.line_ending, v.author, v.change_note
    from public.script_versions v join public.scripts s on s.id = v.script_id
    where s.session_id = ${sessionId} and s.filename = ${filename} and v.version_no = ${versionNo}`;
  expect(rows, `${filename} v${versionNo} saved in the session`).toHaveLength(1);
  return rows[0]!;
}

/** The bytes a download of this version must have: its text in its declared encoding (the line endings are in the text). */
function expectedBytes(v: SavedVersion): Buffer {
  expect(['utf-8', 'utf-8-bom'], 'declared encoding of the acceptance scripts').toContain(v.encoding);
  return Buffer.concat([v.encoding === 'utf-8-bom' ? BOM : Buffer.alloc(0), Buffer.from(v.content, 'utf8')]);
}

async function download(page: Page, trigger: Locator): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent('download'), trigger.click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}

/** Sets a flowchart step's status and/or notes in the inspector (opens the node first). */
async function editStep(page: Page, label: string, edit: { status?: 'Complete and Verified'; notes?: string }) {
  await node(page, label).click();
  await showInspector(page);
  const panelOfStep = inspector(page);
  if (edit.status) {
    await panelOfStep.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: edit.status }).click();
    await expect(node(page, label)).toHaveAccessibleName(`${label}, ${edit.status}`);
  }
  if (edit.notes !== undefined) {
    await panelOfStep.getByLabel('Notes').fill(edit.notes);
    await panelOfStep.getByRole('button', { name: 'Save notes' }).click();
    await expect(panelOfStep.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  }
}

/** Attaches a file as evidence to the open step (flowchart inspector). */
async function addEvidence(page: Page, file: string, o: { version?: string; note?: string } = {}) {
  const evidence = inspector(page).getByRole('region', { name: 'Evidence' });
  const before = await evidence.getByTestId('evidence-item').count();
  if (o.version) await evidence.getByLabel('Script version you ran').selectOption({ label: o.version });
  await evidence.getByLabel('Evidence file').setInputFiles(fixturePath(file));
  if (o.note) await evidence.getByLabel('Evidence note').fill(o.note);
  await evidence.getByRole('button', { name: 'Add evidence' }).click();
  await expect(evidence.getByTestId('evidence-item')).toHaveCount(before + 1);
  return evidence;
}

async function uploadLibraryScript(page: Page, file: string, name: string) {
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Upload file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload script' });
  await dialog.getByLabel('File').setInputFiles(fixturePath(file));
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
}

/**
 * The privacy probe: a visitor with no cookies. Everything the session has produced so far (`needles`)
 * must be absent from the public pastebin, and the session's private routes must turn the visitor away.
 */
class AnonymousVisitor {
  readonly needles: string[] = [];
  private constructor(
    private readonly visitor: APIRequestContext,
    private readonly sessionUrl: () => string | null,
  ) {}

  static async create(baseURL: string, sessionUrl: () => string | null) {
    return new AnonymousVisitor(await playwrightRequest.newContext({ baseURL }), sessionUrl);
  }

  /** Strings to look for from now on (they are checked at every later step too). */
  watch(...strings: string[]) {
    this.needles.push(...strings);
  }

  async expectNothingPublic(where: string, extraRoutes: string[] = []) {
    for (const needle of this.needles) {
      const res = await this.visitor.get(`/p?q=${encodeURIComponent(needle.slice(0, 200))}`);
      expect(res.status(), `${where}: pastebin search status`).toBe(200);
      const html = await res.text();
      // Booleans, so a failure names the leak without dumping the page.
      const what = JSON.stringify(needle.slice(0, 60));
      expect(html.includes('No pastes match'), `${where}: public search for ${what} must find nothing`).toBe(true);
      expect(html.includes('aria-label="Public pastes"'), `${where}: public search for ${what} must list no paste`).toBe(false);
    }
    // The unfiltered listing and the sitemap name no session content either.
    const listing = await (await this.visitor.get('/p')).text();
    const sitemap = await (await this.visitor.get('/sitemap.xml')).text();
    for (const needle of this.needles) {
      expect(listing.includes(needle), `${where}: /p listing names ${JSON.stringify(needle.slice(0, 60))}`).toBe(false);
      expect(sitemap.includes(needle), `${where}: sitemap names ${JSON.stringify(needle.slice(0, 60))}`).toBe(false);
    }
    // Private routes refuse a visitor with no session.
    const session = this.sessionUrl();
    for (const route of [...(session ? [session] : []), ...extraRoutes]) {
      const res = await this.visitor.get(route, { maxRedirects: 0 });
      expect(res.status(), `${where}: anonymous GET ${route}`).not.toBe(200);
      const body = await res.text();
      for (const needle of this.needles) expect(body.includes(needle), `${where}: anonymous GET ${route} leaked ${JSON.stringify(needle.slice(0, 60))}`).toBe(false);
    }
  }

  async dispose() {
    await this.visitor.dispose();
  }
}

test('v1.0 acceptance: spec 13.1, all eleven steps', async ({ page, browser, baseURL }) => {
  test.setTimeout(claude.real ? 1_800_000 : 240_000);
  const CLAUDE_WAIT = claude.real ? 240_000 : 30_000;
  await claude.reset();

  const run = randomBytes(4).toString('hex');
  const title = `Harbor Clinic acceptance ${run}`;
  const readme = text('README.md');
  const universal = text(SCRIPT_FILE).replace(/^﻿/, '');
  let sessionId = '';
  let email = '';
  const downloads = new Map<string, Buffer>(); // what the user downloaded and ran, to compare after reopening

  const visitor = await AnonymousVisitor.create(baseURL!, () => (sessionId ? `/app/sessions/${sessionId}` : null));
  try {
    // A control paste proves the search would find a published string, so "found nothing" below means something.
    await test.step('privacy control: the anonymous search finds a public paste, so an empty result is meaningful', async () => {
      const [{ id: owner }] = await sql<{ id: string }[]>`
        insert into auth.users (id, email) values (gen_random_uuid(), ${`control-${run}@example.test`}) returning id`;
      const marker = `control-paste-${run}`;
      await sql`insert into paste.pastes (slug, owner_id, title, content, language, visibility)
                values (${`ac${run}`}, ${owner}, ${marker}, ${marker}, 'text', 'public')`;
      const control = await playwrightRequest.newContext({ baseURL: baseURL! });
      const html = await (await control.get(`/p?q=${marker}`)).text();
      await control.dispose();
      expect(html).toContain('aria-label="Public pastes"');
      expect(html).toContain(marker);
    });

    await test.step('setup: the universal script (and a decoy) are uploaded to the library', async () => {
      email = await signIn(page);
      await uploadLibraryScript(page, SCRIPT_FILE, 'Harbor universal baseline');
      await uploadLibraryScript(page, 'decoy-linux-hardening.sh', 'Decoy Linux baseline');
      const row = page.getByRole('row').filter({ hasText: 'Harbor universal baseline' });
      await expect(row).toContainText('v1');
      await expect(row).toContainText('Windows');
      // Uploaded bytes come back identical (UTF-8 BOM, CRLF).
      const original = await download(page, row.getByRole('link', { name: 'Download' }));
      expect(original.name).toBe(SCRIPT_FILE);
      expect(original.bytes.equals(readFileSync(fixturePath(SCRIPT_FILE)))).toBe(true);
      visitor.watch('Universal Windows hardening baseline', 'Harbor universal baseline', 'decoy-linux-baseline-9f3a');
      await visitor.expectNothingPublic('library setup');
    });

    await test.step('1. create a new hardening session', async () => {
      sessionId = await newSession(page, title);
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Claude' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Flowchart' })).toBeVisible();
      visitor.watch(title);
      await visitor.expectNothingPublic('step 1');
    });

    await test.step('2. paste the README', async () => {
      await pasteReadme(page, readme);
      const readmePanel = panel(page);
      await expect(page.getByRole('tab', { name: 'README' })).toHaveAttribute('aria-selected', 'true');
      for (const line of ['Authorized administrators are alice and bob only.', 'The built-in Guest account must be disabled.', 'Remote Desktop must stay disabled on this workstation.']) {
        await expect(readmePanel.getByText(line, { exact: false })).toBeVisible();
      }
      await showInspector(page);
      await expect(inspector(page).getByTestId('readme-step-status')).toHaveText('In Progress');
      visitor.watch(README_MARKER, 'Harbor Clinic front-desk workstation', 'patient check-in forms', 'which local account was created after the image was built');
      await visitor.expectNothingPublic('step 2');
    });

    await test.step('3. select the previously uploaded universal script', async () => {
      await page.goto('/app/library');
      await page.getByRole('row').filter({ hasText: 'Harbor universal baseline' }).getByRole('button', { name: 'Use in Claude' }).click();
      await page.getByRole('menuitem', { name: title }).click();
      await expect(page).toHaveURL(new RegExp(`/app/sessions/${sessionId}$`));
      await page.getByRole('tab', { name: 'Claude' }).click();
      await page.getByRole('button', { name: /Context/ }).click();
      const picker = panel(page).getByRole('region', { name: 'Context for Claude' });
      await expect(picker.getByRole('checkbox', { name: /Harbor universal baseline · v1/ })).toBeChecked();
      await expect(picker.getByRole('checkbox', { name: /Decoy Linux baseline/ })).toHaveCount(0);
      await visitor.expectNothingPublic('step 3');
    });

    const matrix = () => panel(page).getByRole('table', { name: 'Requirements' });
    const row = (t: string) => matrix().getByRole('row').filter({ hasText: t });
    const proposalTab = () => page.getByRole('tab', { name: `${SCRIPT_FILE} · proposal` });

    await test.step('4. ask Claude to adapt the script to the README', async () => {
      await page.getByRole('tab', { name: 'README' }).click();
      await panel(page).getByRole('button', { name: 'Requirements' }).click();
      await claude.extraction(paragraphIds(readme));
      await panel(page).getByRole('button', { name: 'Extract requirements' }).first().click();
      await expect(matrix().getByRole('row').nth(1)).toBeVisible({ timeout: CLAUDE_WAIT });
      if (!claude.real) await expect(matrix().getByRole('row')).toHaveCount(EXTRACTED_REQUIREMENTS.length + 1);
      await expect(matrix().getByText('Detected', { exact: true }).first()).toBeVisible();

      await claude.coverage();
      await panel(page).getByRole('button', { name: 'Assess coverage' }).click();
      const assess = page.getByRole('dialog', { name: 'Assess coverage' });
      await assess.getByLabel('Script version').selectOption({ label: 'Harbor universal baseline · v1' });
      await assess.getByRole('button', { name: 'Assess coverage' }).click();
      await expect(assess).toBeHidden({ timeout: CLAUDE_WAIT });
      // The assessment is applied after the dialog closes: wait for the matrix to show it.
      if (claude.real) {
        // Claude may leave a requirement unassessed; at least one verdict must have landed.
        const rows = (await matrix().getByRole('row').count()) - 1;
        await expect.poll(() => matrix().getByText('Detected', { exact: true }).count(), { timeout: CLAUDE_WAIT }).toBeLessThan(rows);
      } else {
        await expect(matrix().getByText('Detected', { exact: true })).toHaveCount(0, { timeout: CLAUDE_WAIT });
      }

      await claude.adaptation();
      await panel(page).getByRole('button', { name: 'Propose adaptation' }).click();
      const propose = page.getByRole('dialog', { name: 'Propose adaptation' });
      await propose.getByRole('button', { name: 'Propose adaptation' }).click();
      await expect(propose).toBeHidden({ timeout: CLAUDE_WAIT });
      await expect(proposalTab()).toHaveAttribute('aria-selected', 'true', { timeout: CLAUDE_WAIT });
      await expect(panel(page).getByText('Pending review')).toBeVisible({ timeout: CLAUDE_WAIT });

      // Claude saw only what was selected: the README and the chosen script, never the decoy.
      for (const req of await claude.requests()) {
        expect(JSON.stringify(req.body)).not.toContain('decoy-linux-baseline-9f3a');
        expect(req.apiKey).toBe('test-key'); // the server's key; the browser never had one
      }
      if (!claude.real) {
        const sent = (await claude.requests()).map((r) => JSON.stringify(r.body));
        expect(sent).toHaveLength(3);
        expect(sent[0]).toContain(README_MARKER);
        expect(sent[1]).toContain('Starting baseline hardening');
        expect(sent[2]).toContain('Starting baseline hardening');
      }
      const serverKey = claude.real ? process.env.ANTHROPIC_API_KEY : 'test-key';
      if (serverKey) expect((await page.content()).includes(serverKey), 'the server-side Claude key never reaches the browser').toBe(false);
      await visitor.expectNothingPublic('step 4');
    });

    await test.step('5. review the requirements matrix and the proposed code changes', async () => {
      // The matrix: every row cites its README paragraph, is Proposed (never Verified), and has a coverage verdict.
      await page.getByRole('tab', { name: 'Requirements' }).click();
      await expect(matrix().getByText('Verified', { exact: true })).toHaveCount(0);
      if (claude.real) {
        await expect(matrix().getByText('Proposed', { exact: true }).first()).toBeVisible();
      } else {
        await expect(matrix().getByRole('row')).toHaveCount(EXTRACTED_REQUIREMENTS.length + 1);
        const verdict = { covered: 'Covered', missing: 'Missing', manual: 'Manual task' } as const;
        for (const [i, r] of EXTRACTED_REQUIREMENTS.entries()) {
          const line = row(r.text);
          await expect(line.getByRole('button', { name: `¶ ${r.paragraph + 1}` })).toBeVisible();
          await expect(line.getByText(verdict[ASSESSMENTS[i]!.coverage], { exact: true })).toBeVisible();
          await expect(line.getByText('Proposed', { exact: true })).toBeVisible();
        }
        await expect(row('Remove administrators other than alice and bob')).toContainText('Remove every administrator except alice and bob.');
        // The two potentially disruptive requirements ask for a person's review.
        await expect(matrix().getByTestId('disruptive-marker')).toHaveCount(2);
      }
      // Reviewing a disruptive requirement is explicit.
      for (let left = await matrix().getByRole('button', { name: /^Mark reviewed/ }).count(); left > 0; left--) {
        await matrix().getByRole('button', { name: /^Mark reviewed/ }).first().click();
        await expect(matrix().getByRole('button', { name: /^Mark reviewed/ })).toHaveCount(left - 1);
      }
      await expect(matrix().getByTestId('disruptive-marker')).toHaveCount(0);

      // The proposed code changes: a side-by-side diff of the library script and Claude's version.
      await proposalTab().click();
      await expect(panel(page).locator('.monaco-diff-editor')).toBeVisible();
      await expect(panel(page).getByText(/Accepting saves a session copy of v1 with the right-hand side as v2; the library script is not changed/)).toBeVisible();
      if (!claude.real) {
        await expect(panel(page).getByText(ADAPTATION_SUMMARY)).toBeVisible();
        await expect(panel(page).locator('.line-insert').first()).toBeVisible();
        await expect(panel(page).locator('.line-delete').first()).toBeVisible(); // the spooler lines Claude removed
        const diff = panel(page).locator('.monaco-diff-editor');
        await expect(diff).toContainText('Remove-LocalGroupMember');
        await expect(diff).toContainText('Set-Service -Name');
      }

      // Accept stays disabled until every high-impact change is acknowledged.
      await showInspector(page);
      const { boxes, total } = await flagCount(page, 3); // Guest account, administrator removal, Remote Desktop
      const accept = panel(page).getByRole('button', { name: /^Accept/ });
      if (total > 0) {
        await expect(accept).toHaveText(`Accept (0 of ${total} acknowledged)`);
        await expect(accept).toBeDisabled();
        for (let i = 0; i < total; i++) await boxes.nth(i).click();
        await expect(accept).toHaveText(`Accept (${total} of ${total} acknowledged)`);
      }
      await expect(accept).toBeEnabled();
      await visitor.expectNothingPublic('step 5');
    });

    let adapted: SavedVersion;
    await test.step('6. save the approved adaptation and download it', async () => {
      await panel(page).getByRole('button', { name: /^Accept/ }).click();
      await expect(panel(page).getByText(new RegExp(`Accepted as ${SCRIPT_FILE.replace('.', '\\.')} v2`))).toBeVisible();
      await expect(panel(page).getByRole('button', { name: /^Accept/ })).toHaveCount(0);

      adapted = await savedVersion(sessionId, SCRIPT_FILE, 2);
      expect(adapted.author).toBe('claude');
      expect(adapted.encoding).toBe('utf-8-bom'); // the universal script's encoding is kept
      expect(adapted.line_ending).toBe('crlf');
      if (!claude.real) {
        expect(adapted.content).toBe(ADAPTED_SCRIPT.replace(/\n/g, '\r\n'));
        expect(adapted.change_note).toBe(`Claude adaptation: ${ADAPTATION_SUMMARY}`);
      }

      // The download is exactly the saved text in its declared encoding.
      const file = await download(page, panel(page).getByRole('link', { name: 'Download v2' }));
      expect(file.name).toBe(SCRIPT_FILE);
      expect(file.bytes.equals(expectedBytes(adapted))).toBe(true);
      downloads.set('adapted v2', file.bytes);

      // The session's copy has both versions; the library script was never touched.
      const v1 = await savedVersion(sessionId, SCRIPT_FILE, 1);
      expect(v1.content).toBe(universal);
      const [library] = await sql<{ versions: number; content: string }[]>`
        select count(*)::int as versions, min(v.content) as content
        from public.script_versions v join public.scripts s on s.id = v.script_id
        where s.session_id is null and s.name = 'Harbor universal baseline' and s.owner_id = (select owner_id from public.sessions where id = ${sessionId})`;
      expect(library).toEqual({ versions: 1, content: universal });

      visitor.watch('Disable-LocalUser', 'Remove-LocalGroupMember', 'fDenyTSConnections');
      await visitor.expectNothingPublic('step 6');
    });

    await test.step('7. run the script locally: upload its output and the LEADS results', async () => {
      await openFlowchart(page);
      await node(page, 'Run hardening script').click();
      await showInspector(page);
      const evidence = await addEvidence(page, 'run-output-hardening.txt', { version: 'Harbor universal baseline · v2', note: `Ran as Administrator on the image ${run}` });
      const item = evidence.getByTestId('evidence-item');
      await expect(item).toContainText('Execution output');
      await expect(item).toContainText('Output of Harbor universal baseline · v2');
      await expect(item).toContainText(`Ran as Administrator on the image ${run}`);
      await expect(item).toContainText('Cycle 1');
      const output = await download(page, item.getByRole('link', { name: 'Download run-output-hardening.txt' }));
      expect(output.bytes.equals(readFileSync(fixturePath('run-output-hardening.txt')))).toBe(true);

      await node(page, 'Run LEADS').click();
      await inspector(page).getByRole('button', { name: 'Open LEADS reports' }).click();
      await panel(page).getByLabel('LEADS report file').setInputFiles(fixturePath('leads-results.txt'));
      await expect(page.getByRole('tab', { name: 'Report · leads-results.txt' })).toHaveAttribute('aria-selected', 'true');
      // The score is recorded as the report states it, and labelled as unverified.
      await expect(panel(page).getByText('Cycle 1', { exact: true })).toBeVisible();
      await expect(panel(page).getByText('Parser: generic')).toBeVisible();
      await expect(panel(page).getByText('Reported score:')).toContainText('62 / 100');
      await expect(panel(page).getByText(/not verified by Armadillo/)).toBeVisible();
      await expect(panel(page).getByLabel('Finding counts')).toHaveText('Fail 2 · Pass 4 · Unknown 0');
      await expect(panel(page).getByRole('table').getByRole('row')).toHaveCount(7); // header + 6 findings
      await expect(panel(page).getByRole('table').getByText('Password never expires for local user bob')).toBeVisible();
      const [saved] = await sql<{ score: string; cycle_no: number; parser: string }[]>`
        select score, cycle_no, parser from public.leads_reports where session_id = ${sessionId}`;
      expect({ score: Number(saved!.score), cycle: saved!.cycle_no, parser: saved!.parser }).toEqual({ score: 62, cycle: 1, parser: 'generic' });
      await openFlowchart(page);
      await expect(node(page, 'Run LEADS')).toHaveAccessibleName('Run LEADS, In Progress');

      visitor.watch('Password never expires for local user bob', 'Audit policy does not record logon failures', 'Total: 62 out of 100', 'Findings parsed', `Ran as Administrator on the image ${run}`);
      await visitor.expectNothingPublic('step 7');
    });

    await test.step('8. Claude proposes a targeted remediation', async () => {
      await page.getByRole('tab', { name: 'Report · leads-results.txt' }).click();
      await claude.remediation();
      await panel(page).getByRole('button', { name: 'Propose remediation' }).click();
      await expect(page.getByRole('tab', { name: 'Remediation — Cycle 1 · proposal' })).toHaveAttribute('aria-selected', 'true', { timeout: CLAUDE_WAIT });
      await expect(panel(page).getByRole('heading', { name: 'Remediation — Cycle 1: targeted remediation' })).toBeVisible({ timeout: CLAUDE_WAIT });
      await expect(panel(page).getByText('Pending review')).toBeVisible();
      await expect(panel(page).getByText(/new session script, “Remediation — Cycle 1” \(v1\)/)).toBeVisible();
      await expect(panel(page).locator('.monaco-diff-editor')).toBeVisible();
      await expect(panel(page).locator('.line-insert').first()).toBeVisible();
      if (!claude.real) {
        await expect(panel(page).getByText(REMEDIATION_SUMMARY)).toBeVisible();
        await expect(panel(page).locator('.monaco-diff-editor')).toContainText('PasswordNeverExpires');
        // Only the failing findings went to Claude, in an untrusted-data block.
        const sent = JSON.stringify((await claude.requests()).at(-1)!.body);
        const findings = /type=\\"findings\\"[^<]*>([\s\S]*?)<\/untrusted_document/.exec(sent)?.[1] ?? '';
        expect(findings).toContain('Password never expires for local user bob');
        expect(findings).toContain('Audit policy does not record logon failures');
        expect(findings).not.toContain('Guest account disabled');
        expect(findings).not.toContain('Print Spooler is running');
        expect(sent).not.toContain('decoy-linux-baseline-9f3a');
      }
      visitor.watch('Targeted remediation, cycle 1', 'PasswordNeverExpires');
      await visitor.expectNothingPublic('step 8');
    });

    let remediation: SavedVersion;
    await test.step('9. review the remediation, download the follow-up script and run it', async () => {
      await showInspector(page);
      const { boxes, total } = await flagCount(page, 1); // the password-policy change
      const accept = panel(page).getByRole('button', { name: /^Accept/ });
      if (total > 0) await expect(accept).toBeDisabled();
      for (let i = 0; i < total; i++) await boxes.nth(i).click();
      await expect(accept).toBeEnabled();
      await accept.click();
      await expect(panel(page).getByText(/Accepted as remediation-cycle-1\.ps1 v1, a new session script \(Remediation — Cycle 1\)\. Harbor universal baseline is unchanged\./)).toBeVisible();

      remediation = await savedVersion(sessionId, 'remediation-cycle-1.ps1', 1);
      expect(remediation.author).toBe('claude');
      if (!claude.real) {
        expect(remediation.content.replace(/\r\n/g, '\n')).toBe(REMEDIATION_SCRIPT);
        expect(remediation.change_note).toContain(REMEDIATION_SUMMARY);
      }
      const file = await download(page, panel(page).getByRole('link', { name: 'Download v1' }));
      expect(file.name).toBe('remediation-cycle-1.ps1');
      expect(file.bytes.equals(expectedBytes(remediation))).toBe(true);
      downloads.set('remediation v1', file.bytes);
      // The hardening script is unchanged by the remediation: still v1 and v2 only.
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.script_versions v join public.scripts s on s.id = v.script_id
        where s.session_id = ${sessionId} and s.filename = ${SCRIPT_FILE}`;
      expect(n).toBe(2);

      // Run it locally, then upload its output against the version that was run.
      await openFlowchart(page);
      await node(page, 'Targeted remediation').click();
      await expect(inspector(page).getByRole('button', { name: 'Open remediation script' })).toBeVisible();
      const evidence = await addEvidence(page, 'run-output-remediation.txt', { version: 'Remediation — Cycle 1 · v1' });
      await expect(evidence.getByTestId('evidence-item')).toContainText('Output of Remediation — Cycle 1 · v1');

      visitor.watch('Set-LocalUser', 'auditpol', 'Remediation complete');
      await visitor.expectNothingPublic('step 9');
    });

    const notes = {
      'Open README': `README pasted from the Harbor Clinic packet ${run}`,
      'Claude adaptation': `Adaptation reviewed against every README paragraph ${run}`,
      'Run hardening script': `Ran v2 as Administrator, no reboot needed ${run}`,
      'Targeted remediation': `Ran remediation cycle 1 after the first LEADS report ${run}`,
    } as const;
    const forensicQuestion = 'Which local account was created after the image was built, and who created it?';
    const forensicAnswer = `The account svc_backup, created by eve ${run}`;
    const evidenceByStep = [
      { step: 'Run hardening script', file: 'run-output-hardening.txt' },
      { step: 'Targeted remediation', file: 'run-output-remediation.txt' },
      { step: 'Check final points', file: 'verification-evidence.txt' },
      { step: 'Submit final', file: 'verification-evidence.txt' },
    ] as const;
    const ALL_STEPS = ['Open README', 'Forensic questions', 'Claude adaptation', 'Run hardening script', 'Run LEADS', 'Inspect LEADS report', 'Targeted remediation', 'Check final points', 'Submit final'];
    const DONE = 'Complete and Verified' as const;
    let matrixBefore = '';

    await test.step('10. upload verification evidence and complete the flowchart', async () => {
      await openFlowchart(page);

      // Forensic questions run alongside hardening; this one is answered, so submitting needs no override.
      await node(page, 'Forensic questions').click();
      await showInspector(page);
      const forensic = forensicPanel(page);
      await forensic.getByLabel('New question').fill(forensicQuestion);
      await forensic.getByRole('button', { name: 'Add question' }).click();
      await expect(forensic.getByTestId('forensic-count')).toHaveText('0 of 1 answered');
      await forensic.getByRole('button', { name: 'Answer question 1' }).click();
      await forensic.getByLabel('Answer to question 1').fill(forensicAnswer);
      await forensic.getByRole('button', { name: 'Save answer' }).click();
      await expect(forensic.getByTestId('forensic-count')).toHaveText('1 of 1 answered');

      // Verification evidence for the final point check, and the points the scoring page shows.
      await node(page, 'Check final points').click();
      const checkEvidence = await addEvidence(page, 'verification-evidence.txt', { note: `Scoreboard shows 100 points ${run}` });
      await expect(checkEvidence.getByTestId('evidence-item')).toContainText('Verification');
      const points = inspector(page).getByRole('region', { name: 'Final points' });
      await points.getByLabel('Points', { exact: true }).fill('100');
      await points.getByLabel('Target (optional)').fill('100');
      await points.getByRole('button', { name: 'Record points' }).click();
      await expect(points.getByTestId('reported-points')).toHaveText('100');
      await expect(points.getByTestId('target-points')).toHaveText('100');

      // Every step Complete and Verified (each of those with evidence has it in this cycle); notes on four of them.
      for (const label of ALL_STEPS.filter((l) => l !== 'Submit final')) {
        await editStep(page, label, { status: DONE, notes: label in notes ? notes[label as keyof typeof notes] : undefined });
      }
      await expect(node(page, 'Submit final')).toHaveAccessibleName('Submit final, Not Started');

      // The decision node: the user declares the completion condition met.
      await page.getByRole('button', { name: 'Final point check, decision' }).click();
      await inspector(page).getByRole('button', { name: 'Mark complete' }).click();
      const decide = page.getByRole('dialog', { name: 'Mark this audit cycle complete?' });
      await decide.getByRole('button', { name: 'Mark complete' }).click();
      await expect(decide).toBeHidden();
      await expect(inspector(page).getByRole('region', { name: 'Audit cycles' })).toContainText('Cycle 1 · Marked complete');
      await expect(node(page, 'Submit final')).toHaveAccessibleName('Submit final, In Progress');

      // Submit final: verification evidence first, then the confirmation freezes the session.
      await node(page, 'Submit final').click();
      await addEvidence(page, 'verification-evidence.txt', { note: `Final scoreboard capture ${run}` });
      const submit = inspector(page).getByRole('region', { name: 'Final submission' });
      await expect(submit.getByTestId('submit-forensic-count')).toHaveText('1 of 1 answered');
      await submit.getByRole('button', { name: 'Submit final' }).click();
      const confirm = page.getByRole('dialog', { name: 'Submit this session?' });
      await expect(confirm).toContainText('Submitting freezes this session');
      await confirm.getByRole('button', { name: 'Submit and freeze session' }).click();
      await expect(confirm).toBeHidden();
      await expect(page.getByTestId('completed-banner')).toContainText('Completed');
      for (const label of ALL_STEPS) await expect(node(page, label)).toHaveAccessibleName(`${label}, ${DONE}`);
      await expect(page.getByTestId('completed-note')).toContainText('Completed');

      // What the matrix shows now is what must come back after signing in again.
      await page.getByRole('tab', { name: 'Requirements' }).click();
      matrixBefore = await matrix().innerText();

      visitor.watch(...Object.values(notes), forensicAnswer, 'Final scoreboard capture', 'Scoreboard shows 100 points', 'Findings still failing: none', 'Logon failure auditing enabled');
      await visitor.expectNothingPublic('step 10');
    });

    await test.step('11. sign out, sign in, reopen the session: every document, version, note and status is intact', async () => {
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/login$/);
      // Signed out on the page itself, not just redirected once: the private session route now sends this browser to /login.
      await page.goto(`/app/sessions/${sessionId}`);
      await expect(page).toHaveURL(/\/login/);
      await visitor.expectNothingPublic('signed out');
      await signIn(page, email);

      // The session is listed as completed and resumes from the dashboard.
      const card = page.getByRole('main').getByRole('listitem').filter({ hasText: title });
      await expect(card).toContainText('Completed');
      await card.getByRole('link', { name: 'Resume' }).click();
      await expect(page).toHaveURL(new RegExp(`/app/sessions/${sessionId}$`));
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expect(page.getByTestId('completed-banner')).toContainText('This session is read-only');
      const open = (tab: string, params: Record<string, string> = {}) =>
        page.goto(`/app/sessions/${sessionId}?${new URLSearchParams({ tab, ...params })}`);

      // README: every paragraph.
      await open('readme');
      await expect(page.getByRole('tab', { name: 'README' })).toHaveAttribute('aria-selected', 'true');
      for (const [i, id] of paragraphIds(readme).entries()) {
        await expect(panel(page).locator(`#seg-${id}`), `README paragraph ${i + 1}`).toHaveText(readme.split('\n\n')[i]!.trim());
      }

      // Requirements matrix: exactly as it was.
      await open('requirements');
      await expect(matrix().getByRole('row').nth(1)).toBeVisible();
      expect(await matrix().innerText()).toBe(matrixBefore);

      // Script versions: the session's hardening script (v1 from the library, v2 Claude's) and the remediation script.
      const scripts = await sql<{ id: string; filename: string }[]>`select id, filename from public.scripts where session_id = ${sessionId} order by created_at`;
      expect(scripts.map((x) => x.filename)).toEqual([SCRIPT_FILE, 'remediation-cycle-1.ps1']);
      for (const [script, versions, key] of [
        [scripts[0]!, 2, 'adapted v2'],
        [scripts[1]!, 1, 'remediation v1'],
      ] as const) {
        await open('script', { id: script.id, name: script.filename });
        const history = page.getByRole('region', { name: 'Version history' });
        await expect(history.getByRole('listitem')).toHaveCount(versions);
        const latest = await download(page, history.getByRole('link', { name: `Download v${versions}` }));
        expect(latest.name).toBe(script.filename);
        expect(latest.bytes.equals(downloads.get(key)!), `${script.filename} v${versions} downloads as before`).toBe(true);
      }
      await open('script', { id: scripts[0]!.id, name: SCRIPT_FILE });
      await expect(page.getByRole('region', { name: 'Version history' }).getByRole('listitem').filter({ hasText: 'v2' })).toContainText('Claude adaptation:');
      const cmdlet = /[A-Z][a-z]+-[A-Z][A-Za-z]+/.exec(adapted.content)?.[0]; // e.g. Write-Host: some of v2's own text is shown
      if (cmdlet) await expect(page.getByRole('region', { name: 'Script content' }).locator('.monaco-editor').first()).toContainText(cmdlet);

      // Proposals: both decided, neither can be decided again.
      const proposals = await sql<{ id: string; kind: string; status: string }[]>`select id, kind, status from public.proposals where session_id = ${sessionId} order by created_at`;
      expect(proposals.map((x) => `${x.kind}:${x.status}`)).toEqual(['adaptation:accepted', 'remediation:accepted']);
      await open('proposal', { id: proposals[0]!.id, name: `${SCRIPT_FILE} · proposal` });
      await expect(panel(page).getByText(new RegExp(`Accepted as ${SCRIPT_FILE.replace('.', '\\.')} v2`))).toBeVisible();
      await expect(panel(page).getByRole('button', { name: /^Accept/ })).toHaveCount(0);
      await expect(panel(page).getByRole('button', { name: 'Reject' })).toHaveCount(0);
      await open('proposal', { id: proposals[1]!.id, name: 'Remediation — Cycle 1 · proposal' });
      await expect(panel(page).getByText(/Accepted as remediation-cycle-1\.ps1 v1/)).toBeVisible();
      await expect(panel(page).getByRole('button', { name: /^Accept/ })).toHaveCount(0);

      // The LEADS report and its score.
      const [report] = await sql<{ id: string }[]>`select id from public.leads_reports where session_id = ${sessionId}`;
      await open('report', { id: report!.id, name: 'leads-results.txt' });
      await expect(panel(page).getByText('Reported score:')).toContainText('62 / 100');
      await expect(panel(page).getByLabel('Finding counts')).toHaveText('Fail 2 · Pass 4 · Unknown 0');
      await expect(panel(page).getByRole('table').getByText('Audit policy does not record logon failures')).toBeVisible();

      // The flowchart: statuses, notes, forensic answer, points and evidence.
      await open('flowchart');
      await expect(page.getByTestId('flow-canvas')).toBeVisible();
      for (const label of ALL_STEPS) await expect(node(page, label)).toHaveAccessibleName(`${label}, ${DONE}`);
      for (const [label, note] of Object.entries(notes)) {
        await node(page, label).click();
        await showInspector(page);
        await expect(inspector(page).getByLabel('Notes'), `notes of ${label}`).toHaveValue(note);
      }
      await node(page, 'Forensic questions').click();
      const forensic = forensicPanel(page);
      await expect(forensic.getByTestId('forensic-count')).toHaveText('1 of 1 answered');
      await expect(forensic.getByText(forensicQuestion)).toBeVisible();
      await expect(forensic.getByText(forensicAnswer)).toBeVisible();
      await node(page, 'Check final points').click();
      await expect(inspector(page).getByTestId('reported-points')).toHaveText('100');
      await expect(inspector(page).getByTestId('target-points')).toHaveText('100');
      for (const { step, file } of evidenceByStep) {
        await node(page, step).click();
        const item = inspector(page).getByTestId('evidence-item');
        await expect(item, `evidence of ${step}`).toHaveCount(1);
        const back = await download(page, item.getByRole('link', { name: `Download ${file}` }));
        expect(back.bytes.equals(readFileSync(fixturePath(file))), `${file} of ${step} downloads as uploaded`).toBe(true);
      }
      await node(page, 'Run hardening script').click();
      await expect(inspector(page).getByTestId('evidence-item')).toContainText(`Ran as Administrator on the image ${run}`);
      await node(page, 'Submit final').click();
      await expect(inspector(page).getByRole('list', { name: 'Submit final history' }).getByRole('listitem').first()).toContainText('In Progress → Complete and Verified');
      await expect(inspector(page).getByRole('region', { name: 'Final submission' })).toContainText('The session is completed and read-only');

      // Sessions & Reports lists the cycle with its report and points.
      await page.goto('/app/reports');
      const listed = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem').filter({ hasText: title }).first();
      await expect(listed).toContainText('Completed · Windows · Cycle 1');
      await listed.locator('summary').click();
      await expect(listed.getByRole('region', { name: 'Cycle 1' })).toContainText('Reported points: 100 of 100');
      await expect(listed.getByRole('region', { name: 'Cycle 1' })).toContainText('leads-results.txt');

      // The library: the universal script is still v1 and downloads byte for byte as uploaded.
      await page.goto('/app/library');
      const lib = page.getByRole('row').filter({ hasText: 'Harbor universal baseline' });
      await expect(lib).toHaveCount(1);
      await expect(lib).toContainText('v1');
      const kept = await download(page, lib.getByRole('link', { name: 'Download' }));
      expect(kept.bytes.equals(readFileSync(fixturePath(SCRIPT_FILE)))).toBe(true);
    });

    await test.step('private stays private: nothing from the session is public, for visitors or for other users', async () => {
      // An anonymous browser: search for strings from the README, the script, the report and the notes.
      const anonymous = await browser.newContext();
      const stranger = await anonymous.newPage();
      for (const needle of [
        'patient check-in forms', // README
        'Remove-LocalGroupMember', // script
        'Password never expires for local user bob', // report
        notes['Run hardening script'], // notes
        forensicAnswer,
      ]) {
        await stranger.goto(`/p?q=${encodeURIComponent(needle)}`);
        await expect(stranger.getByText('No pastes match'), `anonymous /p search for ${needle}`).toBeVisible();
        await expect(stranger.getByRole('list', { name: 'Public pastes' })).toHaveCount(0);
      }
      await anonymous.close();

      // Everything the session ever held, through the API-level probe, plus the private download routes.
      const versions = await sql<{ id: string }[]>`select v.id from public.script_versions v join public.scripts s on s.id = v.script_id where s.session_id = ${sessionId}`;
      const files = await sql<{ id: string }[]>`select id from public.evidence where session_id = ${sessionId}`;
      await visitor.expectNothingPublic('end', [...versions.map((v) => `/api/files/download/${v.id}`), ...files.map((f) => `/api/files/evidence/${f.id}`)]);
      expect(await sql`select 1 from paste.pastes where title like ${`%${run}%`} and title not like 'control-paste-%'`).toHaveLength(0);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from paste.pastes p join auth.users u on u.id = p.owner_id where u.email = ${email}`;
      expect(n, 'this user never published anything').toBe(0);

      // Another signed-in user cannot open it either.
      const other = await browser.newContext();
      const otherPage = await other.newPage();
      await signIn(otherPage);
      expect((await otherPage.goto(`/app/sessions/${sessionId}`))?.status()).toBe(404);
      await other.close();
    });
  } finally {
    await visitor.dispose();
  }
});
