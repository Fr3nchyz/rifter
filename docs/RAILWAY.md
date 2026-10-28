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

## Step-by-step setup (beginner)

Do these in order. Keep every secret in a password manager, never in chat, Git or
`VITE_*` variables.

### 1. Supabase project and connection string

1. supabase.com > **New project**. Name it `rifter`, choose **Postgres 17** if
   offered, pick a region near your Railway region, and save the generated
   database password in your password manager.
2. Click **Connect** (top bar). Choose **Session pooler** (not Transaction
   pooler, not Direct). Copy the URI, replace `[YOUR-PASSWORD]`, and append
   `?sslmode=verify-full` (or `&sslmode=verify-full` if a `?` exists). The user
   name looks like `postgres.<project-ref>`; keep it exactly.
3. **Disable the Data API**: Project Settings > **API** (or Data API) > turn the
   Data API off. Rifter only talks to PostgreSQL from the backend.
4. Later, after the first deploy: **Advisors > Security Advisor** and read every
   warning; there should be none about tables exposed to `anon`/`authenticated`.
5. Extensions: the migrations run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`
   and `pg_trgm` (migration `001-core-schema`). Normally the `postgres` role can do
   this. If the first deploy fails on an extension, go to **Database > Extensions**
   and enable `pg_trgm` and `pg_stat_statements`, then redeploy.

### 2. Supabase TLS certificate (required for `verify-full`)

`hosted-init.ts` refuses a remote database unless the URL has `sslmode=verify-full`.
Supabase database certificates are issued by Supabase's own certificate authority,
not a public one, so Node/Bun do not trust them by default. (This is based on
Supabase's documented "SSL enforcement" page; confirm on your project, since it
could not be tested live here.)

1. Supabase dashboard > **Project Settings > Database > SSL configuration**
   (also reachable from **Connect**) > **Download certificate**. You get a
   `.crt`/`.pem` file.
2. Open it in a text editor and copy the **entire** text including
   `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----`. If the file
   holds several certificates, copy all of them.
3. In Railway (step 4) add a variable **`SUPABASE_CA_PEM`** and paste the text.
   `deploy/railway/start.py` writes it to `/tmp/supabase-ca.pem` and sets
   `NODE_EXTRA_CA_CERTS` and `PGSSLROOTCERT` for the pre-deploy initializer, the
   API and the gateway. If `verify-full` still fails with a hostname error, the
   pooler host is not in the certificate; use the pooler string Supabase shows.

### 3. Secrets and email

- Generate `BETTER_AUTH_SECRET`: in a terminal run `openssl rand -hex 32`. Save it
  in your password manager. **If you lose or change it, every login session and
  linked sign-in is invalidated, and no database backup contains it.**
- Pick an SMTP provider with a free tier, for example **Resend** (host
  `smtp.resend.com`, port `465`, user `resend`, password = an API key; verify
  your sending domain first) or **Brevo** (host `smtp-relay.brevo.com`, port
  `587`, `SMTP_SECURE=false`, user/password from its SMTP & API page). The app
  reads `SMTP_HOST`, `SMTP_PORT` (default 465), `SMTP_SECURE` (default true; only
  the text `false` disables it), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Without
  `SMTP_HOST` the API refuses to start in production.

### 4. Railway service

1. railway.com > **New Project > Deploy from GitHub repo** > choose
   `Fr3nchyz/rifter`. If Railway offers a submodule option, enable it; the
   OpenRift submodule must be checked out. Service root is the repository root.
   `railway.json` selects `deploy/railway/Dockerfile`.
2. Service > **Variables** > add the table below.
3. Service > **Settings > Networking > Generate Domain**. Port is Railway's
   `PORT`; do not add a second public port.
4. **Persistent storage (volume)**: on the project canvas press `Ctrl/Cmd+K`
   (or right-click the canvas) > **Volume**, attach it to the Rifter service and
   set the mount path to **`/app/.local`**. (Dockerfile `VOLUME` is not used on
   Railway.) Volumes make the service redeploy briefly; this is expected.
5. Service > **Settings** > keep **replicas at 1**.
6. Deploy. The first deploy's pre-deploy step runs migrations and downloads the
   public catalog, which can take several minutes; the healthcheck waits up to
   180 s after that. Watch **Deployments > Logs**.

Railway variables (set privately):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase **session-pooler** URI with `sslmode=verify-full` (step 1). |
| `SUPABASE_CA_PEM` | The downloaded Supabase certificate text (step 2). |
| `RIFTER_DATABASE_PURPOSE` | `rifter` (marks this as the dedicated database). |
| `BETTER_AUTH_SECRET` | Output of `openssl rand -hex 32`; keep it stable. |
| `BETTER_AUTH_URL` | Exact public Vercel frontend HTTPS origin, e.g. `https://rifter.amaurymarque.com`. |
| `CORS_ORIGIN` | The same exact origin. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Provider values from step 3. |
| `CATALOG_SOURCE_URL` | `https://openrift.app` unless you deliberately use another compatible source. |

`APP_ENV=production` and `RIFTER_ROOT=/app` are set by the image. Railway provides
`PORT`; the supervisor runs the private API on an internal port that differs from
`PORT` (default 3000, or 3001/3002 on collision; override with `RIFTER_API_PORT`).
The session pooler is the verified choice; a transaction pooler has not been tested.

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

The database role must be allowed to run the migrations; see step 1.5 for the
`pg_trgm`/`pg_stat_statements` extensions. These permissions and the live Supabase
connection still need verification on staging.
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

## Backups

- **Supabase daily backups**: Supabase takes automatic daily backups of paid
  plans; on the free plan check Database > Backups for what your plan keeps
  (retention is short). **Point-in-time recovery (PITR) is a paid add-on.** Do
  not rely on free-tier backups alone.
- **Your own dump**, from a computer with PostgreSQL 17 client tools
  (`pg_dump`, `pg_restore`):

```sh
export DATABASE_URL='postgresql://...sslmode=verify-full'   # the session-pooler URI
export PGSSLROOTCERT=/path/to/supabase-ca.pem               # the downloaded CA
python3 scripts/backup.py create --database-url
```

  This writes a private `.local/backups/rifter-hosted-*.dump` (equivalent to
  `pg_dump "$DATABASE_URL" -Fc --no-owner`). To test a restore, create a new
  empty Supabase project, then set `RESTORE_DATABASE_URL` to its URI and run
  `python3 scripts/backup.py restore <file>.dump --database-url`.
- **`BETTER_AUTH_SECRET` is not in any database backup.** Keep it in a password
  manager, along with the SMTP credentials and the Supabase CA.
