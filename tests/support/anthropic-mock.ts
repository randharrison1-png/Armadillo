/**
 * A local stand-in for the Anthropic Messages API (POST /v1/messages), so no test ever calls the
 * real API. Point the app at it with ANTHROPIC_BASE_URL=<mock.url>.
 *
 * - `stream: true` answers with the real SSE event sequence: message_start, content_block_start,
 *   content_block_delta (text_delta) per chunk, content_block_stop, message_delta (stop_reason +
 *   usage), message_stop. Otherwise it answers with one JSON Message.
 * - Scriptable: queue responses with `enqueue(...)`. Each request takes the first queued response
 *   whose `match` is a substring of the request's last user message (or has no `match`); with no
 *   queued response it replies "Mock reply: <last user text>" in a few chunks.
 * - Failures: `{ fail: { status: 529 } }` before the stream starts (HTTP error with an Anthropic
 *   error body), or `{ chunks, failAfter: n, failWith: 'overloaded' | 'api_error' | 'drop' }` to fail
 *   mid-stream after n chunks (an SSE `error` event, as the real API reports a 529 once streaming
 *   has begun, or an abruptly closed socket).
 * - Records every request (method, path, headers, parsed body) so tests can assert e.g. the
 *   API key that was used (`apiKey`).
 *
 * In-process use (Vitest): `const mock = await startAnthropicMock()` and call methods directly.
 * Cross-process use (Playwright: started in globalSetup, driven from test workers): the same
 * operations over HTTP under /__mock/ — see `AnthropicMockClient`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockUsage = { input_tokens: number; output_tokens: number };

export type MockResponse = {
  /** Only requests whose last user message contains this text take this response. */
  match?: string;
  /** Text chunks, sent as one text_delta each (stream) or joined (non-stream). */
  chunks?: string[];
  /** Delay before each chunk, ms. */
  delayMs?: number;
  /** Delay before the response starts (headers), ms. */
  initialDelayMs?: number;
  usage?: MockUsage;
  model?: string;
  /** Fail before streaming: HTTP status with an Anthropic error JSON body. */
  fail?: { status: number; type?: string; message?: string };
  /** Fail mid-stream after this many chunks were sent. */
  failAfter?: number;
  failWith?: 'overloaded' | 'api_error' | 'drop';
  /** Use this response for this many requests (default 1). */
  times?: number;
};

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** The API key the request authenticated with (x-api-key header or `Authorization: Bearer`). */
  apiKey: string | null;
  /** True when the client went away before the response finished. */
  aborted: boolean;
};

export type AnthropicMock = {
  url: string;
  port: number;
  enqueue: (...responses: MockResponse[]) => void;
  requests: () => RecordedRequest[];
  reset: () => void;
  close: () => Promise<void>;
};

const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

type Body = { model?: string; stream?: boolean; messages?: { role: string; content: unknown }[] };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

/** The text of the request's last user message. */
export function lastUserText(body: unknown): string {
  const messages = (body as Body | null)?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return textOf(messages[i].content);
  return '';
}

