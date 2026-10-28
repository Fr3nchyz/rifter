# Railway backend, Supabase database, Vercel interface

This is the recommended deployment for the existing application. Vercel serves
the OpenRift interface; Railway runs the existing Bun API and Python store adapter;
Supabase holds PostgreSQL; Porkbun manages the chosen domain's DNS. Your home
computer does not need to stay on.

The repository contains deployment files. No Railway account/project, Supabase
connection, Vercel deployment or DNS change has been created automatically.
These changes must be committed and pushed to the Git branch selected by the
hosting services before a GitHub-connected deployment can build them. A working
cloud checkout does not update the remote repository by itself.

## Railway service

Create a Railway account and connect the parent `Fr3nchyz/rifter` repository,
including its OpenRift submodule, with the repository root as the service root.
`railway.json` selects `deploy/railway/Dockerfile`. The image includes Bun 1.4.3,
Python and the existing adapter. It does not include local secrets or user data.

Attach a persistent volume at **`/app/.local`**. Run **one replica**: stock refresh
uses a process registry and one active Python job. The supervisor starts the
native API internally on port 3000 and the API/media gateway on Railway's `PORT`.
Expose the gateway; do not expose port 3000 as a second public service. Readiness
requires a populated catalog, rather than accepting the upstream `db_empty` state.

Set these Railway variables privately in its settings:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | A dedicated Supabase project's PostgreSQL **session-pooler** connection, with `sslmode=verify-full`. Use the correct host-specific username/password. Do not put it in chat or frontend variables. |
| `RIFTER_DATABASE_PURPOSE` | `rifter`, explicitly identifying this dedicated application database. |
| `BETTER_AUTH_SECRET` | A stable, randomly generated private secret; preserve it across redeployments. |
| `BETTER_AUTH_URL` | Exact public Vercel frontend HTTPS origin. |
| `CORS_ORIGIN` | The same exact frontend origin. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Transactional email credentials for signup verification. Supabase's built-in Auth mail delivery is not an SMTP service for OpenRift's Better Auth. |
| `CATALOG_SOURCE_URL` | `https://openrift.app` unless you deliberately use another compatible source. |

`APP_ENV=production` and `RIFTER_ROOT=/app` are set by the image. Railway provides
`PORT`. The session pooler supports the existing persistent backend and migration
steps; a transaction-pooler deployment has not been independently verified.

## Database initialization

The pre-deploy command in `railway.json` runs `hosted-init.ts --catalog-if-empty`:

1. Refuses an unrelated database with existing public tables and no OpenRift
   migration marker. It requires `RIFTER_DATABASE_PURPOSE=rifter` and verified
   TLS for a remote connection.
2. Restricts public/anon/authenticated default access before creating private
   application objects. It does not modify Supabase's auth/storage schemas or
   provider-owned extension objects.
3. Requires PostgreSQL 15+ and supplies UUIDv7 on earlier versions where native
   UUIDv7 is absent. PostgreSQL 18 retains its native implementation.
4. Runs OpenRift migrations and the additive Rifter schema. The baseline resolves
   the actual `pg_trgm` extension schema and does not alter extension comments.
5. Restricts access to the app-owned tables/functions and seeds an empty catalog
   using the existing validated catalog writer. Existing catalog/source safety
   checks remain active; subsequent deployments do not refresh a populated catalog.

The database role must be allowed to run the migrations and the `pg_trgm` and
`pg_stat_statements` extensions must be available. If the managed role cannot
install an extension, enable that supported extension in Supabase first. These
permissions and the live Supabase connection still need verification on staging.
The API also retains upstream's idempotent migration check at startup.

Keep the native OpenRift/Better Auth account model. The PostgreSQL connection
belongs only on Railway; the browser does not use Supabase anon/service-role keys.
For this PostgreSQL-only project, disabling Supabase's Data API is also an option.
Do not expose native private application tables through PostgREST.

## Connect Vercel and the domain

Generate the Railway service's HTTPS domain. Set Vercel `API_INTERNAL_URL` to
that origin, without a path. Set Vercel `APP_ENV=production` and `SITE_URL` to
the frontend origin, then use the root `vercel.json` build. See [Vercel delivery](VERCEL.md).

Verify the staging deployment first: email signup/login, cookies after reload,
collection edits, reviewed import, deck gaps, undo, images, a verified inventory
CSV and an actual iPhone Safari session. Check database backups and restore in
staging. Store scraping remains an explicit user action; deploying must not start
a refresh or place an order.

Once staging works, add a subdomain such as `rifter.amaurymarque.com` in Vercel and
enter the exact DNS record it supplies in Porkbun. Leave the existing root site
and mail records intact. Update the frontend/backend origin variables together
and rebuild Vercel. Use a separate staging database and exact staging origin;
do not broadly trust all `*.vercel.app` projects.

## Local deployment validation

From the parent repository, build with:

```sh
docker build -f deploy/railway/Dockerfile -t rifter-railway:review .
python3 scripts/test-hosted.py --postgres 17
```

The integration test uses isolated containers and a public catalog/init snapshot
at `.local/run/hosted-catalog.json`; it never resets the personal database. Its
fixtures simulate Supabase extension placement and API roles. A successful local
test is not a claim that Railway/Supabase account settings or iPhone access work.

Validated locally against PostgreSQL **17 and 18.6**: fresh migrations and catalog
initialization, `pg_trgm` in `extensions`, restricted private table/function
grants, UUIDv7 with the native PostgreSQL 18 function preserved, production-mode
signup/login, trusted frontend versus unrelated origins, import quarantine and
idempotent confirmation, deck gaps, undo, the packaged Python CSV adapter, cached
images, backend restart persistence and repeatable pre-deploy initialization.
The upstream database regression suite and API type checks also pass.
