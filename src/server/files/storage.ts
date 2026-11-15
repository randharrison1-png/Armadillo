import 'server-only';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireUser } from '@/server/auth';
import type { UploadTarget } from '@/lib/files/uploadClient';
import { ALLOWED_EXTENSIONS, extensionOf, FileTooLargeError, limitFor, UnsupportedFileTypeError, validateUpload, type UploadKind } from './limits';

export * from './limits';

export interface FileStore {
  /** Stores an object. Fails if it exists unless `opts.upsert` (the local store always overwrites). */
  put(path: string, bytes: Uint8Array, contentType: string, opts?: { upsert?: boolean }): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  removePrefix(prefix: string): Promise<void>;
  /** Size of the stored object, or null if it does not exist. */
  stat(path: string): Promise<{ size: number } | null>;
  /** Every object path under `prefix` (recursive, bucket-relative, `/`-separated); [] if there are none. */
  list(prefix: string): Promise<string[]>;
  /**
   * A time-limited URL from which the (private) object downloads as an attachment named `filename`.
   * Supabase: a signed Storage URL. Local store: an HMAC-signed route that also requires the same signed-in user.
   */
  signDownload(path: string, opts: { ttlSeconds: number; filename: string }): Promise<string>;
}

export const LOCAL_SIGNED_URL = '/api/files/signed';

function localSigningSecret(explicit?: string): string {
  const secret = explicit ?? process.env.LOCAL_FILE_SIGNING_SECRET ?? process.env.TEST_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('LOCAL_FILE_SIGNING_SECRET (or TEST_AUTH_SECRET) of at least 32 characters is required for local signed downloads');
  return secret;
}

const localSignature = (secret: string, p: string, exp: string, name: string) =>
  createHmac('sha256', secret).update(`${p}\n${exp}\n${name}`).digest('base64url');

/**
 * Checks the query of a LocalFileStore signed URL (`p`, `exp`, `n`, `sig`): signature, then expiry.
 * Returns the object path and download name, or null. The caller must still check the path belongs to
 * the signed-in user.
 */
export function verifyLocalDownloadUrl(
  params: URLSearchParams,
  secret?: string,
  nowMs: number = Date.now(),
): { path: string; filename: string } | null {
  const p = params.get('p');
  const exp = params.get('exp');
  const name = params.get('n');
  const sig = params.get('sig');
  if (!p || !exp || !name || !sig || !/^\d{1,12}$/.test(exp)) return null;
  const expected = Buffer.from(localSignature(localSigningSecret(secret), p, exp, name));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Math.floor(nowMs / 1000) >= Number(exp)) return null;
  return { path: p, filename: name };
}

export type UploadScope = { sessionId?: string; kind: UploadKind };

