# Deploy notes

## Private file bucket
Apply `supabase/storage/private-files.sql` to the hosted Supabase project (SQL editor or
`supabase db execute`). It creates the private `private-files` bucket with a 25 MB cap and a mime
allowlist. It is deliberately outside `supabase/migrations` because the local test Postgres has no
`storage` schema. Scripts/text (2 MB) are further limited by the server: callers must run
`verifyStoredUpload(storagePath, kind)` before recording any storage path from a direct upload.
