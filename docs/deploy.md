# First deployment checklist

Armadillo runs on Vercel (Next.js) with a hosted Supabase project (Postgres, Auth, Storage). Work
through the sections in order; every box should be ticked before the first real user signs in.
Nothing here is automated: in particular, migrations are **not** applied on merge (see section 3).

Commands below use these shell variables (fill them from Project Settings in the Supabase
dashboard; never commit them):

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
ANON_KEY=<anon / publishable key>
DIRECT_URL='postgresql://postgres:<db-password>@db.<project-ref>.supabase.co:5432/postgres'   # or the session pooler, port 5432
```

## 1. Supabase project

- [ ] Create the project (pick the region closest to the Vercel region you will use).
- [ ] Note the project URL, the anon key, the service-role key and the database password.
- [ ] Do **not** apply `supabase/shim/`: it recreates, for the local test database only, what
      Supabase already provides (roles `anon`, `authenticated`, `service_role`, schema `auth`,
      `auth.uid()`, `auth.jwt()`).

## 2. Data API (PostgREST / GraphQL): expose neither `public` nor `paste`

The app never uses the Supabase Data API: all data access goes server-side through `DATABASE_URL`
(postgres.js), with RLS enforced by `withUser`. supabase-js is used only for Auth and Storage, which
do not need it. But Supabase exposes the `public` schema through the Data API **by default**, and the
anon key is public (it ships to the browser). Left exposed:

- anyone could call `check_rate_limit('report:…', …)` directly (it is executable by `anon`) and
  insert unlimited `rate_limit_hits` rows;
- a signed-in user could read and write their own rows directly, bypassing the server's invariants
  (secret scan, rate limits, state machines, activity logging);
- if `paste` were exposed, `pastes_select_live` plus the authenticated SELECT grant would let anyone
  enumerate unlisted pastes with their `owner_id`, and insert pastes without the secret scan or the
  rate limits.

Steps:

- [ ] Dashboard → Project Settings → Data API (API settings): turn the Data API off if the option is
      offered. Otherwise remove `public` from **Exposed schemas** (and from **Extra search path**),
      never add `paste`, and remove `graphql_public` too (pg_graphql reflects the same tables and
      functions).
- [ ] Verify with the anon key. Each request must fail (an error such as `PGRST106` "schema must be
      one of the following", HTTP 406, or 404 when the Data API is off); none may return data or
      `[{"ok":true,…}]`:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/check_rate_limit" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"p_key":"report:probe","p_limit":5,"p_window_seconds":60}'
curl -s "$SUPABASE_URL/rest/v1/sessions?select=id" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
curl -s "$SUPABASE_URL/rest/v1/pastes?select=slug" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Accept-Profile: paste'
curl -s -X POST "$SUPABASE_URL/graphql/v1" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { queryType { fields { name } } } }"}'
```

  The GraphQL request must not list any Armadillo table (for example `sessionsCollection`).

## 3. Database migrations

Migrations are plain SQL in `supabase/migrations/`, applied in C-locale filename order
(`0001_profiles.sql`, `0002_core.sql`, `0003_immutability.sql`, `0003b_…`, `0003c_…`, `0004_…`, …,
`0006_rate_limit.sql`), exactly as `scripts/test-db.sh` applies them locally. Apply them **as the
`postgres` role** (the owner of `rate_limit_hits` must also own `check_rate_limit`, see section 6),
over a direct or session-pooler connection (port 5432), not the transaction pooler.

- [ ] Apply every migration once, in order, stopping at the first error:

```bash
for f in $(ls supabase/migrations/*.sql | LC_ALL=C sort); do
  echo "== $f"; psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -X -q -f "$f" || break
done
```

- [ ] Do not use `supabase db push` for this yet. The Supabase CLI only picks up files named
      `<digits>_name.sql`, so it would skip the lettered files (`0003b_create_session.sql`,
      `0003c_claude_key.sql`, `0004b…` to `0004e…`). Renumbering (and squashing) the migrations
      before the first deploy is a planned follow-up; after that, `supabase link --project-ref
      <project-ref>` then `supabase db push` applies new migrations and records them in
      `supabase_migrations.schema_migrations`.
