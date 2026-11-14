import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClaudeKeyForm } from '@/features/settings/ClaudeKeyForm';
import { ClaudeModelForm, DefaultOsForm, DisplayNameForm } from '@/features/settings/PreferencesForm';
import { PasswordForm } from '@/features/settings/PasswordForm';
import { PrivacyPanel } from '@/features/settings/PrivacyPanel';
import { getSettingsFor } from '@/features/settings/service';
import { authMode, requireUser } from '@/server/auth';

export const metadata: Metadata = { title: 'Settings · Armadillo' };

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
      <h2 id={id} className="text-body font-semibold text-text">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await getSettingsFor(user.id);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        <h1>Settings</h1>
        <Section id="settings-account" title="Account">
          <p className="text-small text-muted">
            Signed in as <span className="text-text">{user.email}</span>
          </p>
          <DisplayNameForm initial={settings.displayName} />
          <PasswordForm managedByTestProvider={authMode() === 'test'} />
        </Section>
        <Section id="settings-claude" title="Claude">
          <ClaudeKeyForm initial={settings.key} />
          <ClaudeModelForm initial={settings.model} />
        </Section>
        <Section id="settings-defaults" title="Defaults">
          <DefaultOsForm initial={settings.defaultOs} />
        </Section>
        <Section id="settings-privacy" title="Privacy">
          <PrivacyPanel />
        </Section>
      </div>
    </div>
  );
}
