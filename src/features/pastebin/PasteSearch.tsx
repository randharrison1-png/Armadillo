import Link from 'next/link';
import { ClipboardList, Search } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { buttonVariants } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { pasteDate, pasteTitle } from './format';
import { LANGUAGE_LABEL, PASTE_LANGUAGES } from './schema';
import type { PasteListItem } from './service';

export type PasteSearchQuery = { text: string; language: string; page: number };

export function parsePasteQuery(sp: Record<string, string | string[] | undefined>): PasteSearchQuery {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? '';
  const page = Number.parseInt(one('page'), 10);
  const language = one('language');
  return {
    text: one('q').slice(0, 200),
    language: (PASTE_LANGUAGES as readonly string[]).includes(language) ? language : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

function href(q: PasteSearchQuery, page: number): string {
  const p = new URLSearchParams();
  if (q.text) p.set('q', q.text);
  if (q.language) p.set('language', q.language);
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `/p?${s}` : '/p';
}

/** Search form (plain GET, works without JS) and the result list. Previews are plain text. */
export function PasteSearch({ query, items, hasNext }: { query: PasteSearchQuery; items: PasteListItem[]; hasNext: boolean }) {
  const filtered = Boolean(query.text || query.language);
  return (
    <div className="flex flex-col gap-4">
      <form action="/p" method="get" role="search" className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="paste-q">
          Search pastes
        </label>
        <input id="paste-q" name="q" type="search" defaultValue={query.text} maxLength={200} placeholder="Search titles and content" className={cn(fieldClass, 'h-control min-w-64 flex-1')} />
        <label className="sr-only" htmlFor="paste-language">
          Language
        </label>
        <select id="paste-language" name="language" defaultValue={query.language} className={cn(fieldClass, 'h-control w-auto')}>
          <option value="">All languages</option>
          {PASTE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_LABEL[l]}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonVariants({ variant: 'primary' })}>
          <Search aria-hidden className="size-4" />
          Search
        </button>
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={filtered ? 'No pastes match' : 'No public pastes yet'}
          description={filtered ? 'Try a different search or language.' : 'Public pastes appear here once someone publishes one.'}
          actions={
            filtered ? (
              <Link href="/p" className={buttonVariants({ variant: 'secondary' })}>
                Clear search
              </Link>
            ) : null
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface" aria-label="Public pastes">
          {items.map((p) => (
            <li key={p.slug}>
              <Link href={`/p/${p.slug}`} className="flex flex-col gap-1 px-4 py-2 transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                <span className="flex flex-wrap items-baseline gap-x-2 text-small">
                  <span className="font-medium text-text">{pasteTitle(p.title)}</span>
                  <span className="text-muted">{LANGUAGE_LABEL[p.language]}</span>
                  <span className="text-muted">{pasteDate(p.created_at)}</span>
                </span>
                {p.preview ? <span className="truncate font-mono text-small text-muted">{p.preview}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {query.page > 1 || hasNext ? (
        <nav aria-label="Pagination" className="flex items-center justify-between text-small">
          {query.page > 1 ? (
            <Link href={href(query, query.page - 1)} className={buttonVariants({ variant: 'secondary' })}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">Page {query.page}</span>
          {hasNext ? (
            <Link href={href(query, query.page + 1)} className={buttonVariants({ variant: 'secondary' })}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
