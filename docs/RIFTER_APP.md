# Rifter personal collection workspace

Rifter extends the pinned OpenRift application, rather than keeping a second
collection database. OpenRift remains responsible for accounts, catalog,
per-copy ownership, locations and deck editing. Choose **Rifter** in its
navigation for your collection-first home. OpenRift’s existing collection browser, deck editor, missing-card dialog and wishlists remain the main workflow; reviewed imports, shopping and history are secondary tools.

## Start at home

Open the running app in your browser, not `workspace.html` or another HTML file.
Those files are interface source and cannot connect to the collection database
on their own. A downloaded HTML preview is not the installed application.

Prerequisites: Python 3.10+, Docker with Compose, Git, and Bun 1.4.3. If Bun is
absent, setup installs that pinned version locally using npm. Run from the
repository root:

```sh
python3 scripts/setup.py --origin http://192.168.1.50:5173
python3 scripts/start.py
```

For normal use without leaving a terminal open, use `python3 scripts/app.py start`.
Check `python3 scripts/app.py status` for separate supervisor, API and app health.
Use `python3 scripts/app.py stop` to stop the app while preserving the database.
Background startup logs are private in `.local/run/supervisor.log`. A stopped
cloud environment still requires starting the app again; background startup
does not deploy a public site or run on your home computer.

Replace the example IP with your computer's actual home-network address. Use
the same configured origin on computer and phone; both devices must be on your
home network. Allow the app port through the computer's local firewall if
necessary. Do not expose this development server through a router port forward.
Real phone access from your home network cannot be established by a cloud test.

Without `--origin`, setup uses the computer's localhost origin. Running setup
again preserves secrets, dependencies and data; `--origin` explicitly updates
the app/CORS origins. `--skip-catalog` keeps an existing catalog unchanged.
The database listens only on loopback and persists in `rifter-postgres`.

Register your own account in OpenRift. Verification messages are captured by
Mailpit on the host's loopback port 8025; read the verification code on the
computer and enter it on either device. No real email credentials are needed.
Mailpit is a development-only component and must not be publicly exposed.

`start.py` starts the bundled OpenRift interface, API and same-origin proxy and stops them on Ctrl-C. The first setup builds the interface; unchanged starts reuse it. Use `python3 scripts/start.py --dev` only when you need hot reloading. Normal use avoids development-module and generated-file reload races. The proxy caches public catalog card images locally without forwarding account cookies. It retains
private logs in `.local/run/`. Database and mail services remain running.
To stop those without deleting data:

```sh
docker compose --env-file .local/compose.env -f compose.rifter.yml stop
```

## Everyday use

- **Collection → deck → wishlist:** the home shows your real collections, a native deck card/selector and your lists. **Add cards** opens OpenRift’s catalog in collection-add mode, including collector-code search. Open a deck, select its owned/missing chip, and use **Add to wishlist** to save the missing cards with OpenRift’s existing controls. **New collection** and **New wishlist** use the original dialogs.
- **Quick entry:** pick a set once (it stays selected) and type only the number: `12` finds exactly `RAD-012`, with lettered or promo variants listed beneath and never `RAD-120`. `R3`/`T5` find rune/token codes. The default printing (English, normal finish, standard art) is offered first; other printings stay visible. Full codes and names still work.
- **Code-batch review:** choose **Code batch** on the home to search `RAD-120`, `OGN-123` or a name. Choose a printing,
  increment its quantity and review the acquisition batch. Nothing is owned
  before confirmation. Card metadata/location can be edited in OpenRift.
- **Import inbox:** paste a Piltover deck code, a text list, or upload Piltover,
  Rifty or OpenRift CSV. Choose a collection/new deck/existing deck and add or
  replace behavior. Every import is saved as pending with its original input.
  Resolve printing choices and section warnings, or explicitly exclude rows,
  before applying. Repeated applied input requires duplicate acknowledgement.
