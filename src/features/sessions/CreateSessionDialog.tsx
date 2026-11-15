'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { OsType } from '@/lib/types';
import { createSessionAction } from './actions';
import { OS_LABEL, OS_VALUES, TITLE_MAX } from './schema';

type Errors = { title?: string; os?: string; form?: string };

export function CreateSessionDialog({ variant = 'primary', defaultOs }: { variant?: 'primary' | 'secondary'; defaultOs?: OsType | null }) {
  const initialOs: OsType = defaultOs ?? 'windows';
  const router = useRouter();
  const ids = { title: useId(), titleError: useId(), os: useId() };
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [os, setOs] = useState<OsType>(initialOs);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setTitle('');
      setOs(initialOs);
      setErrors({});
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    startTransition(async () => {
      const result = await createSessionAction({ title, os });
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setOpen(false);
      router.push(`/app/sessions/${result.sessionId}`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <Plus aria-hidden className="size-4" />
          New session
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>Name the hardening round and choose the image&apos;s operating system.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.title} className="text-small font-medium text-text">
              Title
            </label>
            <Input
              id={ids.title}
              value={title}
              maxLength={TITLE_MAX + 40}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={errors.title ? ids.titleError : undefined}
              autoComplete="off"
              disabled={pending}
            />
            {errors.title ? (
              <p id={ids.titleError} role="alert" className="flex items-center gap-2 text-small text-danger">
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
                {errors.title}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.os} className="text-small font-medium text-text">
              Operating system
            </label>
            <Select value={os} onValueChange={(v) => setOs(v as OsType)} disabled={pending}>
              <SelectTrigger id={ids.os} aria-label="Operating system" aria-invalid={errors.os ? true : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OS_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {OS_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.os ? (
              <p role="alert" className="flex items-center gap-2 text-small text-danger">
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
                {errors.os}
              </p>
            ) : null}
          </div>
          {errors.form ? (
            <p role="alert" className="flex items-center gap-2 text-small text-danger">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              {errors.form}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
