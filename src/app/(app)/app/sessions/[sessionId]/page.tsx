import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SetInspector } from '@/components/shell/inspectorStore';
import { WorkspaceTabs } from '@/components/shell/WorkspaceTabs';
import { ReadmeIntakeHost } from '@/features/readme/ReadmeIntake';
import { ReadmeInspectorSection } from '@/features/readme/ReadmeInspectorSection';
import { RequirementsInspectorSection } from '@/features/requirements/RequirementsInspectorSection';
import { getReadmeOverview } from '@/features/readme/queries';
import { stageLabel } from '@/features/flowchart/stepMeta';
import { STEP_STATUS_LABEL } from '@/lib/types';
import { OS_LABEL } from '@/features/sessions/schema';
import { getSession } from '@/features/sessions/queries';

export const metadata: Metadata = { title: 'Session · Armadillo' };
// Server actions on this page include structured Claude calls (requirements extraction and
// assessment), which can take minutes; the Anthropic client times out at 270 s.
export const maxDuration = 300;

type Props = { params: Promise<{ sessionId: string }> };

export default async function SessionPage({ params }: Props) {
  const { sessionId } = await params;
  const session = await getSession(sessionId);
  if (!session) notFound();

  const readmes = (await getReadmeOverview(sessionId)) ?? { readmes: [], openReadmeStatus: 'not_started' as const };
  const completed = session.status === 'completed';
  const readmeItems = readmes.readmes.map((r) => ({
    id: r.id,
    label: `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(r.created_at)} UTC · ${r.source === 'upload' ? (r.filename ?? 'file') : 'pasted'}`,
    hasText: r.has_text_layer,
  }));

  const stage = stageLabel(session.status, session.currentStep);
  const created = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(session.created_at);
  const rows: [string, string][] = [
    ['Title', session.title],
    ['System', OS_LABEL[session.os]],
    ['Created', `${created} UTC`],
    ['Current stage', stage],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-border px-4 py-2">
        <h1 className="truncate text-body font-semibold text-text">{session.title}</h1>
        <span className="shrink-0 text-small text-muted">{OS_LABEL[session.os]}</span>
      </header>
      <div className="min-h-0 flex-1">
        <WorkspaceTabs sessionId={session.id} />
      </div>
      <SetInspector
        version={`${session.updated_at.toISOString()}|${stage}|${readmeItems.map((r) => r.id).join(',')}|${readmes.openReadmeStatus}`}
        sections={[
          {
            id: 'session',
            title: 'Session',
            content: (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                {rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>{k}</dt>
                    <dd className="min-w-0 break-words text-text">{v}</dd>
                  </div>
                ))}
              </dl>
            ),
          },
          {
            id: 'readme',
            title: 'README',
            content: (
              <ReadmeInspectorSection
                sessionId={session.id}
                completed={completed}
                stepLabel={STEP_STATUS_LABEL[readmes.openReadmeStatus]}
                items={readmeItems}
              />
            ),
          },
          {
            id: 'requirements',
            title: 'Requirements',
            content: <RequirementsInspectorSection sessionId={session.id} />,
          },
        ]}
      />
      <ReadmeIntakeHost sessionId={session.id} />
    </div>
  );
}
