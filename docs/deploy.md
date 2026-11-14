# Deploy notes

## Private file bucket
Apply `supabase/storage/private-files.sql` to the hosted Supabase project (SQL editor or
`supabase db execute`). It creates the private `private-files` bucket with a 25 MB cap and a mime
allowlist. It is deliberately outside `supabase/migrations` because the local test Postgres has no
`storage` schema. Scripts/text (2 MB) are further limited by the server: callers must run
`verifyStoredUpload(storagePath, kind)` before recording any storage path from a direct upload.

## Public pastebin: abuse reports, rate limits, and the proxy-header trust assumption
Apply `supabase/migrations/0006_rate_limit.sql` with the other migrations. It creates the private
`rate_limit_hits` table (no grants for any API role) and `check_rate_limit()` (SECURITY DEFINER,
empty `search_path`, executable by `anon` and `authenticated`). Limits: 10 publishes/hour/user,
60 other paste edits/hour/user, 5 abuse reports/hour per reporter.

Abuse reports work signed out, so the reporter is identified only by a hash of the client address:
`HMAC-SHA256(ip, key)` with a key derived (HKDF, label `abuse-report`) from `KEY_ENCRYPTION_SECRET`.
The address itself is never stored. Reporting is unavailable (and says so) when
`KEY_ENCRYPTION_SECRET` is not set.

**Trust assumption.** The address is read from the request headers: the FIRST entry of
`X-Forwarded-For`, else `X-Real-IP`, else a single shared "unknown" bucket (stricter, never looser).
Next.js route code has no access to the TCP peer address, so the deployment MUST put a proxy in front
that overwrites these headers with the real client address and drops any client-supplied
`X-Forwarded-For`. Vercel does this. If the app is reachable directly, or behind a proxy that
appends to a client-supplied `X-Forwarded-For`, a reporter can pick any value for the first entry and
evade the 5/hour limit (the per-user publish and edit limits are unaffected: they are keyed by
account, not address).
