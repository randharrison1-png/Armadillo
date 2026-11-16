'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, FilePlus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import { uploadWithRetry } from '@/lib/files/uploadClient';
import type { OsType, ScriptCategory, ScriptFunction } from '@/lib/types';
import { ALLOWED_EXTENSIONS, extensionOf } from '@/server/files/limits';
import { OS_LABEL, OS_VALUES } from '@/features/sessions/schema';
import { createScriptAction, prepareScriptUpload, recordUploadedScript, type FieldErrors } from './actions';
import { CATEGORIES, CATEGORY_LABEL, FUNCTION_LABEL } from './filters';
import { defaultFunction, defaultOsCompat, inferCategory, nameFromFilename } from './scriptMeta';

const ACCEPT = ALLOWED_EXTENSIONS.script.join(',');
const LIBRARY_FUNCTIONS = ['universal_hardening', 'leads_audit'] as const satisfies readonly ScriptFunction[];
type LibraryFunction = (typeof LIBRARY_FUNCTIONS)[number];

type Meta = {
  name: string;
  category: ScriptCategory;
  fn: LibraryFunction;
  osCompat: OsType[];
  description: string;
};

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-2 text-small text-danger">
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      {message}
    </p>
  );
}

/**
 * Category / function / OS follow the category until the user changes them by hand; changing the
 * category afterwards does not clobber an explicit choice.
 */
function useMeta(initial: Partial<Meta> = {}) {
  const [meta, setMeta] = useState<Meta>({
    name: '',
    category: 'windows',
    fn: 'universal_hardening',
    osCompat: ['windows'],
    description: '',
    ...initial,
  });
  const [touched, setTouched] = useState({ cat: false, fn: false, os: false });
  const set = <K extends keyof Meta>(key: K, value: Meta[K]) => {
    setMeta((m) => ({ ...m, [key]: value }));
    if (key === 'fn') setTouched((t) => ({ ...t, fn: true }));
    if (key === 'osCompat') setTouched((t) => ({ ...t, os: true }));
  };
  /** `auto` = inferred from a filename: ignored once the user has picked a category by hand. */
  const setCategory = (category: ScriptCategory, auto = false) => {
    if (auto && touched.cat) return;
    if (!auto) setTouched((t) => ({ ...t, cat: true }));
    setMeta((m) => ({
      ...m,
      category,
      fn: touched.fn ? m.fn : defaultFunction(category),
      osCompat: touched.os ? m.osCompat : defaultOsCompat(category),
    }));
  };
  const reset = () => {
    setMeta({ name: '', category: 'windows', fn: 'universal_hardening', osCompat: ['windows'], description: '', ...initial });
    setTouched({ cat: false, fn: false, os: false });
  };
  return { meta, set, setCategory, reset };
}

type MetaApi = ReturnType<typeof useMeta>;

