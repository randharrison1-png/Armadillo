import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/server/auth';
import { FileTooLargeError, localStoreDir, MAX_PDF_BYTES, UnsupportedFileTypeError, uploadPrivate, type UploadKind } from '@/server/files/storage';

/**
 * Local (dev/test) upload path: multipart POST { file, kind, sessionId? } -> { storagePath }.
 * Disabled in production, where the browser uploads to Supabase Storage via signed URLs
 * (createUploadTarget); Vercel's body limit would reject large files here anyway.
 */
const KINDS: readonly UploadKind[] = ['readme', 'script', 'report', 'evidence'];

export async function POST(request: NextRequest) {
  if (!localStoreDir()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await getCurrentUser())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_PDF_BYTES + 1024 * 1024) return NextResponse.json({ error: 'File too large' }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }
  const file = form.get('file');
  const kind = form.get('kind');
  const sessionId = form.get('sessionId');
  const storagePath = form.get('storagePath');
  if (!(file instanceof File) || typeof kind !== 'string' || !KINDS.includes(kind as UploadKind)) {
    return NextResponse.json({ error: 'file and a valid kind are required' }, { status: 400 });
  }
  try {
    const result = await uploadPrivate(file, {
      kind: kind as UploadKind,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : undefined,
    }, { storagePath: typeof storagePath === 'string' && storagePath ? storagePath : undefined });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof UnsupportedFileTypeError) return NextResponse.json({ error: e.message }, { status: 415 });
    if (e instanceof FileTooLargeError) return NextResponse.json({ error: e.message }, { status: 413 });
    if (e instanceof Error && /^Invalid (session|owner) id|^Invalid storage path/.test(e.message)) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
