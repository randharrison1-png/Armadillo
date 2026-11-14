import type { HighImpactCategory, HighImpactFlag, ScriptLanguage } from '@/lib/types';

/*
 * High-impact operation scanner (spec §5.4): flags script lines that change user accounts, stop or
 * disable services, edit the firewall, change remote access, or otherwise risk cutting the operator
 * off from the machine. A proposal cannot be accepted until every flag is acknowledged.
 *
 * Pure and dependency-free, so it lives in src/lib (client bundles may not reach src/server/security,
 * which holds key crypto; src/server/security/highImpact.ts is the server entry and re-exports this).
 * The server runs it when a proposal is stored and again on the final text at accept time; the diff
 * tab runs the same code on the user's edits, so the checklist it shows is exactly what the server
 * will require.
 *
 * How it reads a script:
 *  - One rule table per shell family. Windows rules (PowerShell cmdlets plus the cmd.exe tools a
 *    PowerShell script may also call: net, sc, netsh, reg, winrm) apply to PowerShell and batch
 *    files and are case-insensitive, like those shells. Bash rules are case-sensitive (commands are),
 *    except sshd_config keywords, which sshd itself reads case-insensitively. Text and Markdown
 *    "scripts" get both tables.
 *  - Pure comment lines are skipped: `#` for PowerShell and Bash, `REM` / `@REM` / `::` for batch.
 *    Code with a trailing comment is still scanned. Block comments (`<# … #>`, heredocs) are scanned
 *    like code, which can only add flags.
 *  - Continued commands (PowerShell backtick, Bash backslash, batch caret at the end of a line) are
 *    joined and reported on their first physical line.
 *  - At most one flag per category per line; a line can carry several categories.
 *
 * Limits — why Claude's own flags are unioned with these: the scanner matches text, it does not run
 * or parse the script. Commands assembled at run time (`& ('Stop-' + 'Service')`, variables holding
 * command names, aliases defined in the script, base64-encoded commands, downloaded scripts) are not
 * recognized as what they do. The dynamic-execution forms themselves (Invoke-Expression,
 * -EncodedCommand, eval, `curl … | sh`) are flagged as 'other' so a reviewer at least looks at them.
 *
 * Flag ids: `<source>-<category>-<line>-<hash8>`, where hash8 is a 32-bit FNV-1a hash of the trimmed
 * line text. The same text on the same line always gets the same id (stable across re-scans), and an
 * acknowledgement covers the text it was given for: editing a flagged line, or moving it, yields a
 * new id that must be acknowledged again.
 */

export const HIGH_IMPACT_CATEGORIES: readonly HighImpactCategory[] = ['accounts', 'services', 'firewall', 'remote_access', 'other'];

export const HIGH_IMPACT_LABEL: Record<HighImpactCategory, string> = {
  accounts: 'Accounts',
  services: 'Services',
  firewall: 'Firewall',
  remote_access: 'Remote access',
  other: 'Other',
};

/** Longest `match` text stored on a flag (characters, ellipsis included). */
export const MATCH_MAX = 200;

type Rule = { category: HighImpactCategory; pattern: RegExp; reason: string };

