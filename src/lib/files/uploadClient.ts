/**
 * Browser-side upload helper with retry (3 attempts, exponential backoff). Works with the target
 * returned by createUploadTarget (server action). No server imports: safe in client components.
 */
export type UploadTarget =
  | { kind: 'local'; url: string; storagePath: string }
  | { kind: 'supabase-signed'; signedUrl: string; token: string; storagePath: string };

export type UploadClientOptions = {
  attempts?: number; // default 3
  baseDelayMs?: number; // default 500 (500, 1000, ...)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Extra multipart fields for the local route (kind, sessionId). */
  fields?: Record<string, string>;
};

class NonRetryable extends Error {}

export async function uploadWithRetry(file: File, target: UploadTarget, opts: UploadClientOptions = {}): Promise<{ storagePath: string }> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const body = new FormData();
      let res: Response;
      if (target.kind === 'local') {
        for (const [k, v] of Object.entries(opts.fields ?? {})) body.append(k, v);
        // Same path on every attempt, so a retry after a lost response overwrites instead of orphaning.
        body.append('storagePath', target.storagePath);
        body.append('file', file);
        res = await doFetch(target.url, { method: 'POST', body });
      } else {
        // Same wire format as supabase-js uploadToSignedUrl: PUT multipart, file under the empty field name.
        body.append('cacheControl', '3600');
        body.append('', file);
        res = await doFetch(target.signedUrl, { method: 'PUT', body, headers: { 'x-upsert': 'true' } });
      }
      // 409 = the object already exists: an earlier attempt landed and only its response was lost.
      if (res.ok || (target.kind === 'supabase-signed' && res.status === 409)) {
        if (target.kind === 'local') return (await res.json()) as { storagePath: string };
        return { storagePath: target.storagePath };
      }
      // 4xx (except 408/429) will not succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new NonRetryable(`Upload rejected (${res.status})`);
      }
      throw new Error(`Upload failed (${res.status})`);
    } catch (e) {
      if (e instanceof NonRetryable) throw e;
      last = e;
      if (attempt < attempts) await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Upload failed after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`);
}