function MetaFields({ api, errors, disabled, ids }: { api: MetaApi; errors: FieldErrors; disabled: boolean; ids: Record<string, string> }) {
  const { meta, set, setCategory } = api;
  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.name} className="text-small font-medium text-text">
          Name
        </label>
        <Input
          id={ids.name}
          value={meta.name}
          onChange={(e) => set('name', e.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${ids.name}-error` : undefined}
          autoComplete="off"
          disabled={disabled}
        />
        <FieldError id={`${ids.name}-error`} message={errors.name} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.category} className="text-small font-medium text-text">
            Category
          </label>
          <Select value={meta.category} onValueChange={(v) => setCategory(v as ScriptCategory)} disabled={disabled}>
            <SelectTrigger id={ids.category} aria-label="Category" aria-invalid={errors.category ? true : undefined}>
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
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.fn} className="text-small font-medium text-text">
            Function
          </label>
          <Select value={meta.fn} onValueChange={(v) => set('fn', v as LibraryFunction)} disabled={disabled}>
            <SelectTrigger id={ids.fn} aria-label="Function" aria-invalid={errors.fn ? true : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIBRARY_FUNCTIONS.map((f) => (
                <SelectItem key={f} value={f}>
                  {FUNCTION_LABEL[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={errors.fn} />
        </div>
      </div>
      <fieldset className="flex flex-col gap-1" aria-describedby={errors.osCompat ? `${ids.os}-error` : undefined}>
        <legend className="text-small font-medium text-text">Operating systems</legend>
        <div className="flex flex-wrap gap-4">
          {OS_VALUES.map((os) => {
            const id = `${ids.os}-${os}`;
            return (
              <div key={os} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={meta.osCompat.includes(os)}
                  disabled={disabled}
                  onCheckedChange={(on) => set('osCompat', on ? [...meta.osCompat, os] : meta.osCompat.filter((o) => o !== os))}
                />
                <label htmlFor={id} className="text-small text-text">
                  {OS_LABEL[os]}
                </label>
              </div>
            );
          })}
        </div>
        <FieldError id={`${ids.os}-error`} message={errors.osCompat} />
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.description} className="text-small font-medium text-text">
          Description <span className="text-muted">(optional)</span>
        </label>
        <Textarea
          id={ids.description}
          value={meta.description}
          onChange={(e) => set('description', e.target.value)}
          rows={2}
          disabled={disabled}
          aria-invalid={errors.description ? true : undefined}
        />
        <FieldError message={errors.description} />
      </div>
    </>
  );
}

const useIds = () => {
  const base = useId();
  return {
    file: `${base}-file`,
    filename: `${base}-filename`,
    name: `${base}-name`,
    category: `${base}-category`,
    fn: `${base}-fn`,
    os: `${base}-os`,
    description: `${base}-description`,
    content: `${base}-content`,
  };
};

export function UploadScriptDialog({ variant = 'primary' }: { variant?: 'primary' | 'secondary' }) {
  const router = useRouter();
  const ids = useIds();
  const api = useMeta();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'saving'>('idle');
  const [pending, startTransition] = useTransition();
  const busy = pending || phase !== 'idle';

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setFile(null);
      setErrors({});
      api.reset();
    }
  };

  const pickFile = (f: File | null) => {
    setFile(f);
    setErrors({});
    if (!f) return;
    api.set('name', nameFromFilename(f.name));
    api.setCategory(inferCategory(f.name), true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (!file) return setErrors({ file: 'Choose a file to upload.' });
    startTransition(async () => {
      try {
        setPhase('uploading');
        const prepared = await prepareScriptUpload(file.name, file.size);
        if (!prepared.ok) return setErrors(prepared.errors);
        const { storagePath } = await uploadWithRetry(file, prepared.target, { fields: { kind: 'script' } });
        setPhase('saving');
        const result = await recordUploadedScript({
          storagePath,
          name: api.meta.name,
          filename: file.name,
          category: api.meta.category,
          fn: api.meta.fn,
          description: api.meta.description,
          osCompat: api.meta.osCompat,
        });
        if (!result.ok) return setErrors(result.errors);
        toast.success(`Uploaded ${result.name}`);
        setOpen(false);
        setFile(null);
        api.reset();
        router.refresh();
      } catch (err) {
        setErrors({ form: err instanceof Error ? err.message : 'Upload failed. Try again.' });
      } finally {
        setPhase('idle');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <Upload aria-hidden className="size-4" />
          Upload file
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid max-h-[80vh] gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload script</DialogTitle>
            <DialogDescription>
              {ALLOWED_EXTENSIONS.script.join(' ')} files up to 2 MB. The file is stored as version 1 of a new library script.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.file} className="text-small font-medium text-text">
              File
            </label>
            <Input
              id={ids.file}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && !ALLOWED_EXTENSIONS.script.includes(extensionOf(f.name))) {
                  setFile(null);
                  return setErrors({ file: `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.script.join(' ')}` });
                }
                pickFile(f);
              }}
              aria-invalid={errors.file ? true : undefined}
              aria-describedby={errors.file ? `${ids.file}-error` : undefined}
              className="h-auto py-1 file:mr-2 file:rounded-sm file:border-0 file:bg-surface-raised file:px-2 file:py-1 file:text-small file:text-text"
            />
            <FieldError id={`${ids.file}-error`} message={errors.file} />
          </div>
          <MetaFields api={api} errors={errors} disabled={busy} ids={ids} />
          <FieldError message={errors.form} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {phase === 'uploading' ? 'Uploading' : phase === 'saving' ? 'Saving' : 'Upload'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreateScriptDialog({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const router = useRouter();
  const ids = useIds();
  const api = useMeta();
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setFilename('');
      setContent('');
      setErrors({});
      api.reset();
    }
  };

  const onFilename = (value: string) => {
    setFilename(value);
    // Suggest a category from the extension until the user picks one by hand.
    api.setCategory(inferCategory(value), true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    startTransition(async () => {
      try {
        const result = await createScriptAction({
          name: api.meta.name,
          filename,
          category: api.meta.category,
          fn: api.meta.fn,
          description: api.meta.description,
          osCompat: api.meta.osCompat,
          content,
        });
        if (!result.ok) return setErrors(result.errors);
        toast.success(`Created ${result.name}`);
        setOpen(false);
        setFilename('');
        setContent('');
        api.reset();
        router.refresh();
      } catch {
        setErrors({ form: 'Could not create the script. Try again.' });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <FilePlus aria-hidden className="size-4" />
          Create script
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid max-h-[80vh] gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create script</DialogTitle>
            <DialogDescription>Write a script here. It is saved as version 1 of a new library script.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.filename} className="text-small font-medium text-text">
              Filename
            </label>
            <Input
              id={ids.filename}
              value={filename}
              onChange={(e) => onFilename(e.target.value)}
              placeholder="harden.ps1"
              className="font-mono"
              aria-invalid={errors.filename ? true : undefined}
              aria-describedby={errors.filename ? `${ids.filename}-error` : undefined}
              autoComplete="off"
              disabled={pending}
            />
            <FieldError id={`${ids.filename}-error`} message={errors.filename} />
          </div>
          <MetaFields api={api} errors={errors} disabled={pending} ids={ids} />
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.content} className="text-small font-medium text-text">
              Content <span className="text-muted">(optional)</span>
            </label>
            <Textarea
              id={ids.content}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              spellCheck={false}
              className="font-mono"
              disabled={pending}
              aria-invalid={errors.content ? true : undefined}
            />
            <FieldError message={errors.content} />
          </div>
          <FieldError message={errors.form} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create script
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
