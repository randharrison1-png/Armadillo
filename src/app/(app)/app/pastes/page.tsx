import type { Metadata } from 'next';
import { MyPastes } from '@/features/pastebin/MyPastes';
import { listMyPastes } from '@/features/pastebin/service';
import { requireUser } from '@/server/auth';

export const metadata: Metadata = { title: 'My pastes · Armadillo' };

export default async function Page({ searchParams }: { searchParams: Promise<{ edit?: string; delete?: string }> }) {
  const user = await requireUser();
  const [pastes, sp] = await Promise.all([listMyPastes(user.id), searchParams]);
  return (
    <MyPastes
      pastes={pastes.map((p) => ({
        slug: p.slug,
        title: p.title,
        language: p.language,
        visibility: p.visibility,
        expiresAt: p.expires_at?.toISOString() ?? null,
        deletedAt: p.deleted_at?.toISOString() ?? null,
        createdAt: p.created_at.toISOString(),
      }))}
      initialEdit={typeof sp.edit === 'string' ? sp.edit : undefined}
      initialDelete={typeof sp.delete === 'string' ? sp.delete : undefined}
    />
  );
}
