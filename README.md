# Rifter

The integrated OpenRift collection workspace is implemented. See
[Rifter app setup and usage](docs/RIFTER_APP.md) for home-network startup,
reviewed imports, code-based acquisitions, undo, shopping, backup and validation.
Run `python3 scripts/setup.py` then `python3 scripts/app.py start` from this directory.
Use `python3 scripts/app.py status` to check readiness. Open the configured app
address in your browser and sign in. **Do not open an HTML file directly:**
the collection app needs its running OpenRift server and PostgreSQL database.

For access from iPhone without a home computer running, see [Vercel delivery](docs/VERCEL.md).
The frontend build is configured; provisioning and deploying the backend/database
are still required.
The recommended full deployment uses [Railway with the existing Supabase database](docs/RAILWAY.md).

A local Riftbound collection and deck-shopping project: use OpenRift for collection/deck tracking and compare missing cards with Game Keeper Verdun inventory.

**Current state:** OpenRift now has an integrated Rifter workspace backed by PostgreSQL. The original standalone Python planner remains available below. [PROJECT_PLAN.md](PROJECT_PLAN.md) records the earlier roadmap; the linked app guide documents the implemented behavior and remaining external-integration limits.

## Get the project

```sh
git clone --recurse-submodules https://github.com/Fr3nchyz/rifter.git
cd rifter
```

If you already cloned without submodules:

```sh
git submodule update --init --recursive
```

OpenRift lives in `upstream/openrift`. Its existing license and attribution are retained; see [upstream README](upstream/openrift/README.md) and [AGPL-3.0 license](upstream/openrift/LICENSE). Keep changes to upstream separate from the store adapter where practical.

## Run the existing local planner

Python 3.10+; no third-party dependencies or build step:

```sh
python -m riftbound.server
```

On your computer, open `http://127.0.0.1:8765`. Stop with Ctrl-C; use `--port 8766` if needed. This binds to loopback. A cloud loopback address is not a public preview.

The UI accepts pasted decks, Rifty `code,name,count` CSV, optional collection CSV and inventory CSV. Pasted quantities support `3 Card Name`, `3x Card Name`, and a single name per line. Use `[Deck name]` headings for separate decks and `{collector_number}` for a strict collector constraint. Collection CSV headers are `name,quantity,collector_number`. OpenRift's native CSV format is a planned adapter, not yet supported by this parser.

Choose shared cards (maximum count across decks) or separately built decks (sum). Owned and store copies are allocated once. Rifty source codes can use same-name reprints with an explicit review warning; pasted collector constraints remain strict. The UI chooses one printing per row; the report command below can split across printings. CSV export includes unresolved cards, source links and check times. Uploaded data stays in browser/server memory, not an automatic database. Durable collection tracking is the OpenRift integration milestone.

## Automatically fetch Game Keeper inventory

Store permission was confirmed for the retrieval used in this project. Only use `--store-permission` when you have that authorization:

```sh
python -m riftbound.fetch_store --store-permission --output .local/inventory.csv
```

The importer follows the actual Riftbound Singles category's next-page links, checks category identity, waits at least five seconds between requests, and caches pages for 15 minutes. A complete run currently traverses 66 pages / 1,563 records, taking about six minutes before retries. Check the report for the actual traversal result; those counts are not hardcoded.

HTTP 401/403, unexpected redirects and browser challenges stop the run. HTTP 429/503 honor Retry-After with bounded exponential backoff; connection retries are bounded. Parser errors and incomplete traversal do not publish a complete CSV. Fresh cache survives a failed run. Previous output files are not overwritten: use a new filename for a refresh. The importer does not log in, change a cart, place orders, impersonate allowed bots or bypass protections.

All rows retain original observation times and provenance. Missing numerical stock remains unknown; a failed request or missing listing never becomes zero stock. Stock changes during/after a multi-page run; this is not a reservation or transactional inventory snapshot. See [STORE_RESEARCH.md](STORE_RESEARCH.md) for observed markup, access history, format exceptions and limitations.

## Generate a deck-shopping report

Use Rifty-style headers `code,name,count`; `code` may be blank when only names are known. Optional `section` retains Legend, Champion, Battlefields, Main Deck, Rune Pool and Sideboard labels.

```sh
python -m riftbound.deck_report my-deck.csv .local/inventory.csv --printing-policy any-printing --output-dir .local/my-report
```

Open `shopping-report.html` in that folder. `shopping-summary.csv` includes every request and unresolved row; `shopping-printings.csv` details selected printing allocations. Existing output files are preserved. Full-name matched printing alternatives are reviewed explicitly; set prefixes are not guaranteed by category markup alone. Near-name suggestions are never allocated automatically.

The latest target is the user's Evelynn list: 38 entries / 66 requested copies including sideboard and runes; Main Deck 39 plus the separately listed champion 1. With no collection supplied, all requested copies are treated as needed. User-generated decks, inventories and shopping reports are kept in ignored `.local/`, not committed to Git. Refresh stock before relying on a previous result.

## Offline saved-page import

If needed, read browser-saved HTML without network access:

```sh
python -m riftbound.store_html page1.html page2.html --output .local/saved-inventory.csv
```

HTML is parsed as inert text; scripts, assets and forms do not execute. Capture time stays unknown unless you supply the actual known `--checked-at` ISO timestamp with timezone. The adjacent JSON report preserves coverage, warnings and observed next-page links. A partial snapshot does not establish that absent cards are out of stock. An empty manual template is in [examples/inventory-template.csv](examples/inventory-template.csv); fictional sample decks are clearly labeled.

## Validate

```sh
python -m unittest discover -s tests -v
```

30 tests pass for the existing tool, including a simulated 66-page traversal, cache/backoff/denial behavior, real saved-markup fixtures, quantity allocation, CSV parsing/export and API behavior. Playwright/Chromium checks also verified the previous real Rifty file with all 1,563 inventory rows, printing choices and CSV download. OpenRift-specific setup/integration checks are still planned. The newer section-preserving report and naming-difference suggestion are exercised against the supplied Evelynn list.

## Project files

- [PROJECT_PLAN.md](PROJECT_PLAN.md): milestones and acceptance criteria for local OpenRift and store integration.
- [STORE_RESEARCH.md](STORE_RESEARCH.md): actual site evidence and limitations.
- `riftbound/`: Python importer, planner, report generator and local server.
- `tests/`: automated checks and reduced public HTML fixtures.
- `upstream/openrift/`: pinned upstream app, with its own documentation and license.
- `.local/`: ignored user data, caches, generated reports and local browser artifacts.

Backup collection/database files before updates. No credentials belong in tracked files. OpenRift's PostgreSQL setup, local signup/email verification, canonical catalog matching, durable ownership and integrated shopping view are the next implementation steps; they are not claimed complete.
