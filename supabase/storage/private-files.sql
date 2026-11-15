-- Private upload bucket. Applied at deploy time against a hosted Supabase project (NOT part of
-- `pnpm db:reset`: the local test Postgres has no storage schema). Idempotent.
-- Access is server-only (service-role key); no storage.objects policies are created for clients.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'private-files', 'private-files', false, 52428800, -- 50 MB: account exports (application/zip) are up to 50 MB; user uploads stay capped at 2/25 MB by src/server/files/limits.ts
  array[
    'text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json',
    'application/pdf', 'image/png', 'image/jpeg',
    'application/x-sh', 'text/x-shellscript', 'application/x-powershell', 'text/x-powershell',
    'application/x-bat', 'application/x-msdos-program', 'application/octet-stream',
    'application/zip'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
