import type { Metadata } from 'next';
import { PasteSearch, parsePasteQuery } from '@/features/pastebin/PasteSearch';
import { searchPublicPastes } from '@/features/pastebin/service';

export const metadata: Metadata = { title: 'Pastebin · Armadillo' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parsePasteQuery(await searchParams);
  const { items, hasNext } = await searchPublicPastes({ text: query.text, language: query.language, page: query.page });
  return (
    <>
      <h1 className="text-h1 font-semibold text-text">Pastebin</h1>
      <PasteSearch query={query} items={items} hasNext={hasNext} />
    </>
  );
}
