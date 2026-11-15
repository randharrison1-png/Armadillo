-- Private upload bucket. Applied at deploy time against a hosted Supabase project (NOT part of
-- `pnpm db:reset`: the local test Postgres has no storage schema). Idempotent.
-- Access is server-only (service-role key); no storage.objects policies are created for clients.
--
-- file_size_limit 50 MB: account exports (application/zip) are up to 50 MB; user uploads stay capped
-- at 2/25 MB by src/server/files/limits.ts. The project-wide upload limit (Storage settings) must be
-- at least 50 MB too.
--
-- No MIME allowlist (allowed_mime_types null): direct uploads carry the browser-declared type, which
-- varies by OS and browser (.csv as application/vnd.ms-excel, .log as text/x-log, ...). The server
-- re-checks the extension and the stored size of every upload (verifyStoredUpload) and serves
-- downloads as application/octet-stream, so the declared type is never trusted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-files', 'private-files', false, 52428800, null)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = null;
