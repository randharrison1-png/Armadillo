'use client';

import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/shell/states/LoadingState';
import type { ResourceRef } from '@/lib/types';
import { useContextSelection } from './contextSelection';
import { REF_TYPE_LABEL, refKey, type ContextOption, type ContextOptions } from './types';

const GROUPS: { key: keyof ContextOptions; title: string; empty: string }[] = [
  { key: 'readmes', title: 'READMEs', empty: 'No README yet' },
  { key: 'scriptVersions', title: 'Scripts', empty: 'No session scripts yet' },
  { key: 'leadsReports', title: 'LEADS reports', empty: 'No reports yet' },
  { key: 'evidence', title: 'Evidence', empty: 'No evidence yet' },
];

function Option({ option, checked, disabled, onChange }: { option: ContextOption; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <li className="flex items-start gap-2 rounded-sm px-1 py-1 hover:bg-surface-raised">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} className="mt-1" />
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col text-small">
        <span className="truncate text-text">{option.label}</span>
        {option.detail ? <span className="truncate text-muted">{option.detail}</span> : null}
      </label>
    </li>
  );
}

/**
 * Chooses what Claude may see with the next message: the session's READMEs, script versions,
 * LEADS reports and evidence, as checkboxes bound to the session's context selection. Nothing is
 * selected unless the user selects it; the selection is sent with each message.
 */
export function ContextPicker({
  sessionId,
  options,
  state,
  disabled,
  onOpen,
}: {
  sessionId: string;
  options: ContextOptions | null;
  state: 'idle' | 'loading' | 'error' | 'ready';
  disabled?: boolean;
  /** Called when the picker opens (and on Retry), so the list is fresh. */
  onOpen: () => void;
}) {
  const { refs, add, remove, clear } = useContextSelection(sessionId);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const listed = new Set(options ? GROUPS.flatMap((g) => options[g.key].map((o) => refKey(o.ref))) : []);
  // Selected items the list does not show (deleted, or not loaded yet): still visible and removable.
  const unlisted = options ? refs.filter((r) => !listed.has(refKey(r))) : [];
  const isOn = (r: ResourceRef) => refs.some((s) => s.type === r.type && s.id === r.id);
  const toggle = (r: ResourceRef, on: boolean) => (on ? add(r) : remove(r));

  return (
    <section aria-label="Context for Claude" className="border-t border-border bg-surface">
      <div className="flex items-center gap-2 px-4 py-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            if (!open) onOpen();
            setOpen(!open);
          }}
          className="flex h-control items-center gap-2 rounded-sm px-1 text-small text-text transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
          Context
          <span className="text-muted">· {refs.length === 0 ? 'nothing selected' : `${refs.length} selected`}</span>
        </button>
        {refs.length > 0 && !disabled ? (
          <Button variant="ghost" className="ml-auto h-control-sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>
      {open ? (
        <div id={panelId} className="max-h-72 overflow-y-auto px-4 pb-2">
          <p className="mb-2 text-small text-muted">Claude only sees the items you select. Uploaded content is treated as data, not instructions.</p>
          {state === 'loading' && !options ? <LoadingState label="Loading session items" /> : null}
          {state === 'error' ? (
            <p role="alert" className="flex items-center gap-2 text-small text-danger">
              Could not load the session’s items.
              <Button variant="secondary" className="h-control-sm" onClick={onOpen}>
                Retry
              </Button>
            </p>
          ) : null}
          {options ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {GROUPS.map((g) => (
                <fieldset key={g.key} className="min-w-0">
                  <legend className="mb-1 text-small font-semibold text-text">{g.title}</legend>
                  {options[g.key].length === 0 ? (
                    <p className="text-small text-muted">{g.empty}</p>
                  ) : (
                    <ul className="flex flex-col">
                      {options[g.key].map((o) => (
                        <Option key={refKey(o.ref)} option={o} checked={isOn(o.ref)} disabled={disabled} onChange={(on) => toggle(o.ref, on)} />
                      ))}
                    </ul>
                  )}
                </fieldset>
              ))}
              {unlisted.length > 0 ? (
                <fieldset className="min-w-0">
                  <legend className="mb-1 text-small font-semibold text-text">Other selected items</legend>
                  <ul className="flex flex-col">
                    {unlisted.map((r) => (
                      <Option
                        key={refKey(r)}
                        option={{ ref: r, label: REF_TYPE_LABEL[r.type], detail: 'No longer listed in this session' }}
                        checked
                        disabled={disabled}
                        onChange={(on) => toggle(r, on)}
                      />
                    ))}
                  </ul>
                </fieldset>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
