import Link from 'next/link';
import { Pencil, Trash2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { highlightPaste } from './highlight';
import { pasteDateTime, pasteTitle } from './format';
import { PasteFrame } from './PasteFrame';
import { ReportAbuse } from './ReportAbuse';
import { LANGUAGE_LABEL } from './schema';
import type { PublicPaste } from './service';

/**
 * Public paste page body. The only dangerouslySetInnerHTML is highlightPaste's output: Shiki's HTML
 * (every token HTML-escaped by Shiki) or, beyond the highlight cap / time budget or if highlighting
 * fails, the code fully escaped by escapeHtml in a plain <pre>. Memoized per paste version.
 */
export async function PasteView({ paste, isOwner }: { paste: PublicPaste; isOwner: boolean }) {
  const { html, fallback } = await highlightPaste(paste);
  return (
    <article className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-h1 font-semibold break-words text-text">{pasteTitle(paste.title)}</h1>
          {paste.visibility === 'unlisted' ? <span className="rounded-sm border border-border px-2 text-small text-muted">Unlisted</span> : null}
        </div>
        <p className="flex flex-wrap gap-x-4 text-small text-muted">
          <span>{LANGUAGE_LABEL[paste.language]}</span>
          <span>Created {pasteDateTime(paste.created_at)}</span>
          <span>{paste.expires_at ? `Expires ${pasteDateTime(paste.expires_at)}` : 'Never expires'}</span>
        </p>
        {isOwner ? (
          <div className="flex gap-2">
            <Link href={`/app/pastes?edit=${paste.slug}`} className={buttonVariants({ variant: 'secondary' })}>
              <Pencil aria-hidden className="size-4" />
              Edit
            </Link>
            <Link href={`/app/pastes?delete=${paste.slug}`} className={buttonVariants({ variant: 'secondary' })}>
              <Trash2 aria-hidden className="size-4" />
              Delete
            </Link>
          </div>
        ) : null}
      </header>
      <PasteFrame slug={paste.slug}>
        {fallback === 'too_large' || fallback === 'timeout' ? (
          <p className="border-b border-border px-4 py-2 text-small text-muted">This paste is too large to highlight; it is shown as plain text.</p>
        ) : null}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </PasteFrame>
      <footer>
        <ReportAbuse slug={paste.slug} />
      </footer>
    </article>
  );
}
