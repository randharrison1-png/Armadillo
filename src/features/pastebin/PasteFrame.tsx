'use client';

import { useState, type ReactNode } from 'react';
import { Check, Copy, Download, FileText, Link2, WrapText } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const btn = buttonVariants({ variant: 'secondary' });

/**
 * Toolbar + wrap toggle around the server-rendered code (`children`). Copy fetches the raw text
 * from /p/<slug>/raw so the (up to 512 KB) content is not sent to the browser twice.
 */
export function PasteFrame({ slug, children }: { slug: string; children: ReactNode }) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState<'copy' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function write(kind: 'copy' | 'share', getText: () => Promise<string> | string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(await getText());
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 2000);
    } catch {
      setError(kind === 'copy' ? 'Could not copy. Select the text and copy it manually.' : 'Could not copy the link.');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          onClick={() =>
            write('copy', async () => {
              const res = await fetch(`/p/${slug}/raw`, { cache: 'no-store' });
              if (!res.ok) throw new Error('raw fetch failed');
              return res.text();
            })
          }
        >
          {copied === 'copy' ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
          {copied === 'copy' ? 'Copied' : 'Copy'}
        </button>
        <a className={btn} href={`/p/${slug}/raw?download=1`}>
          <Download aria-hidden className="size-4" />
          Download
        </a>
        <a className={btn} href={`/p/${slug}/raw`}>
          <FileText aria-hidden className="size-4" />
          Raw
        </a>
        <button type="button" className={btn} onClick={() => write('share', () => `${window.location.origin}/p/${slug}`)}>
          {copied === 'share' ? <Check aria-hidden className="size-4" /> : <Link2 aria-hidden className="size-4" />}
          {copied === 'share' ? 'Link copied' : 'Share'}
        </button>
        <button type="button" aria-pressed={wrap} className={cn(btn, 'aria-pressed:bg-surface-raised aria-pressed:border-accent')} onClick={() => setWrap((w) => !w)}>
          <WrapText aria-hidden className="size-4" />
          Wrap lines
        </button>
        <span role="status" className="sr-only">
          {copied === 'copy' ? 'Copied to clipboard' : copied === 'share' ? 'Link copied' : ''}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      ) : null}
      <div data-wrap={wrap} className="paste-code min-w-0 overflow-hidden rounded-md border border-border bg-bg">
        {children}
      </div>
    </div>
  );
}
