import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HighImpactCategory, HighImpactFlag, ScriptLanguage } from '@/lib/types';
import {
  flagId,
  MATCH_MAX,
  mergeFlags,
  missingAcknowledgements,
  requiredFlags,
  resolveClaudeFlags,
  scanHighImpact,
} from '@/server/security/highImpact';

const dir = join(import.meta.dirname, '..', 'fixtures', 'high-impact');
const fixture = (name: string) => readFileSync(join(dir, name), 'utf8');
const LANG: Record<string, ScriptLanguage> = { ps1: 'powershell', bat: 'batch', sh: 'bash' };

type Expected = [line: number, category: HighImpactCategory][];

/** Every fixture, with the (line, category) pairs the scanner must report — nothing more, nothing less. */
const CASES: [file: string, expected: Expected][] = [
  ['accounts.ps1', [[4, 'accounts'], [5, 'accounts'], [6, 'accounts'], [7, 'accounts']]],
  ['services.ps1', [[3, 'services'], [4, 'services'], [6, 'services']]],
  ['firewall.ps1', [[1, 'firewall'], [3, 'firewall'], [5, 'firewall']]],
  ['remote_access.ps1', [[1, 'remote_access'], [3, 'remote_access'], [4, 'remote_access'], [5, 'remote_access']]],
  ['other.ps1', [[2, 'other'], [3, 'other']]],
  ['accounts.bat', [[4, 'accounts'], [5, 'accounts']]],
  ['services.bat', [[3, 'services'], [4, 'services']]],
  ['firewall.bat', [[2, 'firewall'], [3, 'firewall']]],
  ['remote_access.bat', [[2, 'remote_access'], [3, 'remote_access'], [4, 'services'], [4, 'remote_access']]],
  ['accounts.sh', [[4, 'accounts'], [5, 'accounts'], [6, 'accounts']]],
  ['services.sh', [[3, 'services'], [4, 'services'], [5, 'services'], [7, 'services']]],
  ['firewall.sh', [[2, 'firewall'], [3, 'firewall'], [4, 'firewall'], [5, 'firewall']]],
  ['remote_access.sh', [[2, 'remote_access'], [3, 'remote_access'], [5, 'remote_access']]],
  ['other.sh', [[3, 'other'], [4, 'other'], [5, 'other']]],
  // `#>` closing a block comment, net accounts, secedit /configure, the RDP policy key, splatting.
  ['policy.ps1', [[3, 'services'], [3, 'remote_access'], [6, 'accounts'], [7, 'accounts'], [9, 'remote_access'], [11, 'services'], [12, 'other']]],
  // Killing sshd, interfaces taken down.
  ['network.sh', [[3, 'remote_access'], [4, 'remote_access'], [5, 'remote_access'], [6, 'other'], [7, 'other']]],
];

const pairs = (flags: HighImpactFlag[]) => flags.map((f) => [f.line, f.category]);

