import { redirect } from 'next/navigation';

/** `/` is the sign-in page; a one-time notice (e.g. after account deletion) is passed along. */
export default async function Home({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  redirect(notice === 'account-deleted' ? '/login?notice=account-deleted' : '/login');
}