- [ ] Later releases: apply only the new files the same way, before the Vercel deployment that
      needs them. **CI does not migrate on merge**: `.github/workflows/ci.yml` only tests against a
      throwaway Postgres. Automating it needs deploy secrets and is a follow-up.
- [ ] Check: `psql "$DIRECT_URL" -c '\dt public.*' -c '\dt paste.*'` lists the tables, and
      `select proname from pg_proc where proname = 'check_rate_limit'` returns one row.
- [ ] Load the shared starter library (migration 0007): the universal hardening and LEADS scripts in
      `supabase/seed/library/` (listed in its `manifest.json`, stored byte for byte). Every account
      gets its own copy: new accounts automatically when their profile is created, existing accounts
      when the loader runs. Running it again is safe (seeds are upserted by filename; an account that
      already has a library script with that filename is skipped).

```bash
DATABASE_URL="$DIRECT_URL" pnpm tsx scripts/load-library-seed.ts
```

## 4. Storage

- [ ] Apply the bucket definition (SQL editor, or psql as above):
      `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f supabase/storage/private-files.sql`. It is outside
      `supabase/migrations` because the local test Postgres has no `storage` schema; it is idempotent.
      It creates the private `private-files` bucket with a 50 MB object limit and **no MIME
      allowlist**: browsers declare file types inconsistently (Chrome on Windows may send a `.csv` as
      `application/vnd.ms-excel`), so the server re-checks the extension and stored size of every
      upload (`verifyStoredUpload`) and serves downloads as `application/octet-stream`.
- [ ] Dashboard → Storage → Settings: the project-wide **upload file size limit** must be at least
      50 MB (the account export zip, `{owner_id}/_exports/armadillo-export.zip`, is capped at 48 MB of
      content plus a 2 MB margin for zip overhead). User uploads stay capped by the server: scripts/text 2 MB, PDFs/reports/evidence
      25 MB (`src/server/files/limits.ts`).
- [ ] Create no `storage.objects` policies for clients: access is server-only with the service-role
      key.

## 5. Auth

- [ ] Dashboard → Authentication → URL Configuration: **Site URL** = the production origin (for
      example `https://armadillo.example.com`); add `https://<production-origin>/auth/confirm` to
      **Redirect URLs** (sign-up sends `emailRedirectTo: <origin>/auth/confirm`; add the preview
      origin too if previews should work).