describe('scanHighImpact', () => {
  it.each(CASES)('each fixture produces the expected category and line: %s', (file, expected) => {
    const content = fixture(file);
    const language = LANG[file.split('.').pop()!];
    const flags = scanHighImpact(content, language);
    expect(pairs(flags)).toEqual(expected);
    // Same answer whatever the line endings (Windows scripts are stored with CRLF).
    expect(pairs(scanHighImpact(content.replace(/\n/g, '\r\n'), language))).toEqual(expected);
    for (const f of flags) {
      expect(f.source).toBe('scanner');
      expect(f.match.length).toBeGreaterThan(0);
      expect(f.match).toBe(f.match.trim());
      expect(f.reason).toBeTruthy();
    }
  });

  it('covers every category for every language', () => {
    const seen = new Map<ScriptLanguage, Set<HighImpactCategory>>();
    for (const [file, expected] of CASES) {
      const language = LANG[file.split('.').pop()!];
      const s = seen.get(language) ?? new Set();
      expected.forEach(([, c]) => s.add(c));
      seen.set(language, s);
    }
    for (const language of ['powershell', 'batch', 'bash'] as const) {
      expect([...seen.get(language)!].sort()).toEqual(
        language === 'batch' ? ['accounts', 'firewall', 'remote_access', 'services'] : ['accounts', 'firewall', 'other', 'remote_access', 'services'],
      );
    }
  });

  it('matches every command the brief lists', () => {
    const ps: [string, HighImpactCategory][] = [
      ['Disable-LocalUser -Name Guest', 'accounts'],
      ['Remove-LocalUser -Name eve', 'accounts'],
      ['net user eve /active:no', 'accounts'],
      ['Stop-Service -Name Spooler', 'services'],
      ['Set-Service -Name Spooler -StartupType Disabled', 'services'],
      ['New-NetFirewallRule -DisplayName x -Action Block', 'firewall'],
      ['Set-NetFirewallProfile -Enabled True', 'firewall'],
      ['netsh advfirewall set allprofiles state on', 'firewall'],
      ["Set-ItemProperty 'HKLM:\\x' -Name fDenyTSConnections -Value 1", 'remote_access'],
      ["New-Item 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations'", 'remote_access'],
      ['notepad C:\\ProgramData\\ssh\\sshd_config', 'remote_access'],
      ['Enable-PSRemoting -Force', 'remote_access'],
      ['Set-Item WSMan:\\localhost\\Service\\AllowUnencrypted $false', 'remote_access'],
    ];
    for (const [line, category] of ps) expect(scanHighImpact(line, 'powershell').map((f) => f.category), line).toContain(category);
    const sh: [string, HighImpactCategory][] = [
      ['userdel eve', 'accounts'],
      ['usermod -L eve', 'accounts'],
      ['passwd -l eve', 'accounts'],
      ['systemctl stop cups', 'services'],
      ['systemctl disable cups', 'services'],
      ['systemctl mask cups', 'services'],
      ['ufw enable', 'firewall'],
      ['iptables -F', 'firewall'],
      ['nft flush ruleset', 'firewall'],
      ['vi /etc/ssh/sshd_config', 'remote_access'],
      ['echo "PermitRootLogin no" >> /etc/ssh/sshd_config', 'remote_access'],
    ];
    for (const [line, category] of sh) expect(scanHighImpact(line, 'bash').map((f) => f.category), line).toContain(category);
  });

  it('is case-insensitive for PowerShell and batch, case-sensitive for Bash commands', () => {
    expect(pairs(scanHighImpact('STOP-SERVICE spooler', 'powershell'))).toEqual([[1, 'services']]);
    expect(pairs(scanHighImpact('NET USER guest /ACTIVE:NO', 'batch'))).toEqual([[1, 'accounts']]);
    expect(scanHighImpact('SYSTEMCTL STOP cups', 'bash')).toEqual([]);
    // sshd_config keywords are case-insensitive for sshd itself, so they are for the scanner too.
    expect(pairs(scanHighImpact('PERMITROOTLOGIN no', 'bash'))).toEqual([[1, 'remote_access']]);
  });

  it('skips pure comment lines only (#, REM, ::), never code with a trailing comment', () => {
    expect(scanHighImpact('   # Stop-Service Spooler', 'powershell')).toEqual([]);
    expect(scanHighImpact('#!/bin/bash\n  # userdel eve', 'bash')).toEqual([]);
    expect(scanHighImpact('REM net user guest /active:no\n@rem net stop spooler\n  :: sc stop fax', 'batch')).toEqual([]);
    expect(pairs(scanHighImpact('Stop-Service Spooler # stop printing', 'powershell'))).toEqual([[1, 'services']]);
    expect(pairs(scanHighImpact('userdel eve  # remove eve', 'bash'))).toEqual([[1, 'accounts']]);
    // "REMOVE" is not a REM comment.
    expect(pairs(scanHighImpact('net user remove_me /delete', 'batch'))).toEqual([[1, 'accounts']]);
  });

  it('a PowerShell line with #> is code, not a comment: it closes a block comment', () => {
    expect(pairs(scanHighImpact('<#\n  notes\n#> Stop-Service WinRM -Force', 'powershell'))).toEqual([
      [3, 'services'],
      [3, 'remote_access'],
    ]);
    expect(pairs(scanHighImpact('   #>Disable-LocalUser Guest', 'powershell'))).toEqual([[1, 'accounts']]);
    expect(pairs(scanHighImpact('<# note #> Stop-Service Spooler', 'powershell'))).toEqual([[1, 'services']]);
    // Plain comments are still skipped; Bash and batch keep their own rules.
    expect(scanHighImpact('# Stop-Service Spooler', 'powershell')).toEqual([]);
    expect(scanHighImpact('#> userdel eve', 'bash')).toEqual([]);
    expect(scanHighImpact('REM #> net stop spooler', 'batch')).toEqual([]);
  });

  it('flags policy, RDP-policy, splatted and interface/SSH-kill commands', () => {
    const ps: [string, HighImpactCategory][] = [
      ['secedit /configure /db secedit.sdb /cfg baseline.inf', 'accounts'],
      ['SECEDIT.EXE /CONFIGURE /CFG x.inf /DB x.sdb', 'accounts'],
      ['net accounts /minpwlen:12', 'accounts'],
      ["reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' /v fDenyTSConnections /d 1", 'remote_access'],
      ["New-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' -Name UserAuthentication -Value 1", 'remote_access'],
      ['Set-Service @svc', 'services'],
      ['Set-Service -Verbose @svc', 'services'],
    ];
    for (const [line, category] of ps) expect(scanHighImpact(line, 'powershell').map((f) => f.category), line).toContain(category);
    expect(pairs(scanHighImpact('secedit /configure /cfg x.inf /db x.sdb', 'batch'))).toEqual([[1, 'accounts']]);
    for (const line of ['net accounts', 'secedit /export /cfg out.inf', 'secedit /analyze /db x.sdb']) expect(scanHighImpact(line, 'powershell'), line).toEqual([]);

    const sh: [string, HighImpactCategory][] = [
      ['pkill sshd', 'remote_access'],
      ['killall -9 sshd', 'remote_access'],
      ['pkill -f xrdp', 'remote_access'],
      ['kill -9 $(pgrep sshd)', 'remote_access'],
      ['ifconfig ens33 down', 'other'],
      ['ip link set eth0 down', 'other'],
      ['ip link set dev eth0 down', 'other'],
    ];
    for (const [line, category] of sh) expect(scanHighImpact(line, 'bash').map((f) => f.category), line).toContain(category);
    for (const line of ['pgrep sshd', 'pkill firefox', 'ifconfig eth0', 'ip link show', 'ip link set eth0 up']) expect(scanHighImpact(line, 'bash'), line).toEqual([]);
  });

  it('reports a continued command on its first physical line', () => {
    expect(pairs(scanHighImpact('Write-Host hi\nSet-Service `\n  -Name Spooler `\n  -StartupType Disabled', 'powershell'))).toEqual([[2, 'services']]);
    expect(pairs(scanHighImpact('echo hi\nsystemctl \\\n  disable cups', 'bash'))).toEqual([[2, 'services']]);
    expect(pairs(scanHighImpact('net ^\n  user guest /active:no', 'batch'))).toEqual([[1, 'accounts']]);
  });

  it('does not flag read-only commands', () => {
    const benign = ['Get-LocalUser', 'Get-Service', 'Get-NetFirewallRule', 'Set-Service -Name W32Time -StartupType Automatic', 'net user', 'net user bob'];
    for (const line of benign) expect(scanHighImpact(line, 'powershell'), line).toEqual([]);
    for (const line of ['systemctl status sshd', 'getent passwd', 'cat /etc/passwd', 'id -u']) expect(scanHighImpact(line, 'bash'), line).toEqual([]);
  });

  it('scans text and markdown scripts with every rule set', () => {
    const text = 'Disable-LocalUser Guest\nsystemctl stop cups\nnetsh advfirewall reset';
    expect(pairs(scanHighImpact(text, 'text'))).toEqual([[1, 'accounts'], [2, 'services'], [3, 'firewall']]);
    expect(pairs(scanHighImpact(text, 'markdown'))).toEqual([[1, 'accounts'], [2, 'services'], [3, 'firewall']]);
  });

  it('match is the trimmed line, at most 200 characters; ids are stable and bound to the line text', () => {
    const long = `    Stop-Service -Name ${'x'.repeat(400)}   `;
    const [flag] = scanHighImpact(long, 'powershell');
    expect(flag.match.length).toBeLessThanOrEqual(MATCH_MAX);
    expect(flag.match.startsWith('Stop-Service -Name xxx')).toBe(true);
    expect(flag.match.endsWith('…')).toBe(true);

    const a = scanHighImpact('Stop-Service Spooler', 'powershell')[0];
    const b = scanHighImpact('Stop-Service Spooler', 'powershell')[0];
    const c = scanHighImpact('Stop-Service Fax', 'powershell')[0];
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^scanner-services-1-[0-9a-f]{8}$/);
    expect(a.id).toBe(flagId('scanner', 'services', 1, 'Stop-Service Spooler'));
    // Same line number, different text: a different flag (an acknowledgement covers the text it was given for).
    expect(c.id).not.toBe(a.id);
    // Moving the line gives a different id too.
    expect(scanHighImpact('\nStop-Service Spooler', 'powershell')[0].id).not.toBe(a.id);
  });

  it('documents its limit: string-built commands are not seen (Claude flags are unioned for that reason)', () => {
    expect(scanHighImpact("$c = 'Disable-Local' + 'User'; & $c Guest", 'powershell').map((f) => f.category)).not.toContain('accounts');
  });
});