const WINDOWS: Rule[] = [
  // Accounts
  { category: 'accounts', pattern: /\b(?:Disable|Remove|Set|Rename)-LocalUser\b/i, reason: 'Disables, removes or changes a local account' },
  { category: 'accounts', pattern: /\b(?:Add|Remove)-LocalGroupMember\b/i, reason: 'Changes local group membership (for example Administrators)' },
  { category: 'accounts', pattern: /\b(?:Disable|Remove|Set|Rename)-AD(?:Account|User)\b|\bSet-ADAccountPassword\b|\b(?:Add|Remove)-ADGroupMember\b/i, reason: 'Changes a domain account or group' },
  { category: 'accounts', pattern: /\bnet(?:\.exe)?\s+(?:user|localgroup|group)\s+\S+\s+\S/i, reason: 'Changes an account or group (net user / net localgroup)' },
  { category: 'accounts', pattern: /\bwmic(?:\.exe)?\b.*\buseraccount\b.*\bset\b/i, reason: 'Changes an account (wmic useraccount)' },
  // Services
  { category: 'services', pattern: /\b(?:Stop|Suspend|Remove)-Service\b/i, reason: 'Stops or removes a service' },
  { category: 'services', pattern: /\bSet-Service\b.*-(?:StartupType|StartType)\s*:?\s*['"]?(?:Disabled|Manual)\b/i, reason: 'Sets a service to disabled or manual start' },
  { category: 'services', pattern: /\bSet-Service\b.*-Status\s*:?\s*['"]?(?:Stopped|Paused)\b/i, reason: 'Stops a service' },
  { category: 'services', pattern: /\bsc(?:\.exe)?\s+(?:\\\\\S+\s+)?(?:stop|pause|config|delete|failure)\b/i, reason: 'Stops, reconfigures or deletes a service (sc)' },
  { category: 'services', pattern: /\bnet(?:\.exe)?\s+(?:stop|pause)\b/i, reason: 'Stops a service (net stop)' },
  { category: 'services', pattern: /\bCurrentControlSet\\+Services\\+[^\s'"\\]+.*\bStart\b/i, reason: "Changes a service's start type in the registry" },
  { category: 'services', pattern: /\b(?:Uninstall|Remove)-WindowsFeature\b|\bDisable-WindowsOptionalFeature\b|\bRemove-WindowsCapability\b/i, reason: 'Removes a Windows feature or capability' },
  // Firewall
  { category: 'firewall', pattern: /\b(?:New|Set|Remove|Disable|Enable|Copy|Rename)-NetFirewall\w+/i, reason: 'Changes firewall rules or profiles' },
  { category: 'firewall', pattern: /\bnetsh(?:\.exe)?\b.*\b(?:advfirewall|firewall)\b/i, reason: 'Changes the firewall (netsh)' },
  { category: 'firewall', pattern: /\bMpsSvc\b/i, reason: 'Touches the Windows Firewall service' },
  // Remote access
  { category: 'remote_access', pattern: /\bfDenyTSConnections\b/i, reason: 'Turns Remote Desktop connections on or off' },
  { category: 'remote_access', pattern: /Terminal Server/i, reason: 'Changes Remote Desktop (Terminal Server) settings' },
  { category: 'remote_access', pattern: /\bRemote Desktop\b|\b(?:TermService|UmRdpService|SessionEnv)\b/i, reason: 'Changes Remote Desktop access or its services' },
  { category: 'remote_access', pattern: /\bWinRM\b|\bWSMan\b|\bSet-WSMan\w*|\b(?:Enable|Disable)-PSRemoting\b/i, reason: 'Changes PowerShell remoting (WinRM)' },
  { category: 'remote_access', pattern: /sshd_config|\bsshd\b|\bOpenSSH\b/i, reason: 'Changes the SSH server or its configuration' },
  { category: 'remote_access', pattern: /\b(?:PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|(?:Allow|Deny)(?:Users|Groups))\b/i, reason: 'Changes who can log in over SSH' },
  // Other ways to lose the machine
  { category: 'other', pattern: /\b(?:Restart|Stop)-Computer\b|\bshutdown(?:\.exe)?\s+[/-]/i, reason: 'Restarts or shuts down the machine' },
  { category: 'other', pattern: /\bDisable-NetAdapter\b|\bnetsh(?:\.exe)?\b.*\binterface\b.*\b(?:disable|disabled)\b/i, reason: 'Disables a network adapter' },
  { category: 'other', pattern: /\b(?:Invoke-Expression|iex)\b|\bFromBase64String\b|\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, reason: 'Runs code built at run time, which the scanner cannot read' },
];

const BASH: Rule[] = [
  // Accounts
  { category: 'accounts', pattern: /\b(?:userdel|deluser|groupdel|delgroup)\b/, reason: 'Deletes an account or group' },
  { category: 'accounts', pattern: /\busermod\b/, reason: 'Changes an account (lock, shell, groups, expiry)' },
  { category: 'accounts', pattern: /\bpasswd\s+(?:-[a-zA-Z]*[lde]\b|--(?:lock|delete|expire)\b)/, reason: 'Locks, deletes or expires a password' },
  { category: 'accounts', pattern: /\b(?:chpasswd|chage|chsh)\b/, reason: 'Changes passwords, password ageing or login shells' },
  { category: 'accounts', pattern: /\bgpasswd\s+(?:-[dMA]\b|--(?:delete|members|administrators)\b)/, reason: 'Changes group membership' },
  { category: 'accounts', pattern: /(?:\bsed\s+(?:-[a-zA-Z]*i|--in-place)\b.*|>>?\s*|\btee\s+(?:-a\s+)?)\/etc\/(?:passwd|shadow|group|gshadow|sudoers)\b/, reason: 'Edits the account database or sudoers' },
  { category: 'accounts', pattern: /\/etc\/sudoers\.d\b|\bvisudo\b/, reason: 'Changes sudo rules' },
  { category: 'accounts', pattern: /\/etc\/pam\.d\b|\bpam-auth-update\b|\/etc\/security\/(?:faillock|access)\.conf\b/, reason: 'Changes login authentication (PAM)' },
  // Services
  { category: 'services', pattern: /\bsystemctl\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:stop|disable|mask|kill|isolate)\b/, reason: 'Stops, disables or masks a service' },
  { category: 'services', pattern: /\bservice\s+\S+\s+stop\b/, reason: 'Stops a service' },
  { category: 'services', pattern: /\bupdate-rc\.d\s+\S+\s+(?:disable|remove)\b|\bchkconfig\s+\S+\s+off\b/, reason: 'Disables a service at boot' },
  // Firewall
  { category: 'firewall', pattern: /\b(?:ufw|ip6?tables(?:-restore)?|nft|firewall-cmd)\b/, reason: 'Changes the firewall' },
  // Remote access
  { category: 'remote_access', pattern: /sshd_config|\/etc\/ssh\b/, reason: 'Edits the SSH server configuration' },
  {
    category: 'remote_access',
    pattern: /\b(?:PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|KbdInteractiveAuthentication|ChallengeResponseAuthentication|ListenAddress|(?:Allow|Deny)(?:Users|Groups))\b/i,
    reason: 'Changes who can log in over SSH',
  },
  {
    category: 'remote_access',
    pattern: /\bsystemctl\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:stop|disable|mask|kill|restart|reload|try-restart)\b.*\b(?:sshd?|xrdp|vnc\S*)\b|\bservice\s+(?:sshd?|xrdp)\s+(?:stop|restart|reload)\b/,
    reason: 'Stops or restarts a remote-access service',
  },
  { category: 'remote_access', pattern: /\/etc\/hosts\.(?:allow|deny)\b/, reason: 'Changes TCP wrappers access rules' },
  {
    category: 'remote_access',
    pattern: /\b(?:apt(?:-get)?|yum|dnf|zypper|snap)\b.*\b(?:remove|purge|erase|autoremove)\b.*\b(?:openssh-server|openssh|ssh|xrdp|tigervnc\S*|x11vnc)\b/,
    reason: 'Removes remote-access software',
  },
  // Other ways to lose the machine
  { category: 'other', pattern: /\b(?:shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b/, reason: 'Restarts or shuts down the machine' },
  { category: 'other', pattern: /\bip\s+link\s+set\s+\S+\s+down\b|\bifdown\b|\bnmcli\b.*\b(?:down|off|disconnect)\b/, reason: 'Takes a network interface down' },
  {
    category: 'other',
    pattern: /\beval\b|\bbase64\s+(?:-d|--decode)\b|\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b|\b(?:ba)?sh\s+-c\b|\bsource\s+<\(/,
    reason: 'Runs code built at run time or downloaded, which the scanner cannot read',
  },
];

type Syntax = { comment: RegExp | null; continuation: RegExp | null };

const SYNTAX: Record<ScriptLanguage, Syntax> = {
  powershell: { comment: /^\s*#/, continuation: /`\s*$/ },
  bash: { comment: /^\s*#/, continuation: /\\\s*$/ },
  batch: { comment: /^\s*@?(?:rem(?:\s|$)|::)/i, continuation: /\^\s*$/ },
  text: { comment: null, continuation: null },
  markdown: { comment: null, continuation: null },
};

const RULES: Record<ScriptLanguage, Rule[]> = {
  powershell: WINDOWS,
  batch: WINDOWS,
  bash: BASH,
  text: [...WINDOWS, ...BASH],
  markdown: [...WINDOWS, ...BASH],
};

/** Physical lines (CRLF, LF and lone CR all end a line). */
export function linesOf(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

/** Number of lines a 1-based line number may point at (a final newline does not start a line). */
export function lineCount(content: string): number {
  const lines = linesOf(content);
  return lines.length > 1 && lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits. Not a security hash: it binds an id to a text. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function flagId(source: HighImpactFlag['source'], category: HighImpactCategory, line: number, lineText: string): string {
  return `${source}-${category}-${line}-${fnv1a(lineText.trim())}`;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length <= MATCH_MAX ? t : `${t.slice(0, MATCH_MAX - 1).trimEnd()}…`;
}

const ORDER = new Map(HIGH_IMPACT_CATEGORIES.map((c, i) => [c, i]));

/** By line, then category order. Stable, so equal keys keep their input order. */
function sortFlags(flags: HighImpactFlag[]): HighImpactFlag[] {
  return [...flags].sort((a, b) => a.line - b.line || (ORDER.get(a.category) ?? 9) - (ORDER.get(b.category) ?? 9));
}

/** Every high-impact line of `content`, read as `language` (see the header for what is and is not seen). */
export function scanHighImpact(content: string, language: ScriptLanguage): HighImpactFlag[] {
  const rules = RULES[language] ?? RULES.text;
  const { comment, continuation } = SYNTAX[language] ?? SYNTAX.text;
  const lines = linesOf(content);
  const out: HighImpactFlag[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let text = lines[i]!;
    if (comment?.test(text)) continue;
    while (continuation && continuation.test(text) && i + 1 < lines.length) {
      text = `${text.replace(continuation, ' ')}${lines[++i]}`;
    }
    const logical = text.trim();
    if (!logical) continue;
    const seen = new Set<HighImpactCategory>();
    for (const rule of rules) {
      if (seen.has(rule.category) || !rule.pattern.test(logical)) continue;
      seen.add(rule.category);
      out.push({
        id: flagId('scanner', rule.category, start + 1, logical),
        category: rule.category,
        line: start + 1,
        match: clip(logical),
        source: 'scanner',
        reason: rule.reason,
      });
    }
  }
  return sortFlags(out);
}

export type ClaudeFlagInput = { category: HighImpactCategory; line: number; reason: string };

/**
 * Claude's flags as stored flags: the line must exist in `content` (1-based integer); `match` is that
 * line's text. Flags pointing anywhere else are dropped and counted.
 */
export function resolveClaudeFlags(items: readonly ClaudeFlagInput[], content: string): { flags: HighImpactFlag[]; dropped: number } {
  const lines = linesOf(content);
  const max = lineCount(content);
  const flags: HighImpactFlag[] = [];
  let dropped = 0;
  for (const item of items) {
    if (!Number.isInteger(item.line) || item.line < 1 || item.line > max || !ORDER.has(item.category)) {
      dropped++;
      continue;
    }
    const text = lines[item.line - 1] ?? '';
    const reason = item.reason.trim();
    flags.push({
      id: flagId('claude', item.category, item.line, text),
      category: item.category,
      line: item.line,
      match: clip(text),
      source: 'claude',
      ...(reason ? { reason } : {}),
    });
  }
  return { flags, dropped };
}

/**
 * Union for storing a proposal: one flag per (category, line), the first list's flag winning (pass
 * the scanner's first, so ids stay reproducible by a re-scan). When a later Claude flag duplicates a
 * scanner flag, Claude's reason replaces the generic rule description.
 */
export function mergeFlags(...lists: readonly HighImpactFlag[][]): HighImpactFlag[] {
  const byKey = new Map<string, HighImpactFlag>();
  for (const list of lists) {
    for (const f of list) {
      const key = `${f.category}:${f.line}`;
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, { ...f });
      else if (existing.source === 'scanner' && f.source === 'claude' && f.reason) existing.reason = f.reason;
    }
  }
  return sortFlags([...byKey.values()]);
}

/**
 * What must be acknowledged before `content` (the text being accepted) can be saved: every stored
 * flag of the proposal, plus every flag a fresh scan of `content` finds (union by id). Stored flags
 * stay required even if an edit removed their line.
 */
export function requiredFlags(stored: readonly HighImpactFlag[], content: string, language: ScriptLanguage): HighImpactFlag[] {
  const ids = new Set(stored.map((f) => f.id));
  return sortFlags([...stored, ...scanHighImpact(content, language).filter((f) => !ids.has(f.id))]);
}

export function missingAcknowledgements(required: readonly HighImpactFlag[], acknowledgedIds: readonly string[]): HighImpactFlag[] {
  const ack = new Set(acknowledgedIds);
  return required.filter((f) => !ack.has(f.id));
}
