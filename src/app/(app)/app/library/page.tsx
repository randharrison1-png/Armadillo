import type { Metadata } from 'next';
import { parseLibraryQuery } from '@/features/library/filters';
import { LibraryPage } from '@/features/library/LibraryPage';

export const metadata: Metadata = { title: 'Script Library · Armadillo' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <LibraryPage query={parseLibraryQuery(await searchParams)} />;
}