export class ForbiddenFileError extends Error {
  readonly name = 'ForbiddenFileError';
  constructor() {
    super('Forbidden: you do not own this file');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects empty paths, absolute paths, backslashes, NULs and empty/`.`/`..` segments. */
function assertSafePath(p: string): string[] {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) {
    throw new Error(`Invalid storage path: ${JSON.stringify(p)}`);
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid storage path: ${JSON.stringify(p)}`);
  }
  return segments;
}

/** Dev/test store on the local disk. Everything stays under `root`. */
export class LocalFileStore implements FileStore {
  private readonly root: string;
  constructor(
    root: string,
    private readonly signingSecret?: string,
  ) {
    this.root = path.resolve(root);
  }
  async signDownload(p: string, opts: { ttlSeconds: number; filename: string }): Promise<string> {
    assertSafePath(p);
    const exp = String(Math.floor(Date.now() / 1000) + opts.ttlSeconds);
    const sig = localSignature(localSigningSecret(this.signingSecret), p, exp, opts.filename);
    return `${LOCAL_SIGNED_URL}?${new URLSearchParams({ p, exp, n: opts.filename, sig })}`;
  }
  private resolve(p: string): string {
    assertSafePath(p);
    const full = path.resolve(this.root, p);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Invalid storage path: ${JSON.stringify(p)}`);
    return full;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the FileStore signature
  async put(p: string, bytes: Uint8Array, _contentType?: string): Promise<void> {
    const full = this.resolve(p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  async get(p: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(p)));
  }
  async stat(p: string): Promise<{ size: number } | null> {
    try {
      const st = await stat(this.resolve(p));
      return st.isFile() ? { size: st.size } : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async removePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(this.resolve(rel), { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        throw e;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(`${rel}/${e.name}`);
        else if (e.isFile()) out.push(`${rel}/${e.name}`);
      }
    };
    await walk(prefix);
    return out.sort();
  }
}

export const PRIVATE_BUCKET = 'private-files';

/** Production store: Supabase Storage, service-role key (server-side only). Never import client-side. */
export class SupabaseFileStore implements FileStore {
  constructor(private readonly client: SupabaseClient = serviceClient()) {}
  async put(p: string, bytes: Uint8Array, contentType: string, opts: { upsert?: boolean } = {}): Promise<void> {
    assertSafePath(p);
    const { error } = await this.client.storage.from(PRIVATE_BUCKET).upload(p, bytes, { contentType, upsert: opts.upsert ?? false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }
  async signDownload(p: string, opts: { ttlSeconds: number; filename: string }): Promise<string> {
    assertSafePath(p);
    const { data, error } = await this.client.storage.from(PRIVATE_BUCKET).createSignedUrl(p, opts.ttlSeconds, { download: opts.filename });
    if (error || !data) throw new Error(`Could not sign download: ${error?.message ?? 'unknown error'}`);
    return data.signedUrl;
  }
  async get(p: string): Promise<Uint8Array> {
    assertSafePath(p);
    const { data, error } = await this.client.storage.from(PRIVATE_BUCKET).download(p);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? 'not found'}`);
    return new Uint8Array(await data.arrayBuffer());
  }
  async stat(p: string): Promise<{ size: number } | null> {
    const segments = assertSafePath(p);
    const name = segments.pop()!;
    const { data, error } = await this.client.storage.from(PRIVATE_BUCKET).list(segments.join('/'), { search: name, limit: 100 });
    if (error) throw new Error(`Storage stat failed: ${error.message}`);
    const hit = data?.find((e) => e.name === name && e.id);
    const size = (hit?.metadata as { size?: number } | null | undefined)?.size;
    return hit && typeof size === 'number' ? { size } : null;
  }
  async list(prefix: string): Promise<string[]> {
    assertSafePath(prefix);
    const bucket = this.client.storage.from(PRIVATE_BUCKET);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await bucket.list(dir, { limit: 100, offset });
        if (error) throw new Error(`Storage list failed: ${error.message}`);
        for (const e of data ?? []) {
          // Folders have no id/metadata in Supabase list results.
          if (e.id) files.push(`${dir}/${e.name}`);
          else await walk(`${dir}/${e.name}`);
        }
        if (!data || data.length < 100) break;
      }
    };
    await walk(prefix);
    return files;
  }
  async removePrefix(prefix: string): Promise<void> {
    const files = await this.list(prefix);
    const bucket = this.client.storage.from(PRIVATE_BUCKET);
    for (let i = 0; i < files.length; i += 100) {
      const { error } = await bucket.remove(files.slice(i, i + 100));
      if (error) throw new Error(`Storage remove failed: ${error.message}`);
    }
  }
}

/** Supabase client with the service-role key (server-side only): Storage and the Auth admin API. */
export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase file storage');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * LocalFileStore when LOCAL_FILE_STORE_DIR is set (dev/test only), otherwise Supabase Storage. On
 * Vercel the local store is refused (its disk is ephemeral and per instance, and it would also enable
 * the local upload route): a copied .env with LOCAL_FILE_STORE_DIR set must fail loudly, not silently.
 */
export function getFileStore(): FileStore {
  const dir = localStoreDir();
  return dir ? new LocalFileStore(dir) : new SupabaseFileStore();
}

/** LOCAL_FILE_STORE_DIR (trimmed) or null; throws on Vercel (see getFileStore). The one place that reads it. */
export function localStoreDir(env: Record<string, string | undefined> = process.env): string | null {
  const dir = env.LOCAL_FILE_STORE_DIR?.trim();
  if (!dir) return null;
  if (env.VERCEL !== undefined) {
    throw new Error('LOCAL_FILE_STORE_DIR is set on Vercel. The local file store is for local development and tests only: unset it so Supabase Storage is used.');
  }
  return dir;
}

/** Keeps a safe basename: no directories, `[A-Za-z0-9._-]` only, <= 100 chars, never empty. */
export function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return /[A-Za-z0-9]/.test(base) ? base : 'file';
}

/** `{ownerId}/{sessionId|library}/{uuid}-{sanitized filename}`. */
export function buildStoragePath(ownerId: string, sessionId: string | undefined, filename: string): string {
  if (!UUID_RE.test(ownerId)) throw new Error('Invalid owner id');
  if (sessionId !== undefined && !UUID_RE.test(sessionId)) throw new Error('Invalid session id');
  return `${ownerId}/${sessionId ?? 'library'}/${randomUUID()}-${sanitizeFilename(filename)}`;
}

/**
 * Server-side entry point for files that reach the server (server actions, the local route
 * handler; <= 4 MB). Validates type and size, then stores under the signed-in user's prefix.
 */
export async function uploadPrivate(
  file: File,
  scope: UploadScope,
  opts: { storagePath?: string } = {},
): Promise<{ storagePath: string }> {
  const user = await requireUser();
  validateUpload(file.name, file.size, scope.kind);
  // A client-chosen path (retry idempotency) is accepted only if it is exactly what we would generate.
  const storagePath = opts.storagePath ? assertOwnedUploadPath(opts.storagePath, user.id, scope.sessionId, file.name) : buildStoragePath(user.id, scope.sessionId, file.name);
  await getFileStore().put(storagePath, new Uint8Array(await file.arrayBuffer()), file.type || 'application/octet-stream');
  return { storagePath };
}

function assertOwnedUploadPath(p: string, ownerId: string, sessionId: string | undefined, filename: string): string {
  const seg = assertSafePath(p);
  const ok =
    seg.length === 3 &&
    seg[0] === ownerId &&
    seg[1] === (sessionId ?? 'library') &&
    seg[2]!.slice(36, 37) === '-' &&
    UUID_RE.test(seg[2]!.slice(0, 36)) &&
    seg[2]!.slice(37) === sanitizeFilename(filename);
  if (!ok) throw new Error('Invalid storage path for this upload');
  return p;
}

/**
 * Re-checks an uploaded object before a caller records its path (needed for direct-to-Storage
 * uploads, whose declared size/type the server never saw): owner prefix, extension allowlist for
 * `kind`, and the ACTUAL stored size. Tasks 8/10/16/18 must call this before saving a storage_path.
 */
export async function verifyStoredUpload(storagePath: string, kind: UploadKind): Promise<{ size: number }> {
  const user = await requireUser();
  const segments = assertSafePath(storagePath);
  if (segments[0] !== user.id || segments.length < 3) throw new ForbiddenFileError();
  const filename = segments[segments.length - 1]!;
  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS[kind].includes(ext)) throw new UnsupportedFileTypeError(filename, ALLOWED_EXTENSIONS[kind]);
  const st = await getFileStore().stat(storagePath);
  if (!st) throw new Error('Uploaded file not found');
  const limit = limitFor(ext, kind);
  if (st.size > limit) throw new FileTooLargeError(filename, st.size, limit);
  return st;
}

/** Reads a private file, refusing any path that is not under the current user's prefix. */
export async function readPrivate(storagePath: string): Promise<Uint8Array> {
  const user = await requireUser();
  const segments = assertSafePath(storagePath);
  if (segments[0] !== user.id || segments.length < 3) throw new ForbiddenFileError();
  return getFileStore().get(storagePath);
}

export type { UploadTarget };

export const LOCAL_UPLOAD_URL = '/api/files/upload';

/**
 * Where the browser should send a file. Local (LOCAL_FILE_STORE_DIR set): POST multipart to the
 * route handler, which stores it itself via uploadPrivate (and returns the authoritative path;
 * the `storagePath` here is only a preview). Production: a Supabase signed upload URL, so large
 * files go straight to Storage and bypass the serverless body limit.
 */
export async function createUploadTarget(scope: UploadScope, filename: string, size: number): Promise<UploadTarget> {
  const user = await requireUser();
  validateUpload(filename, size, scope.kind);
  const storagePath = buildStoragePath(user.id, scope.sessionId, filename);
  if (localStoreDir()) return { kind: 'local', url: LOCAL_UPLOAD_URL, storagePath };
  const { data, error } = await serviceClient().storage.from(PRIVATE_BUCKET).createSignedUploadUrl(storagePath);
  if (error || !data) throw new Error(`Could not create upload URL: ${error?.message ?? 'unknown error'}`);
  return { kind: 'supabase-signed', signedUrl: data.signedUrl, token: data.token, storagePath };
}

