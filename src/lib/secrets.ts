/**
 * Secret detection for content that is about to become public. Pure and dependency-free so tests
 * and the server can share it; the UI only ever receives { kind, line } (never the matched text).
 *
 * Every pattern is linear-time: no nested or overlapping unbounded quantifiers, each quantifier is
 * bounded or runs over a single character class, and lines are scanned in bounded windows, so
 * adversarial 512 KB input cannot cause catastrophic backtracking (see tests/unit/secrets.test.ts).
 */

export const SECRET_KINDS = [
  'aws_access_key',
  'private_key_block',
  'github_token',
  'anthropic_key',
  'jwt',
  'password_literal',
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export type SecretFinding = { kind: SecretKind; line: number };

export const SECRET_KIND_LABEL: Record<SecretKind, string> = {
  aws_access_key: 'AWS access key',
  private_key_block: 'Private key block',
  github_token: 'GitHub token',
  anthropic_key: 'Anthropic API key',
  jwt: 'JSON Web Token',
  password_literal: 'Password in plain text',
};

/** Longest slice of a line scanned at once; longer lines are scanned in overlapping windows. */
export const LINE_WINDOW = 4096;
const WINDOW_OVERLAP = 512;
/** Most findings returned (the warning stays readable; the first ones are the lines to fix). */
export const MAX_FINDINGS = 100;

const PASSWORD_TAIL = String.raw`['"][^'"\r\n]{1,200}['"]`;

const LINE_PATTERNS: ReadonlyArray<{ kind: SecretKind; re: RegExp; also?: RegExp }> = [
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/ },
  { kind: 'private_key_block', re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/ },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,400}/ },
  // password = "x" / $password = 'x' / PASSWORD="x"
  { kind: 'password_literal', re: new RegExp(String.raw`\b(?:password|passwd|pwd)[ \t]{0,20}=[ \t]{0,20}${PASSWORD_TAIL}`, 'i') },
  // PowerShell: -Password "x"  /  -Password (ConvertTo-SecureString "x" -AsPlainText -Force)
  { kind: 'password_literal', re: new RegExp(String.raw`-password[ \t]{1,20}\(?[ \t]{0,20}${PASSWORD_TAIL}`, 'i') },
  { kind: 'password_literal', re: new RegExp(String.raw`ConvertTo-SecureString[ \t]{1,20}(?:-String[ \t]{1,20})?${PASSWORD_TAIL}`, 'i'), also: /-AsPlainText/i },
  // net user <name> <password> [/add]  (at the start of a command)
  { kind: 'password_literal', re: /(?:^|[;&|(])[ \t]{0,20}@?net1?[ \t]{1,10}user[ \t]{1,10}[^\s/*]{1,64}[ \t]{1,10}[^\s/*][^\s]{0,127}/i },
  // echo "user:pass" | chpasswd
  { kind: 'password_literal', re: /\becho[ \t]{1,10}(?:-e[ \t]{1,10})?['"]?[^\s:'"|]{1,64}:[^\s'"|]{1,128}['"]?[ \t]{0,10}\|[ \t]{0,10}(?:sudo[ \t]{1,10})?chpasswd\b/i },
];

const TOKEN_RE = /[A-Za-z0-9_.-]+/g;
const JWT_TOKEN_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** Kinds found in one window of one line. */
function scanWindow(text: string, found: Set<SecretKind>): void {
  for (const p of LINE_PATTERNS) {
    if (!found.has(p.kind) && p.re.test(text) && (!p.also || p.also.test(text))) found.add(p.kind);
  }
  if (!found.has('jwt') && text.includes('eyJ')) {
    // Tokenize first: matching the three segments anchored to a whole token cannot backtrack across starts.
    for (const m of text.matchAll(TOKEN_RE)) {
      if (m[0].length >= 30 && JWT_TOKEN_RE.test(m[0])) {
        found.add('jwt');
        break;
      }
    }
  }
}

/** Scans one line (in overlapping windows when it is very long). */
function scanLine(line: string): Set<SecretKind> {
  const found = new Set<SecretKind>();
  if (line.length <= LINE_WINDOW) {
    scanWindow(line, found);
    return found;
  }
  for (let i = 0; i < line.length; i += LINE_WINDOW - WINDOW_OVERLAP) {
    scanWindow(line.slice(i, i + LINE_WINDOW), found);
    if (i + LINE_WINDOW >= line.length) break;
  }
  return found;
}

/**
 * Likely secrets in `content`: one entry per (kind, line), 1-based line numbers, ordered by line
 * then kind. Never includes the matched text.
 */
export function scanSecrets(content: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = content.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length && out.length < MAX_FINDINGS; i++) {
    const line = lines[i];
    if (line.length < 8) continue; // the shortest detectable secret is longer than this
    const kinds = scanLine(line);
    for (const kind of SECRET_KINDS) {
      if (kinds.has(kind) && out.length < MAX_FINDINGS) out.push({ kind, line: i + 1 });
    }
  }
  return out;
}
