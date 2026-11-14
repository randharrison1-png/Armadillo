import Link from 'next/link';
import { Pencil, Trash2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { highlightCode, MAX_HIGHLIGHT_CHARS } from './highlight';
import { pasteDateTime, pasteTitle } from './format';
import { PasteFrame } from './PasteFrame';
import { ReportAbuse } from './ReportAbuse';
import { LANGUAGE_LABEL } from './schema';
import type { PublicPaste } from './service';

/**
 * Public paste page body. The only dangerouslySetInnerHTML is Shiki's codeToHtml output (every token
 * is HTML-escaped by Shiki); beyond the highlight cap, or if highlighting fails, the code is a plain
 * <pre> whose text React escapes.
 */
export async function PasteView({ paste, isOwner }: { paste: PublicPaste; isOwner: boolean }) {
  const { html } = await highlightCode(paste.content, paste.language);
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
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <>
            {paste.content.length > MAX_HIGHLIGHT_CHARS ? (
              <p className="border-b border-border px-4 py-2 text-small text-muted">This paste is too large to highlight; it is shown as plain text.</p>
            ) : null}
            <pre tabIndex={0}>
              <code>{paste.content}</code>
            </pre>
          </>
        )}
      </PasteFrame>
      <footer>
        <ReportAbuse slug={paste.slug} />
      </footer>
    </article>
  );
}