/** The SDK sends the key as x-api-key (older SDKs) or `Authorization: Bearer <key>` (SDK 1.x). */
function apiKeyOf(req: IncomingMessage): string | null {
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x) return x;
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
}

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startAnthropicMock(opts: { port?: number; host?: string } = {}): Promise<AnthropicMock> {
  let queue: MockResponse[] = [];
  let recorded: RecordedRequest[] = [];
  let counter = 0;

  const take = (text: string): MockResponse | null => {
    const i = queue.findIndex((r) => r.match === undefined || text.includes(r.match));
    if (i < 0) return null;
    const r = queue[i];
    const left = (r.times ?? 1) - 1;
    if (left > 0) queue[i] = { ...r, times: left };
    else queue.splice(i, 1);
    return r;
  };

  async function handleControl(req: IncomingMessage, res: ServerResponse, path: string) {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.method === 'POST' && path === '/__mock/enqueue') {
      const parsed = JSON.parse((await readBody(req)) || '[]') as MockResponse | MockResponse[];
      queue.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      return json(200, { queued: queue.length });
    }
    if (req.method === 'POST' && path === '/__mock/reset') {
      queue = [];
      recorded = [];
      return json(200, { ok: true });
    }
    if (req.method === 'GET' && path === '/__mock/requests') return json(200, recorded);
    return json(404, { error: 'unknown mock control path' });
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse, path: string) {
    const raw = await readBody(req);
    let body: Body | null = null;
    try {
      body = JSON.parse(raw) as Body;
    } catch {
      body = null;
    }
    const record: RecordedRequest = { method: req.method ?? '', path, headers: { ...req.headers }, body, apiKey: apiKeyOf(req), aborted: false };
    recorded.push(record);
    res.on('close', () => {
      if (!res.writableFinished) record.aborted = true;
    });

    const userText = lastUserText(body);
    const r = take(userText) ?? { chunks: ['Mock reply: ', userText.slice(0, 200)] };
    const model = r.model ?? body?.model ?? 'mock-model';
    const usage = r.usage ?? { input_tokens: 12, output_tokens: 7 };
    const chunks = r.chunks ?? ['ok'];
    const id = `msg_mock_${++counter}`;
    const requestId = `req_mock_${counter}`;

    if (r.initialDelayMs) await sleep(r.initialDelayMs);

    if (r.fail) {
      const type = r.fail.type ?? ERROR_TYPE_BY_STATUS[r.fail.status] ?? 'api_error';
      res.writeHead(r.fail.status, { 'content-type': 'application/json', 'request-id': requestId, 'x-should-retry': 'false' });
      res.end(JSON.stringify({ type: 'error', error: { type, message: r.fail.message ?? `Mock ${type}` } }));
      return;
    }

    if (!body?.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': requestId });
      res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: chunks.join('') }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage,
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': requestId });
    sse(res, 'message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } },
    });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'ping', { type: 'ping' });

    for (let i = 0; i < chunks.length; i++) {
      if (r.failAfter !== undefined && i === r.failAfter) break;
      if (r.delayMs) await sleep(r.delayMs);
      if (res.destroyed) return;
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i] } });
    }

    if (r.failAfter !== undefined) {
      if (r.delayMs) await sleep(r.delayMs);
      if (r.failWith === 'drop') {
        // Let the bytes already written reach the client first, then cut the connection.
        await new Promise<void>((resolve) => res.write(': flush\n\n', () => resolve()));
        await sleep(20);
        res.socket?.destroy();
        return;
      }
      const type = r.failWith === 'api_error' ? 'api_error' : 'overloaded_error';
      sse(res, 'error', { type: 'error', error: { type, message: type === 'overloaded_error' ? 'Overloaded' : 'Internal server error' } });
      res.end();
      return;
    }

    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const run = path.startsWith('/__mock/')
      ? handleControl(req, res, path)
      : req.method === 'POST' && path === '/v1/messages'
        ? handleMessages(req, res, path)
        : Promise.resolve().then(() => {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `mock: no route ${req.method} ${path}` } }));
          });
    run.catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `mock failure: ${String(e)}` } }));
    });
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${port}`,
    port,
    enqueue: (...responses) => queue.push(...responses),
    requests: () => recorded,
    reset: () => {
      queue = [];
      recorded = [];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Drives a mock running in another process (Playwright workers → the mock started in globalSetup). */
export class AnthropicMockClient {
  constructor(readonly url: string) {}

  async enqueue(...responses: MockResponse[]): Promise<void> {
    const r = await fetch(`${this.url}/__mock/enqueue`, { method: 'POST', body: JSON.stringify(responses) });
    if (!r.ok) throw new Error(`mock enqueue failed: ${r.status}`);
  }

  async requests(): Promise<RecordedRequest[]> {
    const r = await fetch(`${this.url}/__mock/requests`);
    return (await r.json()) as RecordedRequest[];
  }

  async reset(): Promise<void> {
    await fetch(`${this.url}/__mock/reset`, { method: 'POST' });
  }
}

/** Port the e2e suite runs the mock on (playwright.config.ts points ANTHROPIC_BASE_URL here). */
export const E2E_ANTHROPIC_MOCK_PORT = Number(process.env.ANTHROPIC_MOCK_PORT ?? 3199);
