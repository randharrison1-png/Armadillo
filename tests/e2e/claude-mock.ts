import { AnthropicMockClient, E2E_ANTHROPIC_MOCK_PORT, type MockResponse } from '../support/anthropic-mock';

/**
 * Deterministic Claude answers for the v1.0 acceptance flow (tests/e2e/acceptance.spec.ts).
 *
 * Each answer is a forced tool call, exactly what the app asks Claude for (src/server/claude/schemas.ts):
 * record_requirements, record_coverage, record_adaptation, record_remediation. They are queued one at a
 * time, right before the UI action that triggers them, and matched on the tool name in the request's
 * instruction (record_requirements: on a README phrase), so a late or repeated request can never take
 * another step's answer.
 *
 * With ACCEPTANCE_REAL_CLAUDE=1 (nightly job) nothing is queued: the app talks to the real API and
 * the spec asserts structure only. `claude.real` tells the spec which mode it is in.
 */

export const REAL_CLAUDE = process.env.ACCEPTANCE_REAL_CLAUDE === '1';

/** Strings from the fixtures and from Claude's canned answers that must stay private (never in the pastebin). */
export const README_MARKER = 'HC-FRONTDESK-0417';

export const EXTRACTED_REQUIREMENTS = [
  { text: 'Remove administrators other than alice and bob', paragraph: 2, category: 'accounts', automatable: true, disruptive: true },
  { text: 'Disable the built-in Guest account', paragraph: 3, category: 'accounts', automatable: true, disruptive: false },
  { text: 'Keep Remote Desktop disabled', paragraph: 4, category: 'remote_access', automatable: true, disruptive: false },
  { text: 'Keep the Print Spooler service running', paragraph: 5, category: 'services', automatable: true, disruptive: true },
  { text: 'Answer forensic question 1 about the new local account', paragraph: 6, category: 'forensics', automatable: false, disruptive: false },
] as const;

/** Coverage of the universal script (it disables the spooler and never touches the administrators). */
export const ASSESSMENTS = [
  { requirement_id: 'R1', coverage: 'missing', suggestion: 'Remove every administrator except alice and bob.', disruptive: true, automatable: true },
  { requirement_id: 'R2', coverage: 'covered', disruptive: false, automatable: true },
  { requirement_id: 'R3', coverage: 'covered', disruptive: false, automatable: true },
  { requirement_id: 'R4', coverage: 'missing', suggestion: 'Delete the lines that stop and disable the Print Spooler.', disruptive: true, automatable: true },
  { requirement_id: 'R5', coverage: 'manual', suggestion: 'A person answers this in the forensic questions.', disruptive: false, automatable: false },
] as const;

export const ADAPTED_SCRIPT = [
  '# Universal Windows hardening baseline (adapted for HC-FRONTDESK-0417)',
  "Write-Host 'Starting baseline hardening'",
  "Disable-LocalUser -Name 'Guest'",
  "Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name 'fDenyTSConnections' -Value 1",
  "Get-LocalGroupMember -Group 'Administrators' | Where-Object { $_.Name -notmatch '(alice|bob|Administrator)$' } | ForEach-Object { Remove-LocalGroupMember -Group 'Administrators' -Member $_.Name }",
  "Write-Host 'Baseline hardening complete'",
].join('\n');
export const ADAPTATION_SUMMARY = 'Adapt the baseline for Harbor Clinic: keep the Print Spooler and remove extra administrators';

export const REMEDIATION_SCRIPT = [
  '# Targeted remediation, cycle 1 (HC-FRONTDESK-0417)',
  "Set-LocalUser -Name 'bob' -PasswordNeverExpires $false",
  'auditpol /set /subcategory:"Logon" /success:enable /failure:enable',
  "Write-Host 'Remediation complete'",
].join('\n');
export const REMEDIATION_SUMMARY = 'Fix the two failing findings: password expiry for bob and logon failure auditing';

export class AcceptanceClaude {
  readonly real = REAL_CLAUDE;
  private readonly mock = new AnthropicMockClient(`http://127.0.0.1:${E2E_ANTHROPIC_MOCK_PORT}`);

  private async queue(response: MockResponse) {
    if (!this.real) await this.mock.enqueue(response);
  }

  /** Call before "Extract requirements". `paragraphIds` are the README's segment ids (support/helpers paragraphIds). */
  extraction(paragraphIds: readonly string[]) {
    return this.queue({
      match: README_MARKER,
      toolUse: {
        input: {
          requirements: EXTRACTED_REQUIREMENTS.map((r) => ({
            text: r.text,
            segment_id: paragraphIds[r.paragraph],
            category: r.category,
            automatable: r.automatable,
            disruptive: r.disruptive,
          })),
        },
      },
    });
  }

  /** Call before "Assess coverage". */
  coverage() {
    return this.queue({ match: 'record_coverage', toolUse: { input: { assessments: ASSESSMENTS } } });
  }

  /** Call before "Propose adaptation". The scanner adds its own flags for the risky lines; this one is Claude's. */
  adaptation() {
    return this.queue({
      match: 'record_adaptation',
      toolUse: {
        input: {
          content: ADAPTED_SCRIPT,
          summary: ADAPTATION_SUMMARY,
          flags: [{ category: 'accounts', line: 5, reason: 'Removes every administrator except alice, bob and Administrator' }],
        },
      },
    });
  }

  /** Call before "Propose remediation". */
  remediation() {
    return this.queue({
      match: 'record_remediation',
      toolUse: {
        input: {
          content: REMEDIATION_SCRIPT,
          summary: REMEDIATION_SUMMARY,
          flags: [{ category: 'accounts', line: 2, reason: 'Changes the password policy of one local account' }],
        },
      },
    });
  }

  /** Every request the app sent to the mock (mock mode only; the real API records nothing). */
  async requests() {
    return this.real ? [] : this.mock.requests();
  }

  /** Forget queued answers and recorded requests (mock mode). */
  async reset() {
    if (!this.real) await this.mock.reset();
  }
}
