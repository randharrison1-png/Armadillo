import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pasteTitle } from '@/features/pastebin/format';
import { PasteView } from '@/features/pastebin/PasteView';
import { loadPaste } from '@/features/pastebin/load';
import { ownsPaste } from '@/features/pastebin/service';
import { getCurrentUser } from '@/server/auth';
import { applyFaults } from '@/server/testing/faults';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const paste = await loadPaste((await params).slug);
  if (!paste) return { title: 'Paste not found · Armadillo', robots: { index: false } };
  return {
    title: `${pasteTitle(paste.title)} · Armadillo Pastebin`,
    // Unlisted: reachable by URL only. (`other` keeps the exact `noindex,nofollow` value.)
    ...(paste.visibility === 'unlisted' ? { other: { robots: 'noindex,nofollow' } } : {}),
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  await applyFaults('paste');
  const paste = await loadPaste((await params).slug);
  if (!paste) notFound();
  // Reads are anonymous even when signed in; the session only decides whether to show Edit/Delete.
  const user = await getCurrentUser();
  const isOwner = user ? await ownsPaste(user.id, paste.slug) : false;
  return <PasteView paste={paste} isOwner={isOwner} />;
}
