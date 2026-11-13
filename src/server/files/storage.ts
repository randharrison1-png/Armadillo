import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireUser } from '@/server/auth';
import type { UploadTarget } from '@/lib/files/uploadClient';
import { validateUpload, type UploadKind } from './limits';

export * from './limits';

export interface FileStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  removePrefix(prefix: string): Promise<void>;
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
  constructor(root: string) {
    this.root = path.resolve(root);
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
  async removePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

export const PRIVATE_BUCKET = 'private-files';

/** Production store: Supabase Storage, service-role key (server-side only). Never import client-side. */
export class SupabaseFileStore implements FileStore {
  constructor(private readonly client: SupabaseClient = serviceClient()) {}
  async put(p: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertSafePath(p);
    const { error } = await this.client.storage.from(PRIVATE_BUCKET).upload(p, bytes, { contentType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }
  async get(p: string): Promise<Uint8Array> {
    assertSafePath(p);
    const { data, error } = await this.client.storage.from(PRIVATE_BUCKET).download(p);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? 'not found'}`);
    return new Uint8Array(await data.arrayBuffer());
  }
  async removePrefix(prefix: string): Promise<void> {
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
    for (let i = 0; i < files.length; i += 100) {
      const { error } = await bucket.remove(files.slice(i, i + 100));
      if (error) throw new Error(`Storage remove failed: ${error.message}`);
    }
  }
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase file storage');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** LocalFileStore when LOCAL_FILE_STORE_DIR is set (dev/test), otherwise Supabase Storage. */
export function getFileStore(): FileStore {
  const dir = process.env.LOCAL_FILE_STORE_DIR;
  return dir ? new LocalFileStore(dir) : new SupabaseFileStore();
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
export async function uploadPrivate(file: File, scope: UploadScope): Promise<{ storagePath: string }> {
  const user = await requireUser();
  validateUpload(file.name, file.size, scope.kind);
  const storagePath = buildStoragePath(user.id, scope.sessionId, file.name);
  await getFileStore().put(storagePath, new Uint8Array(await file.arrayBuffer()), file.type || 'application/octet-stream');
  return { storagePath };
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
  if (process.env.LOCAL_FILE_STORE_DIR) return { kind: 'local', url: LOCAL_UPLOAD_URL, storagePath };
  const { data, error } = await serviceClient().storage.from(PRIVATE_BUCKET).createSignedUploadUrl(storagePath);
  if (error || !data) throw new Error(`Could not create upload URL: ${error?.message ?? 'unknown error'}`);
  return { kind: 'supabase-signed', signedUrl: data.signedUrl, token: data.token, storagePath };
}

