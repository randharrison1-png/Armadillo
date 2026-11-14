// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { scanSecrets, SECRET_KIND_LABEL } from '@/lib/secrets';
import { secretsFingerprint } from '@/server/security/secrets';

const kinds = (s: string) => scanSecrets(s).map((f) => `${f.kind}:${f.line}`);

describe('scanSecrets', () => {
  it('detects each secret kind with line numbers', () => {
    const content = [
      '# setup',
      'AWS_KEY=AKIAIOSFODNN7EXAMPLE', // 2
      'echo ok',
      '-----BEGIN RSA PRIVATE KEY-----', // 4
      'MIIEowIBAAKCAQEA',
      'token=ghp_' + 'a1B2c3D4e5'.repeat(4), // 6
      'gh=github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2', // 7
      'key = "sk-ant-api03-' + 'abcdEFGH1234'.repeat(3) + '"', // 8
      'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', // 9
      '$password = "Sup3rS3cret!"', // 10
    ].join('\n');
    expect(kinds(content)).toEqual([
      'aws_access_key:2',
      'private_key_block:4',
      'github_token:6',
      'github_token:7',
      'anthropic_key:8',
      'jwt:9',
      'password_literal:10',
    ]);
  });

  it('recognises other AWS prefixes and private key flavours', () => {
    expect(kinds('id: ASIAIOSFODNN7EXAMPLE')).toEqual(['aws_access_key:1']);
    expect(kinds('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['private_key_block:1']);
    expect(kinds('-----BEGIN PRIVATE KEY-----')).toEqual(['private_key_block:1']);
    expect(kinds('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toEqual(['private_key_block:1']);
    expect(kinds('-----BEGIN CERTIFICATE-----')).toEqual([]);
  });

  it('detects password literals in scripts', () => {
    expect(kinds('password = "hunter2"')).toEqual(['password_literal:1']);
    expect(kinds("PASSWORD='hunter2'")).toEqual(['password_literal:1']);
    expect(kinds('New-LocalUser -Name x -Password "hunter2hunter2"')).toEqual(['password_literal:1']);
    expect(kinds('$p = ConvertTo-SecureString "hunter2" -AsPlainText -Force')).toEqual(['password_literal:1']);
    expect(kinds('net user bob Passw0rd! /add')).toEqual(['password_literal:1']);
    expect(kinds('  @net user bob Passw0rd!')).toEqual(['password_literal:1']);
    expect(kinds('echo "bob:Passw0rd!" | chpasswd')).toEqual(['password_literal:1']);
    expect(kinds('echo bob:Passw0rd! | sudo chpasswd')).toEqual(['password_literal:1']);
  });

  it('does not flag ordinary hardening script content', () => {
    const benign = [
      'net user guest /active:no',
      'net user administrator *',
      'net user',
      'Set-LocalUser -Name Guest -Password (Read-Host -AsSecureString)',
      '$password = Read-Host "Enter password"',
      'password = ""',
      'ConvertTo-SecureString $env:PW -AsPlainText -Force',
      'passwd -l guest',
      'echo "PermitRootLogin no" >> /etc/ssh/sshd_config',
      'Write-Host "Disabling password reuse"',
      'eyJ is not a token',
      'AKIA is a prefix',
    ].join('\n');
    expect(scanSecrets(benign)).toEqual([]);
  });

  it('handles CRLF and CR line endings and reports one finding per kind per line', () => {
    expect(kinds('a\r\nAKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPL2\r\nb')).toEqual(['aws_access_key:2']);
    expect(kinds('one\rAKIAIOSFODNN7EXAMPLE')).toEqual(['aws_access_key:2']);
  });

  it('finds a secret deep inside a very long line', () => {
    const line = 'x '.repeat(20_000) + 'AKIAIOSFODNN7EXAMPLE' + ' y'.repeat(5000);
    expect(kinds(line)).toEqual(['aws_access_key:1']);
  });

  it('never returns the matched text', () => {
    const f = scanSecrets('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(f)).not.toContain('AKIA');
    expect(Object.keys(f[0]).sort()).toEqual(['kind', 'line']);
    for (const label of Object.values(SECRET_KIND_LABEL)) expect(label).not.toMatch(/AKIA|ghp_/);
  });

  it('caps the number of findings', () => {
    const many = Array.from({ length: 500 }, () => 'AKIAIOSFODNN7EXAMPLE').join('\n');
    expect(scanSecrets(many)).toHaveLength(100);
  });
});

describe('scanSecrets performance (no catastrophic backtracking)', () => {
  const KB512 = 512 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(KB512 / unit.length)).slice(0, KB512);
  const cases: Record<string, string> = {
    'eyJ repeated': fill('eyJ'),
    'eyJ + base64url run': 'eyJ' + fill('a'),
    'jwt-like dots': fill('eyJaaaaaaaaaa.'),
    'password + spaces': fill('password' + ' '.repeat(30)),
    'password = no closing quote': fill('password = "' + 'a'.repeat(300)),
    'net user spaces': fill('net user ' + 'a'.repeat(200) + ' '),
    '-Password spaces': fill('-Password' + ' '.repeat(50) + '(('),
    'ConvertTo-SecureString': fill('ConvertTo-SecureString "' + 'a'.repeat(300)),
    'BEGIN dashes': fill('-----BEGIN ' + 'A'.repeat(50)),
    'ghp_ near misses': fill('ghp_' + 'a'.repeat(300) + '_'),
    'sk-ant- repeated': fill('sk-ant-'),
    'AKIA near misses': fill('AKIAAAAAAAAAAAAAAAA'),
    'echo colon': fill('echo ' + 'a:'.repeat(60) + ' '),
    'one 512KB line of a': 'a'.repeat(KB512),
    'one 512KB line of spaces': ' '.repeat(KB512),
    'many short lines': fill('password=\n'),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`512 KB of ${name} scans in under 500 ms`, () => {
      const t = performance.now();
      scanSecrets(input);
      expect(performance.now() - t).toBeLessThan(500);
    });
  }
});

describe('secretsFingerprint', () => {
  it('is sha256 of the sorted kind:line list and ignores order', () => {
    const a = secretsFingerprint([
      { kind: 'jwt', line: 3 },
      { kind: 'aws_access_key', line: 1 },
    ]);
    const b = secretsFingerprint([
      { kind: 'aws_access_key', line: 1 },
      { kind: 'jwt', line: 3 },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(secretsFingerprint([{ kind: 'aws_access_key', line: 2 }])).not.toBe(secretsFingerprint([{ kind: 'aws_access_key', line: 1 }]));
  });
});
