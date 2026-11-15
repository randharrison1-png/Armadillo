# Armadillo

Armadillo is a private cybersecurity hardening workspace with a public pastebin. Each hardening
session keeps one image's README, scripts, LEADS audit results, verification evidence and progress
together. Claude (through the server-side Anthropic API) adapts universal hardening scripts to the
session's README, assesses requirement coverage and proposes remediation scripts. Scripts are never
run from the browser: you download them, run them on the machine, and upload the output.

- Product specification: [docs/spec/Armadillo_Product_Specification_v1.1.md](docs/spec/Armadillo_Product_Specification_v1.1.md)
- First deployment checklist: [docs/deploy.md](docs/deploy.md)
- Tests and the v1.0 acceptance walk: [docs/testing.md](docs/testing.md)
- Implementation plan: [docs/plans/2026-11-13-armadillo-v1.md](docs/plans/2026-11-13-armadillo-v1.md)

## Stack

- Next.js 16 (App Router, server actions, route handlers), React 19, TypeScript, Tailwind CSS 4
- PostgreSQL through postgres.js (`src/server/db`), with row-level security doing the ownership checks
  (`withUser` runs each request's queries as the `authenticated` role with the user's JWT claims)
- Supabase Auth (`@supabase/ssr`) and Supabase Storage (bucket `private-files`) in production
- Anthropic SDK (Claude), server-side only
- Monaco (script editor), Shiki (paste highlighting), React Flow (hardening flowchart)
- Vitest (unit and database tests), Playwright 1.63 (end-to-end tests)

## Quick start (local development)

Requirements: Node.js 22, pnpm 10, and PostgreSQL 16 binaries (`scripts/test-db.sh` looks in
`/usr/lib/postgresql/16/bin`; set `PGBIN` to use another location). No Docker is needed.

```bash
pnpm install
pnpm db:start          # Postgres 16 on 127.0.0.1:54329 (data in .tmp/pg), shim + migrations applied
cp .env.example .env.local
```

Then edit `.env.local` for local development with the test sign-in provider (never on a
deployment):

```bash
ARMADILLO_TEST_AUTH=1
TEST_AUTH_SECRET=<any string of at least 32 characters>
LOCAL_FILE_STORE_DIR=.tmp/files
KEY_ENCRYPTION_SECRET=<openssl rand -base64 32>
ANTHROPIC_API_KEY=<your key, optional: users can save their own in Settings>
```

```bash
pnpm dev               # http://localhost:3000; sign in with any email address
```

The test provider refuses to start when `NODE_ENV=production`, `VERCEL`, `SUPABASE_SERVICE_ROLE_KEY`
or `NEXT_PUBLIC_SUPABASE_URL` is set. To develop against a real Supabase project instead, leave
`ARMADILLO_TEST_AUTH` empty and fill in the Supabase variables (see docs/deploy.md).

`pnpm db:reset` rebuilds the local database from scratch: `supabase/shim/*.sql` (the roles, `auth`
schema and `auth.uid()` that Supabase provides) followed by `supabase/migrations/*.sql`, in C-locale
filename order. `pnpm db:stop` stops it.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm build` / `pnpm start` | Production build / server |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint, including the spacing-scale rule in `eslint-rules/` |
| `pnpm test` | Vitest unit tests (no database) |
| `pnpm test:db` | Vitest database tests against the local Postgres (port 54329) |
| `pnpm test:e2e` | Playwright against a production build on port 3100 (test auth, Anthropic mock) |
| `pnpm db:start` / `db:stop` / `db:reset` | Local test Postgres (`scripts/test-db.sh`) |
| `pnpm fixtures` | Regenerates the binary test fixtures (`tests/fixtures/make-fixtures.ts`) |

No test calls the real Anthropic API except the nightly acceptance workflow; see docs/testing.md.
Playwright uses the browsers already installed at `PLAYWRIGHT_BROWSERS_PATH` (it never downloads
them in this workspace).

## Project layout

```
src/app/            routes: (app) signed-in workspace, (auth) login, (public) pastebin /p,
                    api/ route handlers (Claude streaming, files, account export)
src/features/       one folder per feature: UI components, server actions (actions.ts) and
                    services (service.ts): claude, flowchart, library, pastebin, proposals,
                    readme, reports, requirements, sessions, settings, workspace, auth
src/server/         server-only code: auth providers, db access (withUser/withAnon/withService),
                    Claude gateway (claude/client.ts is the only Anthropic SDK import), file
                    storage, security (crypto, rate limits, headers), activity log
src/lib/            shared pure code and types (src/lib/types.ts holds the domain types)
src/components/     shell (sidebar, tabs, inspector, states) and UI primitives
supabase/migrations plain Supabase-compatible SQL, applied in filename order
supabase/shim/      local-only stand-in for what hosted Supabase provides (never apply it there)
supabase/storage/   the private-files bucket, applied by hand at deploy time
tests/unit|db|e2e   Vitest unit, Vitest database and Playwright suites
docs/               spec, plan, deploy checklist, testing notes
```
