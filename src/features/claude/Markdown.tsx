'use client';

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '@/lib/utils';

/*
 * Renders Claude's replies. Claude may echo untrusted README/report text, so:
 * - no raw HTML: react-markdown without rehype-raw shows any HTML as plain text;
 * - unsafe URLs (javascript:, data:, …) are removed by react-markdown's default urlTransform;
 * - links open in a new tab with rel="noopener noreferrer";
 * - images are not rendered (a remote image URL would load automatically and could leak data).
 */

/** react-markdown passes its AST `node` to custom components; it must not reach the DOM. */
function dom<P extends object>(props: P): Omit<P, 'node'> {
  const rest = { ...props } as P & { node?: unknown };
  delete rest.node;
  return rest;
}

const components: Components = {
  a: ({ className, children, ...props }) => (
    <a
      {...dom(props)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('text-accent underline underline-offset-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}
    >
      {children}
    </a>
  ),
  pre: ({ className, ...props }) => (
    <pre {...dom(props)} className={cn('my-2 overflow-x-auto rounded-sm border border-border bg-surface p-2 font-mono text-small', className)} />
  ),
  code: ({ className, ...props }) => <code {...dom(props)} className={cn('font-mono text-small', className)} />,
  p: (props) => <p {...dom(props)} className="my-2 first:mt-0 last:mb-0" />,
  ul: (props) => <ul {...dom(props)} className="my-2 list-disc pl-6" />,
  ol: (props) => <ol {...dom(props)} className="my-2 list-decimal pl-6" />,
  h1: (props) => <h3 {...dom(props)} className="my-2 text-body font-semibold" />,
  h2: (props) => <h3 {...dom(props)} className="my-2 text-body font-semibold" />,
  h3: (props) => <h4 {...dom(props)} className="my-2 text-body font-semibold" />,
  blockquote: (props) => <blockquote {...dom(props)} className="my-2 border-l-2 border-border pl-4 text-muted" />,
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 break-words text-body text-text">
      <ReactMarkdown components={components} disallowedElements={['img']}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
