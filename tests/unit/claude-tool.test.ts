// @vitest-environment node
// (The Anthropic SDK refuses to construct in a browser-like environment such as jsdom.)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startAnthropicMock, type AnthropicMock } from '../support/anthropic-mock';
import { ClaudeUpstreamError, runToolCall, StructuredOutputError, toolMaxTokens } from '@/server/claude/client';

let mock: AnthropicMock;

beforeAll(async () => {
  mock = await startAnthropicMock();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.CLAUDE_MAX_RETRIES = '0';
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

const tool = {
  name: 'record_things',
  description: 'Records things.',
  input_schema: {
    type: 'object',
    properties: { things: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    required: ['things'],
  },
};
const schema = z.object({ things: z.array(z.object({ name: z.string().min(1) })) });

const call = () =>
  runToolCall({
    apiKey: 'sk-test-0000',
    model: 'claude-test',
    system: 'system prompt',
    content: [
      { type: 'text', text: '<documents/>' },
      { type: 'text', text: 'List the things.' },
    ],
    tool,
    schema,
    maxTokens: 1000,
  });

type Req = { tools?: { name: string }[]; tool_choice?: unknown; stream?: boolean; messages: { role: string; content: unknown }[] };
const bodies = () => mock.requests().map((r) => r.body as Req);

describe('runToolCall (structured output)', () => {
  it('forces the tool and returns the validated input', async () => {
    mock.enqueue({ toolUse: { input: { things: [{ name: 'a' }, { name: 'b' }] } } });
    const out = await call();
    expect(out.data).toEqual({ things: [{ name: 'a' }, { name: 'b' }] });
    expect(out.attempts).toBe(1);
    const [body] = bodies();
    expect(body.stream).toBeFalsy();
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_things' });
    expect(body.tools?.map((t) => t.name)).toEqual(['record_things']);
    expect(body.messages).toHaveLength(1);
  });

  it('retries once with the validation error, then succeeds', async () => {
    mock.enqueue({ toolUse: { input: { things: [{ name: '' }] } } }, { toolUse: { input: { things: [{ name: 'ok' }] } } });
    const out = await call();
    expect(out.data).toEqual({ things: [{ name: 'ok' }] });
    expect(out.attempts).toBe(2);
    const reqs = bodies();
    expect(reqs).toHaveLength(2);
    // The retry replays Claude's tool call and answers it with an error tool_result naming the problem.
    const retry = reqs[1].messages;
    expect(retry).toHaveLength(3);
    expect(retry[1].role).toBe('assistant');
    expect(JSON.stringify(retry[1].content)).toContain('tool_use');
    const result = (retry[2].content as { type: string; is_error?: boolean; content?: unknown }[])[0];
    expect(result.type).toBe('tool_result');
    expect(result.is_error).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/things/);
    expect(reqs[1].tool_choice).toEqual({ type: 'tool', name: 'record_things' });
  });

  it('a reply without a tool call counts as invalid output', async () => {
    mock.enqueue({ chunks: ['I will not use the tool.'] }, { toolUse: { input: { things: [] } } });
    const out = await call();
    expect(out.data).toEqual({ things: [] });
    expect(bodies()).toHaveLength(2);
  });

  it('throws StructuredOutputError after the one retry also fails', async () => {
    mock.enqueue({ toolUse: { input: { nope: 1 } } }, { toolUse: { input: { things: 'x' } } }, { toolUse: { input: { things: [] } } });
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect((err as StructuredOutputError).code).toBe('structured_output');
    expect((err as Error).message).toMatch(/expected format/);
    expect(bodies()).toHaveLength(2); // exactly one automatic retry
  });

  it('a truncated answer (max_tokens) fails at once with a specific error: no automatic retry', async () => {
    mock.enqueue({ toolUse: { input: { things: [{ name: 'a' }] } }, stopReason: 'max_tokens' }, { toolUse: { input: { things: [{ name: 'a' }] } } });
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect((err as StructuredOutputError).code).toBe('output_truncated');
    expect((err as Error).message).toMatch(/cut off/);
    expect(bodies()).toHaveLength(1);
  });

  it('a model that refuses a forced tool_choice is asked again with auto and an instruction, and is remembered', async () => {
    const refusal = { fail: { status: 400, type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } };
    mock.enqueue(refusal, { toolUse: { input: { things: [{ name: 'a' }] } } }, { toolUse: { input: { things: [{ name: 'b' }] } } });
    const call2 = (model: string) => runToolCall({
      apiKey: 'sk-test-0000', model, system: 'system prompt', content: [{ type: 'text', text: 'List the things.' }], tool, schema, maxTokens: 1000,
    });
    const out = await call2('claude-no-forcing');
    expect(out.data).toEqual({ things: [{ name: 'a' }] });
    expect(out.attempts).toBe(1);
    const reqs = bodies();
    expect(reqs).toHaveLength(2);
    expect(reqs[0].tool_choice).toEqual({ type: 'tool', name: 'record_things' });
    expect(reqs[1].tool_choice).toEqual({ type: 'auto' });
    expect(reqs[1].tools?.map((t) => t.name)).toEqual(['record_things']);
    expect(JSON.stringify(reqs[1].messages[0].content)).toMatch(/calling the record_things tool/);
    // the next call for that model goes straight to auto
    const again = await call2('claude-no-forcing');
    expect(again.data).toEqual({ things: [{ name: 'b' }] });
    expect(bodies()).toHaveLength(3);
    expect(bodies()[2].tool_choice).toEqual({ type: 'auto' });
  });

  it('other 400 errors are not mistaken for a tool_choice refusal', async () => {
    mock.enqueue({ fail: { status: 400, type: 'invalid_request_error', message: 'max_tokens: too large' } });
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeUpstreamError);
    expect(bodies()).toHaveLength(1);
  });

  it('upstream failures are ClaudeUpstreamError and are not retried as validation errors', async () => {
    mock.enqueue({ fail: { status: 529 } });
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeUpstreamError);
    expect((err as ClaudeUpstreamError).code).toBe('overloaded');
    expect(bodies()).toHaveLength(1);
  });
});

describe('toolMaxTokens', () => {
  it('a blank CLAUDE_TOOL_MAX_TOKENS (copied from .env.example) means the default', () => {
    const prev = process.env.CLAUDE_TOOL_MAX_TOKENS;
    try {
      process.env.CLAUDE_TOOL_MAX_TOKENS = '';
      expect(toolMaxTokens()).toBe(16_000);
      process.env.CLAUDE_TOOL_MAX_TOKENS = '4096';
      expect(toolMaxTokens()).toBe(4096);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_TOOL_MAX_TOKENS;
      else process.env.CLAUDE_TOOL_MAX_TOKENS = prev;
    }
  });
});