describe('Claude flags and the union', () => {
  const content = 'Write-Host start\nDisable-LocalUser Guest\nSet-Service Spooler -StartupType Disabled\nWrite-Host end';

  it('resolveClaudeFlags keeps in-range lines with the line text and counts the rest', () => {
    const { flags, dropped } = resolveClaudeFlags(
      [
        { category: 'accounts', line: 2, reason: 'Disables Guest as the README asks' },
        { category: 'other', line: 4, reason: 'Ends the run' },
        { category: 'services', line: 0, reason: 'bad' },
        { category: 'services', line: 99, reason: 'bad' },
        { category: 'services', line: 2.5, reason: 'bad' },
      ],
      content,
    );
    expect(dropped).toBe(3);
    expect(flags).toEqual([
      { id: flagId('claude', 'accounts', 2, 'Disable-LocalUser Guest'), category: 'accounts', line: 2, match: 'Disable-LocalUser Guest', source: 'claude', reason: 'Disables Guest as the README asks' },
      { id: flagId('claude', 'other', 4, 'Write-Host end'), category: 'other', line: 4, match: 'Write-Host end', source: 'claude', reason: 'Ends the run' },
    ]);
  });

  it('mergeFlags dedupes by category + line (the first list wins), keeps the rest, sorted by line', () => {
    const scanner = scanHighImpact(content, 'powershell');
    const { flags: claude } = resolveClaudeFlags(
      [
        { category: 'accounts', line: 2, reason: 'Guest must be disabled' },
        { category: 'remote_access', line: 3, reason: 'Claude thinks so' },
      ],
      content,
    );
    const merged = mergeFlags(scanner, claude);
    expect(merged.map((f) => [f.line, f.category, f.source])).toEqual([
      [2, 'accounts', 'scanner'],
      [3, 'services', 'scanner'],
      [3, 'remote_access', 'claude'],
    ]);
    // Claude's reason is kept on the deduped scanner flag.
    expect(merged[0].reason).toBe('Guest must be disabled');
    expect(merged[0].id).toBe(scanner[0].id);
  });

  it('requiredFlags = stored ∪ scan(final content) by id; missingAcknowledgements lists what is not ticked', () => {
    const stored = scanHighImpact(content, 'powershell');
    expect(requiredFlags(stored, content, 'powershell').map((f) => f.id)).toEqual(stored.map((f) => f.id));

    const edited = `${content}\nStop-Service WinRM`;
    const required = requiredFlags(stored, edited, 'powershell');
    const added = required.filter((f) => !stored.some((s) => s.id === f.id));
    expect(added.map((f) => [f.line, f.category])).toEqual([
      [5, 'services'],
      [5, 'remote_access'],
    ]);
    expect(missingAcknowledgements(required, stored.map((f) => f.id)).map((f) => f.id)).toEqual(added.map((f) => f.id));
    expect(missingAcknowledgements(required, required.map((f) => f.id))).toEqual([]);

    // A stored flag stays required even if the edit removed its line.
    const removed = 'Write-Host start';
    expect(requiredFlags(stored, removed, 'powershell').map((f) => f.id)).toEqual(stored.map((f) => f.id));
  });
});
