'use client';

import { ShieldCheck } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import type { HighImpactCategory } from '@/lib/types';
import { HIGH_IMPACT_CATEGORIES, HIGH_IMPACT_LABEL } from '@/lib/highImpact';
import type { ReviewFlag } from './review';

type Props = {
  flags: ReviewFlag[];
  /** Ids of the flags the user has ticked. */
  acknowledged: readonly string[];
  onToggle: (flagId: string, checked: boolean) => void;
  /** Reveal a line of the proposed (right-hand) script. */
  onJump: (line: number) => void;
  /** Decided proposals and completed sessions: the list is shown, nothing can be ticked. */
  readOnly?: boolean;
};

const originLabel = (f: ReviewFlag) => (f.origin === 'edit' ? 'Found in your edits' : f.source === 'claude' ? 'Flagged by Claude' : 'Found by the scanner');

/**
 * The high-impact checklist of a proposal (spec §5.4): one group per category, one checkbox per
 * flagged line. Accept stays disabled until every box is ticked. "Go to line" reveals the line in
 * the proposed script.
 */
export function FlagChecklist({ flags, acknowledged, onToggle, onJump, readOnly = false }: Props) {
  if (flags.length === 0) {
    return (
      <div className="flex items-start gap-2">
        <ShieldCheck aria-hidden className="mt-1 size-4 shrink-0 text-accent" />
        <div className="flex flex-col gap-1">
          <p className="text-text">No high-impact changes found</p>
          <p>Neither the scanner nor Claude flagged a line that changes accounts, services, the firewall or remote access. Review the diff anyway.</p>
        </div>
      </div>
    );
  }
  const ack = new Set(acknowledged);
  const groups = HIGH_IMPACT_CATEGORIES.map((c) => [c, flags.filter((f) => f.category === c)] as const).filter(([, list]) => list.length > 0);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([category, list]) => (
        <Group key={category} category={category} flags={list} ack={ack} onToggle={onToggle} onJump={onJump} readOnly={readOnly} />
      ))}
    </div>
  );
}

function Group({
  category,
  flags,
  ack,
  onToggle,
  onJump,
  readOnly,
}: {
  category: HighImpactCategory;
  flags: ReviewFlag[];
  ack: Set<string>;
  onToggle: Props['onToggle'];
  onJump: Props['onJump'];
  readOnly: boolean;
}) {
  const done = flags.filter((f) => ack.has(f.id)).length;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-small font-semibold text-text">
        {HIGH_IMPACT_LABEL[category]}{' '}
        <span className="font-normal text-muted">
          · {done} of {flags.length}
        </span>
      </legend>
      <ul className="flex flex-col gap-2">
        {flags.map((f) => (
          <li key={f.id} className="flex items-start gap-2">
            <Checkbox
              className="mt-1"
              checked={ack.has(f.id)}
              disabled={readOnly}
              aria-label={`Acknowledge ${HIGH_IMPACT_LABEL[f.category]} change on line ${f.line}`}
              onCheckedChange={(v) => onToggle(f.id, v === true)}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onJump(f.line)}
                  aria-label={`Go to line ${f.line}`}
                  className="rounded-sm font-mono text-small text-accent underline-offset-2 transition-colors duration-150 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Line {f.line}
                </button>
                <span className={f.origin === 'edit' ? 'text-warning' : 'text-muted'}>{originLabel(f)}</span>
              </div>
              <code className="break-all font-mono text-small text-text">{f.match}</code>
              {f.reason ? <p>{f.reason}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
