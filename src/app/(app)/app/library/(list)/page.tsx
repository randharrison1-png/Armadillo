import type { Metadata } from 'next';
import { parseLibraryQuery } from '@/features/library/filters';
import { LibraryPage } from '@/features/library/LibraryPage';
import { applyFaults } from '@/server/testing/faults';

export const metadata: Metadata = { title: 'Script Library · Armadillo' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await applyFaults('library');
  return <LibraryPage query={parseLibraryQuery(await searchParams)} />;
}