- **Review screen:** a live line counts rows ready, needing attention (unmatched / need a printing) and tokens ignored; a filter (on by default when something needs attention) shows problem rows first, each with a status chip and coloured edge. **Exclude all unmatched rows** is explicit and stays in history. Unmatched rows say why. A code that matches while the name differs is kept as a candidate with a warning and needs your choice. Token rows (`XXX-T##` codes, `A // B` names, catalog type token) start excluded as "Ignored: token"; runes are normal cards; untick Exclude to track a token.
- **Replace a collection:** **Replace a collection from a file** makes a binder match the file (quantities per card
  in the default printing, or the finish/language the file names). The review shows cards added, removed and changed
  and lists every removal first. Existing copies are kept (notes and grading survive); only surplus copies are removed
  (plain ones, newest first) and shortfalls added. Other finishes/languages of listed cards are left alone; cards the
  file never mentions are removed; unresolved or excluded rows never cause removals. Replacing is refused when no row
  resolves, and removing over half the copies needs an extra acknowledgement. Applying the same file again changes
  nothing and needs no duplicate acknowledgement. History records it as one undoable action.
- **Deck gaps:** mark a deck active or aspiring. Ownership is shared independently
  between decks, never reserved. Within one deck, copies are allocated once
  across zones. Sideboards are included by default. Strict-printing mode
  allocates constrained slots before unrestricted ones.
- **History:** personal collection/copy, deck, deck-card, strategy/matchup and
  Rifter status edits are recorded transactionally, including native OpenRift
  edits. Undo records a reversal and can itself be reversed. Conflicting newer
  changes block reversal; undo those first. Transfers between owners or shared collections are deliberately outside personal undo.
  This is not an audit/undo system for
  OpenRift's unrelated group trades, account settings or administrative catalog.
- **Shopping:** load a validated Game Keeper CSV or explicitly request a refresh
  when authorized. Check progress or cancel it. Comparisons subtract ownership
  first, split available quantities across eligible name-matched printings and
  compare each selected deck independently. Import alternative legends as
  separate aspiring decks; Evelynn is never replaced automatically.

Amounts are CAD available-copy subtotals, not complete-deck quotes. Taxes,
shipping, reservations and branch pickup inventory are not inferred. Review
printing/condition/finish differences and product links. Unknown stock, missing
listings, incomplete coverage, stale observations and failed refreshes remain
distinct. Failed/cancelled refreshes never replace the last good snapshot.

Quarantined imports remain `applied` as historical records after their resulting
action is undone. Reapplying the same import ID is a no-op; stage a new import
if you deliberately want another acquisition. A duplicate warning remains useful
even after reversal. The workspace lists the latest 100 imports/actions; older
records remain in PostgreSQL and in backups.

## External integration evidence

Checked during implementation on October 27, 2026:

