'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { addForensicQuestionAction, answerForensicQuestionAction, loadForensic, reopenForensicQuestionAction } from './completeActions';
import { ANSWER_MAX, forensicCountLabel, PROMPT_MAX, type ForensicItem } from './completeRules';
import { useForensicSync } from './forensicSync';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; completed: boolean; questions: ForensicItem[] };

/**
 * Forensic questions of a session (spec 8.1 step 2): add a question, answer it, edit the answer,
 * reopen it. "2 of 5 answered" counts the answered ones. Nothing here changes the Forensic questions
 * step's status: the user sets that. A completed session shows the questions read-only.
 */
export function ForensicPanel({ sessionId }: { sessionId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const version = useForensicSync((s) => s.version[sessionId] ?? 0);
  const bump = useForensicSync((s) => s.bump);

  const reload = useCallback(() => {
    loadForensic(sessionId).then(
      (r) => setLoad(r ? { state: 'ready', completed: r.completed, questions: r.questions } : { state: 'error' }),
      () => setLoad((l) => (l.state === 'ready' ? l : { state: 'error' })),
    );
  }, [sessionId]);
  useEffect(() => reload(), [reload, version]);

  if (load.state === 'loading') return <LoadingState label="Loading forensic questions" />;
  if (load.state === 'error') return <ErrorState title="Could not load the forensic questions" onRetry={() => (setLoad({ state: 'loading' }), reload())} />;

  const { completed, questions } = load;
  const answered = questions.filter((q) => q.status === 'answered').length;

  return (
    <section aria-label="Forensic questions" className="flex flex-col gap-4">
      <p data-testid="forensic-count" className="text-text">
        {forensicCountLabel(questions.length, answered)}
      </p>
      {questions.length === 0 ? (
        <p>{completed ? 'This session had no forensic questions.' : 'No forensic questions yet. Add each question from the README here, then answer it.'}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {questions.map((q, i) => (
            <Question key={q.id} number={i + 1} q={q} readOnly={completed} onChanged={() => bump(sessionId)} />
          ))}
        </ol>
      )}
      {completed ? <p>This session is completed and read-only.</p> : <AddQuestion sessionId={sessionId} onAdded={() => bump(sessionId)} />}
    </section>
  );
}

function AddQuestion({ sessionId, onAdded }: { sessionId: string; onAdded: () => void }) {
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    // The box stays editable while the add is in flight: clear it only if the user has not
    // started typing the next question meanwhile.
    const sent = prompt;
    setPending(true);
    setError(null);
    try {
      const r = await addForensicQuestionAction({ sessionId, prompt: sent });
      if (!r.ok) return setError(r.error);
      setPrompt((p) => (p === sent ? '' : p));
      onAdded();
    } catch {
      setError('Could not add the question. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-medium text-text">
        New question
      </label>
      <Textarea id={id} rows={3} maxLength={PROMPT_MAX} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-invalid={error ? true : undefined} />
      <div>
        <Button variant="secondary" onClick={() => void add()} loading={pending} disabled={prompt.trim() === ''}>
          Add question
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Question({ number, q, readOnly, onChanged }: { number: number; q: ForensicItem; readOnly: boolean; onChanged: () => void }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(q.answer ?? '');
  const [pending, setPending] = useState<'save' | 'reopen' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answered = q.status === 'answered';
  const Icon = answered ? CheckCircle2 : Circle;

  const run = async (kind: 'save' | 'reopen') => {
    setPending(kind);
    setError(null);
    try {
      const r = kind === 'save' ? await answerForensicQuestionAction({ id: q.id, answer: draft }) : await reopenForensicQuestionAction({ id: q.id });
      if (!r.ok) return setError(r.error);
      setEditing(false);
      onChanged();
    } catch {
      setError('Could not save. Try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <li className="flex flex-col gap-2 border-b border-border pb-4">
      <p className="break-words text-text">
        {number}. {q.prompt}
      </p>
      <p className={`flex items-center gap-2 ${answered ? 'text-accent' : ''}`}>
        <Icon aria-hidden className="size-4 shrink-0" />
        {answered ? 'Answered' : 'Open'}
      </p>
      {editing ? (
        <>
          <label htmlFor={id} className="sr-only">
            Answer to question {number}
          </label>
          <Textarea id={id} rows={4} maxLength={ANSWER_MAX} value={draft} onChange={(e) => setDraft(e.target.value)} aria-invalid={error ? true : undefined} />
          <div className="flex gap-2">
            <Button onClick={() => void run('save')} loading={pending === 'save'} disabled={draft.trim() === ''}>
              Save answer
            </Button>
            <Button variant="secondary" onClick={() => (setEditing(false), setDraft(q.answer ?? ''), setError(null))} disabled={pending !== null}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          {q.answer ? <p className="whitespace-pre-wrap break-words">{q.answer}</p> : null}
          {readOnly ? null : (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => (setDraft(q.answer ?? ''), setEditing(true))} aria-label={`${answered ? 'Edit answer to' : 'Answer'} question ${number}`}>
                {answered ? 'Edit answer' : 'Answer'}
              </Button>
              {answered ? (
                <Button variant="ghost" onClick={() => void run('reopen')} loading={pending === 'reopen'} aria-label={`Reopen question ${number}`}>
                  Reopen
                </Button>
              ) : null}
            </div>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
