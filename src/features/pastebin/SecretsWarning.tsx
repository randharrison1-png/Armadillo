'use client';

import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { SECRET_KIND_LABEL, type SecretFinding } from '@/lib/secrets';

/**
 * "This looks like it contains secrets" panel: what was found (kind + line only, never the text)
 * and the "Publish anyway" checkbox the user must tick to proceed.
 */
export function SecretsWarning({
  findings,
  acknowledged,
  onAcknowledgedChange,
  disabled,
}: {
  findings: SecretFinding[];
  acknowledged: boolean;
  onAcknowledgedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-2 rounded-sm border border-warning p-4">
      <h3 id={`${id}-h`} className="flex items-center gap-2 text-body font-semibold text-text">
        <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
        This may contain secrets
      </h3>
      <p className="text-small text-muted">Anyone who can open the paste can read them. Remove them, or publish anyway if they are safe to share.</p>
      <ul className="flex max-h-40 flex-col gap-1 overflow-auto text-small text-text">
        {findings.map((f) => (
          <li key={`${f.kind}:${f.line}`}>
            <span className="font-mono">Line {f.line}</span>: {SECRET_KIND_LABEL[f.kind]}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Checkbox id={`${id}-ack`} checked={acknowledged} disabled={disabled} onCheckedChange={(v) => onAcknowledgedChange(v === true)} />
        <label htmlFor={`${id}-ack`} className="text-small font-medium text-text">
          Publish anyway
        </label>
      </div>
    </section>
  );
}
