import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { CATEGORY_LABEL } from '@/features/library/filters';
import { getScriptWithContent } from '@/features/library/queries';

export const metadata: Metadata = { title: 'Script · Armadillo' };

/** Read-only view of a script's current version. Task 9 replaces this with the editor and version history. */
export default async function ScriptPage({ params }: { params: Promise<{ scriptId: string }> }) {
  const { scriptId } = await params;
  const found = await getScriptWithContent(scriptId);
  if (!found) notFound();
  const { script, version } = found;
  return (
    <div className="flex flex-col gap-4 p-6">
      <Link
        href="/app/library"
        className="flex w-fit items-center gap-2 rounded-sm text-small text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Script Library
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-semibold text-text">{script.name}</h1>
        <p className="text-small text-muted">
          <span className="font-mono text-text">{script.filename}</span> · {CATEGORY_LABEL[script.category]} · v{version.version_no}
        </p>
        {script.description ? <p className="text-body text-text">{script.description}</p> : null}
      </div>
      <pre className="overflow-auto rounded-md border border-border bg-surface p-4 font-mono text-small text-text" tabIndex={0} aria-label="Script content">
        {version.content}
      </pre>
    </div>
  );
}
