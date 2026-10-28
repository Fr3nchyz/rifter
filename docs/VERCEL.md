# Vercel delivery

The selected architecture is **Railway backend + Supabase PostgreSQL + Vercel
interface**, with Porkbun DNS. See [Railway setup](RAILWAY.md) for the backend
image, persistent volume and initialization command.

The web interface can use your existing Vercel account. You do not need a home
computer running once the hosted backend and database are provisioned.

This repository now includes a Vercel frontend build configuration. It is not
a live deployment, and it does not provision a backend, database or email service.
Do not deploy `workspace.html` as a static website.

Your existing services cover two more pieces: **Supabase** can supply managed
PostgreSQL, and **Porkbun** can supply DNS for the Vercel domain. A separate
backend host remains necessary for this configuration. Supabase PostgreSQL
does not run the Bun API or Python importer.

An alternative using only Vercel and Supabase is feasible for the first-release
collection/deck/import/history features, but is **not implemented by this frontend
configuration**. It needs a Bun Function API entry that initializes the request
router without migrations, schedulers or a listening server; smaller database
pools; a separate migration step; and explicit disabling of Python/background
shopping and unsupported file-backed routes. Those features must not silently
appear to work on ephemeral function storage. This is a product-scope choice
before adapting the backend, not a reason to create another provider account
automatically.

## Architecture

The browser visits one HTTPS address, for example `rifter.amaurymarque.com`.
Vercel serves the native OpenRift interface and server-side rendering. Browser
requests to `/api/**` and `/media/**` are rewritten to a persistent backend.
Server-side requests use the same backend via `API_INTERNAL_URL`.

Keep the Bun API, existing Python importer and managed PostgreSQL together on
a persistent service such as a container host. The store refresh currently
spawns Python processes and maintains an in-memory process registry; it has not
been adapted or verified as a Vercel Function. Vercel support here is for the
frontend, not a claim that the entire application runs there.

The backend origin must serve **both** `/api/**` and `/media/**`. A bare Hono API
port does not serve card images. Use an appropriate reverse proxy/image service,
with persistent media/cache paths and the existing adapter's private working
directory. The local Docker launcher is not a production backend deployment.

## Vercel project

Import the parent `Fr3nchyz/rifter` repository with its submodule, using the
repository root as the project root. Keep `vercel.json`'s install and build
commands; do not choose an HTML-only output directory. Installation pins Bun
1.4.3, installs the OpenRift workspace and applies the parent overlay. It does
not start Docker, run database migrations or change your collection.

Set these Vercel project environment variables for the intended deployment:

| Variable | Value |
| --- | --- |
| `API_INTERNAL_URL` | The backend HTTPS origin, without `/api`, credentials or another path. Required at build time **and** function runtime. |
| `SITE_URL` | The public frontend HTTPS origin. |
| `APP_ENV` | `production` for the deployed frontend. |

The build uses Nitro's `vercel` preset, validates the generated API/image
rewrites, and places the Build Output API artifact in `.vercel/output/`.
The ordinary local build still uses Nitro's `bun` preset. Changing the backend
origin requires rebuilding because the edge rewrite destinations are generated
at build time. Database and SMTP secrets belong on the backend, not in `VITE_*`
variables or frontend source.

## Backend configuration

| Variable | Purpose |
| --- | --- |
| `APP_ENV=production` | Production API behavior. |
| `DATABASE_URL` | Managed PostgreSQL connection. |
| `BETTER_AUTH_SECRET` | Stable private auth signing secret. |
| `BETTER_AUTH_URL` | The public **Vercel frontend** origin, not the backend origin. |
| `CORS_ORIGIN` | The exact frontend origin permitted for credentialed requests. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Real verification email delivery; local Mailpit cannot deliver to your inbox. |
| `RIFTER_ROOT` | Backend path containing the Python package and writable private `.local/` working directory. |

Use separate databases and secrets for staging and production. A changing Vercel
preview URL is not automatically trusted by the backend: configure an exact
chosen preview origin. Do not trust every project under `*.vercel.app`.

Backend preparation still includes the upstream migrations, additive
`integrations/openrift/schema.sql`, catalog initialization, backups and a
production process entry point. The existing catalog sync intentionally refuses
remote databases; that needs an explicit hosted initialization workflow.

### Using the existing Supabase account

Use a dedicated Supabase project for Rifter and its PostgreSQL connection string
on the backend. Choose a connection/pooler endpoint supported by that host and
keep prepared statements disabled, as both existing database adapters already
do. Use a direct or session-pooler connection for migrations. Supabase credentials
and a live database have not been accessed or verified here.

Keep native OpenRift/Better Auth accounts initially; replacing them with Supabase
Auth would be a separate migration. Never put a PostgreSQL password or service
role key in the browser. Before loading personal data, verify that the new
OpenRift tables are not readable through Supabase's public Data API: review
grants/RLS for the Rifter project. The native API uses server-side PostgreSQL
connections and enforces collection ownership there.

Porkbun DNS changes come after a working Vercel staging deployment. Use the exact
record Vercel gives for the chosen subdomain; leave the existing root site and
email records intact. Neither service has been modified by this configuration.

## Validation and remaining deployment work

The frontend build can be checked without deploying:

```sh
python3 scripts/install-vercel.py
API_INTERNAL_URL=https://your-backend-host python3 scripts/build-vercel.py
```

Generating an artifact does not verify the remote API. Before connecting your
domain, use an isolated staging backend and test the Vercel preview for email
signup/login, cookie persistence after reload, collection edits, reviewed
imports, deck gaps, undo, card images and an actual iPhone Safari session.
Backups must restore on the hosted database as well. No Vercel account has been
linked, deployment created or DNS record changed by these scripts.

The provider behavior referenced here is documented in the pinned Nitro
package's `dist/docs/1.deploy/2.providers/21.vercel.md` and its Vercel preset
implementation. Live project permissions and service configuration remain
unverified until a deployment is performed.

Local validation completed: the pinned install completed without database setup;
the Vercel build and TypeScript checks passed; generated API/media rewrites
precede filesystem handling; and the generated Node 24 fetch handler returned
the login HTML and redirected an anonymous protected-page request to login.
The backend origin used for artifact generation was a placeholder; no remote
backend, Supabase project, Vercel deployment or actual iPhone has been validated.