| Source | What is established |
| --- | --- |
| OpenRift public catalog | Verified HTTPS catalog access; 13 sets, 1,106 cards and 9,039 printings synchronized. This is an available public data API independent of Piltover. |
| Piltover Archive | Pinned official deck-code library supports codes; collection CSV is supported. Homepage reachable, but candidate API/documentation requests returned 403. No live account/API connection or token requirement is inferred. |
| Game Keeper Verdun | Authorized importer completed 66 pages / 1,563 listings. Generated CSV/report are in ignored `.local/stock/onboarding-inventory.*`. A dated traversal is not a reservation or independently verified pickup inventory. |
| Face to Face | Official homepage announces an alternate Verdun store location. Follow its [official notice](https://magic.facetofacegames.com/the-verdun-store-is-evolving/) before travelling. Live stock integration and pickup availability remain unverified. |
| 401 Games | Its [official locations page](https://store.401games.ca/pages/toronto-vaughan-locations-hours) lists Toronto and Vaughan; classified as Canadian shipping fallback, not Montréal pickup. No stock adapter is claimed. |

The supplied private Evelynn list and your actual collection were not present
in this checkout. Import them through the workspace; no fictional ownership or
replacement deck has been loaded into your account. Camera scanning and
automatic competitive deck recommendations remain deferred.

The pinned upstream catalog sync expects a deprecated singular `type` that the
live catalog no longer supplies. `sync-catalog.ts` derives that storage field
from the first canonical `types` entry, preserves the full type list, then uses
strict upstream validation and its transactional catalog writer. It refuses
non-local databases, unmanaged catalogs and source changes. This sync intentionally
does not refresh unrelated marketplace feeds or rules documents.

## Reproducibility and maintenance

`integrations/openrift/` is the reviewed source of truth for this extension.
`python3 scripts/apply-openrift.py` copies its API/shared/UI additions into the
submodule and applies small route/navigation/auth-form wiring changes. Native OpenRift collection/deck import entry points lead to this same inbox.
The Git submodule pointer stays pinned; no unpublished upstream commit is required.
The two auth forms use POST as their pre-hydration fallback so credentials are
not submitted in a URL. Normal hydrated submission still uses Better Auth.

Do not edit generated overlay copies in the submodule. Edit the parent sources
and reapply. Review local edits before reapplying: overlay files are replaced
from their parent sources. Upstream updates require reviewing the overlay and
rerunning validation. OpenRift attribution and AGPL licensing are retained.

```sh
python3 -m unittest discover -s tests -v
python3 scripts/test-rifter.py
npm ci --ignore-scripts
npm run test:browser
cd upstream/openrift
NODE_USE_ENV_PROXY=1 bun run typecheck --filter=api --filter=web
```

Database tests recreate only the fixed disposable `rifter_test` database.
Browser tests need the app, catalog and Mailpit running and create isolated test
accounts with randomized credentials. Install Chromium with Playwright if your
system has none; `CHROMIUM_PATH` selects a system executable. Test artifacts and
screenshots are private/ignored under `.local/browser-results/`.

## Backup and restore

```sh
python3 scripts/backup.py create
python3 scripts/backup.py restore .local/backups/<archive>.tar.gz --database rifter_restore_recovery
```

For the hosted Supabase database use `python3 scripts/backup.py create --database-url`
(see [Railway setup](RAILWAY.md#backups)); keep `BETTER_AUTH_SECRET` in a password
manager because dumps do not contain it.

Local backups contain the database **and secret auth configuration** and have mode
0600. Keep them private; use encrypted storage when copying off the computer.
Restoration creates a new database only; it never overwrites your current one.
The restored auth configuration is saved under `.local/restored/<database>/`.
To switch deliberately, stop app servers, preserve the current `.env`, then use
the restored signing secret and change its database URL to the restored database.
Start the app directly with that configuration. `setup.py` manages the normal
`openrift` database only, so it refuses a recovery URL rather than overwriting it.

## Hosted access from iPhone and computer

For the Vercel frontend configuration and backend requirements, see [Vercel delivery](VERCEL.md).

Local operation is the currently verified runtime, not a product requirement.
The preferred next delivery is a hosted app with one HTTPS address, available
from Safari and desktop browsers without leaving a home computer running.
Public hosting has not been deployed. Use a subdomain such as
`rifter.amaurymarque.com` to preserve the existing root site.

Recommended starting architecture:

| Component | Hosted implementation |
| --- | --- |
| App | Vercel runs the bundled TanStack/Nitro interface; Railway runs the persistent Bun API, Python adapter and API/media gateway. |
| Data | Managed PostgreSQL with backups, retaining OpenRift tables and the additive Rifter schema. |
| Files | Persistent image cache and importer working directory; private reports and backups must not be served as website assets. |
| Login | Stable Better Auth secret, the real HTTPS app origin and transactional SMTP. Local Mailpit is not a production email delivery service. |
| Access | A single HTTPS app address for iPhone and computer; no home-network dependency. |

The local launchers remain `scripts/app.py` and `scripts/start.py`. The prepared
Railway container has its own supervisor, persistent storage, health checks and
explicit hosted migration/catalog initialization. The ordinary catalog-sync CLI
retains its local-only guard; the hosted initializer permits a dedicated database
only with `RIFTER_DATABASE_PURPOSE=rifter`, verified TLS and the existing catalog
ownership/source checks. Local container integration tests pass on PostgreSQL 17
and 18.6. Actual Railway/Supabase/Vercel staging, backup recovery and iPhone access
still need verification before connecting the domain.

The Vercel frontend build and generated server handler have been checked locally;
the persistent Railway backend keeps Python refresh jobs outside Vercel Functions.
Supabase supplies PostgreSQL, while native OpenRift/Better Auth retains account
ownership. No DNS records or public deployment have been changed here.

### Connection and plain-HTTP behavior

The review tools show a sign-in/connection state and retry action when their API cannot load. Their navigation remains responsive instead of rendering empty panels. Form-field IDs use a local counter, so plain HTTP home-network access does not depend on the secure-context-only `crypto.randomUUID()` API. The browser suite exercises the entire native collection/deck/wishlist flow with that API unavailable.
