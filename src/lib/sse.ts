/**
 * Server-sent events framing shared by the Claude route (encoder) and the browser hook (parser).
 * Wire format per event: `event: <name>\ndata: <json>\n\n`. Lines starting with `:` are comments
 * (keep-alive pings) and are ignored. JSON.stringify never emits a raw newline, so one `data:`
 * line always holds the whole payload.
 */

export type SseEvent = { event: string; data: unknown };

export function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE comment line: keeps proxies from closing an idle stream. */
export const SSE_PING = ': ping\n\n';

/**
 * Incremental parser: feed decoded text chunks with `push` (split anywhere), call `end` at EOF.
 * Events whose data is not valid JSON are skipped.
 */
export function createSseParser(onEvent: (e: SseEvent) => void): { push: (chunk: string) => void; end: () => void } {
  let buffer = '';

  const dispatch = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;
    try {
      onEvent({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      // Malformed payload: ignore this event.
    }
  };

  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        dispatch(block);
      }
    },
    end() {
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    },
  };
}
