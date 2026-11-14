'use client';

import { useId, useState, useTransition } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { OsType, Script, ScriptCategory } from '@/lib/types';
import { OS_LABEL, OS_VALUES } from '@/features/sessions/schema';
import { CATEGORIES, CATEGORY_LABEL } from './filters';
import { updateScriptMetadataAction, type MetaErrors } from './versionActions';

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-2 text-small text-danger">
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      {message}
    </p>
  );
}

type Form = { name: string; category: ScriptCategory; osCompat: OsType[]; description: string };
const fromScript = (s: Script): Form => ({ name: s.name, category: s.category, osCompat: [...s.os_compat], description: s.description ?? '' });

/** "Edit details": name, category, systems, description. Filename and function cannot change. */
export function ScriptDetailsDialog({ script, onSaved, disabled }: { script: Script; onSaved: (s: Script) => void; disabled?: boolean }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(() => fromScript(script));
  const [errors, setErrors] = useState<MetaErrors>({});
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) {
      setForm(fromScript(script));
      setErrors({});
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    startTransition(async () => {
      try {
        const r = await updateScriptMetadataAction(script.id, form);
        if (!r.ok) return setErrors(r.errors);
        onSaved(r.script);
        toast.success('Details saved');
        setOpen(false);
      } catch {
        setErrors({ form: 'Could not save the details. Try again.' });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={disabled}>
          <Pencil aria-hidden className="size-4" />
          Edit details
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid max-h-[80vh] gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{script.filename}</span> keeps its filename and versions; only these details change.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${base}-name`} className="text-small font-medium text-text">
              Name
            </label>
            <Input
              id={`${base}-name`}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? `${base}-name-error` : undefined}
              autoComplete="off"
              disabled={pending}
            />
            <FieldError id={`${base}-name-error`} message={errors.name} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${base}-category`} className="text-small font-medium text-text">
              Category
            </label>
            <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as ScriptCategory }))} disabled={pending}>
              <SelectTrigger id={`${base}-category`} aria-label="Category" aria-invalid={errors.category ? true : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.category} />
          </div>
          <fieldset className="flex flex-col gap-1" aria-describedby={errors.osCompat ? `${base}-os-error` : undefined}>
            <legend className="text-small font-medium text-text">Operating systems</legend>
            <div className="flex flex-wrap gap-4">
              {OS_VALUES.map((os) => (
                <div key={os} className="flex items-center gap-2">
                  <Checkbox
                    id={`${base}-os-${os}`}
                    checked={form.osCompat.includes(os)}
                    disabled={pending}
                    onCheckedChange={(on) =>
                      setForm((f) => ({ ...f, osCompat: OS_VALUES.filter((o) => (o === os ? on === true : f.osCompat.includes(o))) }))
                    }
                  />
                  <label htmlFor={`${base}-os-${os}`} className="text-small text-text">
                    {OS_LABEL[os]}
                  </label>
                </div>
              ))}
            </div>
            <FieldError id={`${base}-os-error`} message={errors.osCompat} />
          </fieldset>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${base}-description`} className="text-small font-medium text-text">
              Description <span className="text-muted">(optional)</span>
            </label>
            <Textarea
              id={`${base}-description`}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={3}
              disabled={pending}
              aria-invalid={errors.description ? true : undefined}
            />
            <FieldError message={errors.description} />
          </div>
          <FieldError message={errors.form} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save details
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
