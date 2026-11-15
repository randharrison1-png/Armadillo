import { getDefaultOsFor } from '@/features/settings/service';
import { requireUser } from '@/server/auth';
import { CreateSessionDialog } from './CreateSessionDialog';

/** The New session dialog, starting on the operating system saved in Settings → Defaults. */
export async function NewSessionButton({ variant }: { variant?: 'primary' | 'secondary' }) {
  const user = await requireUser();
  return <CreateSessionDialog variant={variant} defaultOs={await getDefaultOsFor(user.id)} />;
}
