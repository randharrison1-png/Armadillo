// @vitest-environment node
// (The Anthropic SDK refuses to construct in a browser-like environment such as jsdom.)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAnthropicMock, type AnthropicMock } from '../support/anthropic-mock';
import { encodeSseEvent, createSseParser } from '@/lib/sse';
import { ClaudeUpstreamError, DEFAULT_MODEL, resolveModel, scrubSecrets, streamUpstream } from '@/server/claude/client';
import { buildHistory, conversationTitle } from '@/server/claude/history';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*\(?\s*['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]).filter(Boolean);
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const directive = (file: string, d: 'use client' | 'use server') =>
  new RegExp(`^(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*['"]${d}['"]`).test(readFileSync(file, 'utf8'));

describe('server-only boundary', () => {
  it('client module cannot be imported in a client bundle', () => {
    const gateway = path.join(SRC, 'server', 'claude', 'client.ts');
    const crypto = path.join(SRC, 'server', 'security', 'crypto.ts');
    const keys = path.join(SRC, 'server', 'claude', 'keys.ts');
    for (const file of [gateway, crypto, keys]) {
      // The first statement is the server-only marker: Next fails the build if a client bundle reaches it.
      const code = readFileSync(file, 'utf8').replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
      expect(code.startsWith("import 'server-only';"), file).toBe(true);
    }

    // Outside the react-server condition (i.e. in any client bundle) the marker package throws.
    const require = createRequire(import.meta.url);
    expect(() => require(path.join(ROOT, 'node_modules', 'server-only', 'index.js'))).toThrow(/Client Component/);

    // The SDK is imported by the gateway module only.
    const files = walk(SRC);
    const sdkImporters = files.filter((f) => importsOf(f).some((s) => s === '@anthropic-ai/sdk' || s.startsWith('@anthropic-ai/sdk/')));
    expect(sdkImporters.map((f) => path.relative(ROOT, f))).toEqual(['src/server/claude/client.ts']);

    // No client module reaches the gateway, the key store or the crypto module through static
    // imports. Server actions ('use server' files) are boundaries: the client only gets references.
    const forbidden = (f: string) => f.startsWith(path.join(SRC, 'server', 'claude')) || f.startsWith(path.join(SRC, 'server', 'security'));
    const clientEntries = files.filter((f) => directive(f, 'use client'));
    expect(clientEntries.length).toBeGreaterThan(0);
    for (const entry of clientEntries) {
      const seen = new Set<string>([entry]);
      const queue = [entry];
      while (queue.length) {
        const file = queue.shift()!;
        expect(forbidden(file), `${path.relative(ROOT, entry)} reaches ${path.relative(ROOT, file)}`).toBe(false);
        for (const spec of importsOf(file)) {
          const next = resolveLocal(file, spec);
          if (!next || seen.has(next)) continue;
          seen.add(next);
          if (directive(next, 'use server')) continue;
          queue.push(next);
        }
      }
    }
  });
});

describe('SSE framing', () => {
  it('encodes `event: <name>\\ndata: <json>\\n\\n` and parses it back across arbitrary chunk splits', () => {
    const wire =
      encodeSseEvent('delta', { text: 'Hello\nworld' }) + ': ping\n\n' + encodeSseEvent('done', { messageId: 'm1', usage: { output_tokens: 2 } });
    expect(encodeSseEvent('delta', { text: 'a' })).toBe('event: delta\ndata: {"text":"a"}\n\n');
    const events: { event: string; data: unknown }[] = [];
    const parser = createSseParser((e) => events.push(e));
    for (let i = 0; i < wire.length; i += 3) parser.push(wire.slice(i, i + 3));
    parser.end();
    expect(events).toEqual([
      { event: 'delta', data: { text: 'Hello\nworld' } },
      { event: 'done', data: { messageId: 'm1', usage: { output_tokens: 2 } } },
    ]);
  });
});

describe('model and history helpers', () => {
  it('model: profile, else CLAUDE_MODEL, else the default', () => {
    expect(resolveModel('claude-profile', { CLAUDE_MODEL: 'claude-env' })).toBe('claude-profile');
    expect(resolveModel(null, { CLAUDE_MODEL: 'claude-env' })).toBe('claude-env');
    expect(resolveModel(null, {})).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
  });

  it('title is the first ~60 characters of the first message', () => {
    expect(conversationTitle('  Harden   the\nWindows 11 image  ')).toBe('Harden the Windows 11 image');
    const long = 'x'.repeat(100);
    expect(conversationTitle(long)).toBe(`${'x'.repeat(60)}…`);
  });

  it('history keeps complete turns only, starts with a user turn, merges same-role runs and fits the budget', () => {
    const h = buildHistory(
      [
        { role: 'assistant', content: 'orphan', status: 'complete' },
        { role: 'user', content: 'q1', status: 'complete' },
        { role: 'assistant', content: 'partial', status: 'error' },
        { role: 'user', content: 'q2', status: 'complete' },
        { role: 'assistant', content: 'a2', status: 'complete' },
        { role: 'assistant', content: '', status: 'complete' },
      ],
      { maxMessages: 40, maxChars: 10_000 },
    );
    expect(h).toEqual([
      { role: 'user', content: 'q1\n\nq2' },
      { role: 'assistant', content: 'a2' },
    ]);

    const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}-${'y'.repeat(100)}`, status: 'complete' }) as const);
    const trimmed = buildHistory(many, { maxMessages: 40, maxChars: 1_000 });
    expect(trimmed.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(1_000);
    expect(trimmed[0].role).toBe('user');
    expect(trimmed.at(-1)!.content).toBe(many.at(-1)!.content); // newest turns are kept
    expect(buildHistory(many, { maxMessages: 4, maxChars: 100_000 })).toHaveLength(4);
  });
});

describe('streamUpstream (against the mock)', () => {
  let mock: AnthropicMock;
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  beforeAll(async () => {
    mock = await startAnthropicMock();
    process.env.ANTHROPIC_BASE_URL = mock.url;
    process.env.CLAUDE_MAX_RETRIES = '0';
  });
  afterAll(async () => {
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBase;
    await mock.close();
  });
  beforeEach(() => mock.reset());

  const run = async (apiKey: string) => {
    const texts: string[] = [];
    const gen = streamUpstream({ apiKey, model: 'claude-test', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 });
    for (;;) {
      const n = await gen.next();
      if (n.done) return { texts, result: n.value };
      texts.push(n.value.text);
    }
  };

  it('streams text deltas with the given key and reports usage and model', async () => {
    mock.enqueue({ chunks: ['Hel', 'lo'], usage: { input_tokens: 5, output_tokens: 2 }, model: 'claude-test' });
    const { texts, result } = await run('sk-ant-unit-key-1111');
    expect(texts).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({ model: 'claude-test', usage: { input_tokens: 5, output_tokens: 2 }, stopReason: 'end_turn' });
    const [req] = mock.requests();
    expect(req.apiKey).toBe('sk-ant-unit-key-1111');
    expect(req.body).toMatchObject({ model: 'claude-test', stream: true, system: 'sys', max_tokens: 64 });
  });

  it('a mid-stream 529 (overloaded error event) is a retryable upstream error after the partial text', async () => {
    mock.enqueue({ chunks: ['part', 'ial', 'never'], failAfter: 2, failWith: 'overloaded' });
    const texts: string[] = [];
    const gen = streamUpstream({ apiKey: 'sk-ant-unit-key-2222', model: 'm', system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    const err = await (async () => {
      try {
        for (;;) {
          const n = await gen.next();
          if (n.done) return null;
          texts.push(n.value.text);
        }
      } catch (e) {
        return e;
      }
    })();
    expect(texts).toEqual(['part', 'ial']);
    expect(err).toBeInstanceOf(ClaudeUpstreamError);
    expect(err).toMatchObject({ retryable: true, code: 'overloaded' });
  });

  it('a dropped connection mid-stream is a retryable error', async () => {
    mock.enqueue({ chunks: ['a', 'b'], failAfter: 1, failWith: 'drop' });
    await expect(run('sk-ant-unit-key-3333')).rejects.toMatchObject({ retryable: true });
  });

  it('auth failures are not retryable and upstream messages never carry the key', async () => {
    const key = 'sk-ant-api03-SECRETSECRETSECRET';
    mock.enqueue({ fail: { status: 401, message: `invalid x-api-key ${key}` } });
    const err = (await run(key).catch((e: unknown) => e)) as ClaudeUpstreamError;
    expect(err).toBeInstanceOf(ClaudeUpstreamError);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('auth');
    expect(`${err.message} ${err.stack}`).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);

    mock.enqueue({ fail: { status: 400, message: `bad request near ${key} and sk-ant-other-token-abc` } });
    const bad = (await run(key).catch((e: unknown) => e)) as ClaudeUpstreamError;
    expect(bad.code).toBe('invalid_request');
    expect(bad.message).not.toContain(key);
    expect(bad.message).not.toContain('sk-ant-other-token-abc');

    mock.enqueue({ fail: { status: 529 } });
    await expect(run(key)).rejects.toMatchObject({ retryable: true, code: 'overloaded' });
  });

  it('scrubSecrets removes known secrets and anything shaped like an Anthropic key', () => {
    expect(scrubSecrets('x sk-ant-api03-abc_DEF-123 y my-own-key z', ['my-own-key'])).toBe('x [redacted] y [redacted] z');
  });
});
