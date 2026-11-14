import type { Metadata } from 'next';
import { ClaudeKeyForm } from '@/features/settings/ClaudeKeyForm';
import { getClaudeKeyStatus } from '@/features/settings/actions';

export const metadata: Metadata = { title: 'Settings · Armadillo' };

// Minimal settings page (Task 11): the Claude key. Task 21 adds account, defaults and privacy.
export default async function SettingsPage() {
  const status = await getClaudeKeyStatus();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        <h1>Settings</h1>
        <section aria-labelledby="settings-claude" className="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
          <h2 id="settings-claude" className="text-body font-semibold text-text">
            Claude
          </h2>
          <ClaudeKeyForm initial={status} />
        </section>
      </div>
    </div>
  );
}