- [ ] Email provider: email + password on; keep **Confirm email** on (sign-up then answers "Check
      your email to confirm your account").
- [ ] Sign-up policy. Decide who may create accounts: every account can spend the server's
      `ANTHROPIC_API_KEY` (within the Claude budgets of section 8).
  - Open sign-up: `SIGNUPS_ENABLED` unset or `true`.
  - Closed (personal or invite-only instance): set `SIGNUPS_ENABLED=false` **and** turn off
    Authentication → Sign In / Providers → **Allow new users to sign up**. `SIGNUPS_ENABLED=false`
    makes the app's sign-up action refuse ("Sign-up is not open on this server") and hides "Create an
    account" on /login, but the Supabase Auth API itself still accepts sign-ups with the public anon
    key until the dashboard switch is off. Create accounts from Authentication → Users instead.
- [ ] The test sign-in provider (`ARMADILLO_TEST_AUTH`) must never be enabled on a deployment. It
      refuses to start when `NODE_ENV=production`, `VERCEL` is set, or `SUPABASE_SERVICE_ROLE_KEY` /
      `NEXT_PUBLIC_SUPABASE_URL` is set, but do not rely on that: never set `ARMADILLO_TEST_AUTH`,
      `TEST_AUTH_SECRET` or `LOCAL_FILE_STORE_DIR` in Vercel.

## 6. Hosted role checks

The server connects as `postgres` and switches role per transaction (`set local role authenticated`
/ `anon` / `service_role`, `src/server/db/withUser.ts`). Run these as `postgres` (SQL editor or psql);
each must succeed:

```sql
select pg_has_role('postgres', 'authenticated', 'member'),
       pg_has_role('postgres', 'anon', 'member'),
       pg_has_role('postgres', 'service_role', 'member');     -- all true
begin; set local role authenticated; select auth.uid(); rollback;   -- null, no error
begin; set local role service_role; select count(*) from public.sessions; rollback;
select count(*) from auth.users;                               -- postgres can read auth.users
select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;   -- the profile trigger from 0001
select relowner::regrole, (select proowner::regrole from pg_proc where proname = 'check_rate_limit')
  from pg_class where oid = 'public.rate_limit_hits'::regclass;   -- the same role (postgres)
```

`rate_limit_hits` has RLS enabled with no policies and every client grant revoked; RLS is
deliberately not FORCEd, so `check_rate_limit()` (SECURITY DEFINER) works through its owner whether or
not that role has BYPASSRLS. That only holds if the table and the function have the same owner (last
query). Account deletion uses the Auth admin API (service-role key), not SQL on `auth.users`.

## 7. Environment variables

Set these in Vercel → Project → Settings → Environment Variables (Production; Preview only if
previews point at a separate Supabase project). `.env.example` lists the same variables for local
development. Blank values mean the default.

| Variable | Production | Used by | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | required | `src/server/db/pool.ts` | Supabase transaction pooler URL (port 6543); prepared statements are off, so the pooler works. |
| `DATABASE_POOL_MAX` | optional | `src/server/db/pool.ts` | Connections per instance, default 5. |
| `NEXT_PUBLIC_SUPABASE_URL` | required | Auth (`src/server/auth/supabase.ts`), Storage, CSP `connect-src` (`src/proxy.ts`) | Project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required | Auth (`src/server/auth/supabase.ts`) | Public by design; safe only with section 2 done. |
| `SUPABASE_SERVICE_ROLE_KEY` | required | Storage and the Auth admin API (`src/server/files/storage.ts`) | Server-only secret. |
| `KEY_ENCRYPTION_SECRET` | required | Saved Claude keys and abuse-report hashes (`src/server/security/crypto.ts`) | 32 random bytes (`openssl rand -base64 32`) or a passphrase of 32+ characters. Changing it makes saved keys unreadable. Without it nobody can save a key and abuse reports are unavailable. |
| `ANTHROPIC_API_KEY` | optional | Claude gateway (`src/server/claude/keys.ts`) | Server key for users without their own saved key. Without it, users must save a key in Settings. |
| `CLAUDE_MODEL` | optional | `src/server/claude/client.ts` | Default model when a profile sets none (fallback `claude-sonnet-5-5`). |
| `CLAUDE_MAX_TOKENS` | optional | `src/server/claude/client.ts` | Chat reply output tokens, default 8192. |
| `CLAUDE_TOOL_MAX_TOKENS` | optional | `src/server/claude/client.ts`, `src/features/proposals/service.ts` | Structured call output tokens, default 16000. Also sets the largest script an adaptation accepts (about 41 KB at 16000; see section 10). |
| `CLAUDE_CONTEXT_TOKENS` | optional | `src/server/claude/client.ts` | Document budget per request (4 characters per token), default 60000. |
| `CLAUDE_MAX_RETRIES` | optional | `src/server/claude/client.ts` | SDK retries on transient API errors, default 2. |
| `ANTHROPIC_BASE_URL` | leave unset | `src/server/claude/client.ts` | Tests point it at the local mock. |
| `SITE_URL` | required | `src/lib/siteUrl.ts` (sitemap.xml, robots.txt) | Production origin, e.g. `https://armadillo.example.com`. Default `http://localhost:3000`. |
| `SIGNUPS_ENABLED` | optional | `src/server/auth/signups.ts`, /login | Default `true`; `false` closes sign-up (section 5). |
| `NODE_ENV`, `VERCEL`, `NEXT_RUNTIME` | set by the platform | test-auth guard, headers, instrumentation | Do not set by hand. |
| `ARMADILLO_TEST_AUTH`, `TEST_AUTH_SECRET` | **never** | test sign-in provider | Local development and tests only. |
| `LOCAL_FILE_STORE_DIR` | **never** | `src/server/files/storage.ts` | Local disk store for dev/tests; refused on Vercel (the store throws). |
| `LOCAL_FILE_SIGNING_SECRET` | **never** | `src/server/files/storage.ts` | Signs the local store's download links (falls back to `TEST_AUTH_SECRET`). |

Variables read only by the test tooling (`ACCEPTANCE_REAL_CLAUDE` and `ACCEPTANCE_CLAUDE_*` in
`playwright.config.ts`, described in docs/testing.md; `ANTHROPIC_MOCK_PORT`; `TEST_DB_PORT` and
`PGBIN` in `scripts/test-db.sh`) are never set on a deployment.

## 8. Vercel

- [ ] Import the repository; framework preset Next.js; build `pnpm build`; Node.js 22.
- [ ] Set the environment variables of section 7.
- [ ] Function duration: the Claude streaming route (`src/app/api/claude/messages/route.ts`), the
      account export route and the session page export `maxDuration = 300`, and the Anthropic client
      times out at 270 s below it. The Vercel plan/configuration must allow 300-second functions;
      with a lower ceiling long Claude replies and adaptations are cut off.
- [ ] Region: the same as (or close to) the Supabase region.
- [ ] Claude spend: every Claude request counts against per-user budgets kept in
      `check_rate_limit` (`src/server/claude/budget.ts`): 60 chat turns and structured tool calls per
      hour per user, 10 Settings "Test connection" calls per hour per user. Refusals read "You have
      reached the limit … Try again in N minutes." The budgets apply to every user, including users
      who saved their own API key (one simple rule; the server cannot tell in advance which key a
      whole call will use). They bound, but do not remove, what registered users can spend of the
      server key: close sign-up (section 5) if that matters.

## 9. Public pastebin: abuse reports, rate limits, and the proxy-header trust assumption

`0006_rate_limit.sql` creates the private `rate_limit_hits` table and `check_rate_limit()` (SECURITY
DEFINER, empty `search_path`, executable by `anon` and `authenticated`); keys must carry the caller's
own `auth.uid()` (`publish:`, `edit:`, `claude:`, `claudetest:`) except opaque `report:` hashes.
Paste limits: 10 publishes/hour/user, 60 other paste edits/hour/user, 5 abuse reports/hour per
reporter.

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

Caching: `/p/<slug>/raw` sends public pastes with `Cache-Control: no-cache` and a strong ETag (caches
must revalidate, so a deleted paste disappears at once), unlisted ones with `private, no-store`.
Highlighted paste HTML is memoized in memory per server instance (64 K characters are highlighted at
most; larger pastes, or pastes that take over 500 ms to tokenize, are shown as plain text).

## 10. Known limits and follow-ups

- Script adaptation returns the whole script in one non-streaming tool call, so scripts larger than
  the output budget allows are refused up front with their size and the limit (about 41 KB at the
  default `CLAUDE_TOOL_MAX_TOKENS=16000`). A structured answer cut off at the output limit fails at
  once with a "cut off" message (no automatic retry). Follow-up: streaming or diff-based adaptation
  for large scripts.
- Migrations: renumber/squash before the first deploy so the Supabase CLI can apply them; CI
  migrate-on-merge is not automated.

## 11. Nightly acceptance workflow (GitHub)

- [ ] Repository → Settings → Secrets and variables → Actions: add the secret `ANTHROPIC_API_KEY`
      (a key with a small spend limit). `.github/workflows/nightly.yml` runs the acceptance walk
      against the real Claude API every night and passes the secret only to the test step. Without it
      the nightly job fails at configuration (docs/testing.md).

## 12. Smoke test after the first deploy

- [ ] Section 2 curl checks fail as expected.
- [ ] Sign up (or create a user in the dashboard), confirm the email, sign in, create a session.
- [ ] Settings → Test connection reports the key source; upload a README PDF over 4 MB (direct
      Storage upload) and a `.csv` LEADS report; download a script version.
- [ ] Publish a paste, open `/p/<slug>` signed out, delete it, and check `/p/<slug>/raw` is 404.
