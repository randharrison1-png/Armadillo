'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CATEGORIES, CATEGORY_LABEL, FUNCTION_LABEL, FUNCTIONS, SCOPE_LABEL, SCOPES } from './filters';

const ALL = 'all-values';
const SEARCH_DEBOUNCE_MS = 300;

/** Search box + category / function / scope selects. State lives in the URL (?q=&category=&fn=&scope=). */
export function LibraryFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const urlText = params.get('q') ?? '';
  const [text, setText] = useState(urlText);
  const lastPushed = useRef(urlText);

  const push = (next: URLSearchParams) => {
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  };
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    push(next);
  };

  // A change that did not come from typing here (sidebar category link, back button) replaces the text.
  useEffect(() => {
    if (urlText !== lastPushed.current) {
      lastPushed.current = urlText;
      setText(urlText);
    }
  }, [urlText]);

  // Debounced search-as-you-type.
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === lastPushed.current) return;
    const id = setTimeout(() => {
      lastPushed.current = trimmed;
      const next = new URLSearchParams(params.toString());
      if (trimmed) next.set('q', trimmed);
      else next.delete('q');
      push(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push/params are re-read on fire; only typing should reschedule
  }, [text]);

  const category = params.get('category') ?? ALL;
  const fn = params.get('fn') ?? ALL;
  const scope = params.get('scope') ?? 'universal';

  return (
    <form
      role="search"
      aria-label="Filter scripts"
      aria-busy={pending || undefined}
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        lastPushed.current = text.trim();
        const next = new URLSearchParams(params.toString());
        if (text.trim()) next.set('q', text.trim());
        else next.delete('q');
        push(next);
      }}
    >
      <div className="relative min-w-60 flex-1">
        <Search aria-hidden className="pointer-events-none absolute top-2 left-2 size-4 text-muted" />
        <Input
          type="search"
          aria-label="Search scripts"
          placeholder="Search name, filename, description or code"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="pr-6 pl-6"
          autoComplete="off"
        />
        {pending ? <Loader2 aria-label="Searching" role="status" className="absolute top-2 right-2 size-4 animate-spin text-muted" /> : null}
      </div>
      <div className="w-44">
        <Select value={category} onValueChange={(v) => setParam('category', v === ALL ? null : v)}>
          <SelectTrigger aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-44">
        <Select value={fn} onValueChange={(v) => setParam('fn', v === ALL ? null : v)}>
          <SelectTrigger aria-label="Function">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All functions</SelectItem>
            {FUNCTIONS.map((f) => (
              <SelectItem key={f} value={f}>
                {FUNCTION_LABEL[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-44">
        <Select value={scope} onValueChange={(v) => setParam('scope', v === 'universal' ? null : v)}>
          <SelectTrigger aria-label="Scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPE_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {params.toString() ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            lastPushed.current = '';
            setText('');
            push(new URLSearchParams());
          }}
        >
          <X aria-hidden className="size-4" />
          Clear filters
        </Button>
      ) : null}
    </form>
  );
}
