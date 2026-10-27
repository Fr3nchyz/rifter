# Game Keeper Verdun: investigation record

Observation date: October 26, 2026 (America/Toronto).

## Latest retry: connection succeeds, pages return 410

A later runtime check reported network state `unknown`. A fresh robots request successfully established the proxy CONNECT tunnel (HTTP 200), then returned HTTP/2 **410 Gone** with a 143-byte nginx/1.24.0 error page. A homepage request five seconds later returned the same status/body. This differs from the initial CONNECT 403: the tunnel now succeeds, but there is still no usable store content. It does not prove the domain is permanently gone or that a residential browser sees the same response. No category routes or inventory API were guessed.

The next diagnostic is to compare the exact public responses from the user’s own connection. Run `python tools/check_store.py` locally. It makes at most two sequential public GETs (robots, homepage), five seconds apart, does not follow redirects, and stops on access denial or throttling. It saves selected non-cookie headers and public response bodies under ignored `store-check/`. A successful homepage response or an observed browser redirect would give us actual links to inspect next. The script does not extract inventory or claim automation permission.

## Initial observation

Selected site: https://www.gamekeeperverdun.com/

The first, deliberately conservative request was a single HTTPS GET for `/robots.txt`, with TLS verification enabled and the environment's inherited outbound proxy:

```sh
curl -sS -D /tmp/gk-headers --max-time 30 https://www.gamekeeperverdun.com/robots.txt -o /tmp/gk-robots
```

Result: curl exit 56, `CONNECT tunnel failed, response 403`. Response headers included `HTTP/1.1 403 Forbidden`, `server: envoy`, and `connection: close`. No robots body was obtained. This was an **environment proxy policy denial**, not evidence that the store itself denied scraping or was down. The current enforced allowlist did not contain the store domains. The domains `www.gamekeeperverdun.com` and `gamekeeperverdun.com` were saved as additive custom entries in the environment configuration draft; runtime inspection afterward still showed the prior enforced policy. Saving a draft does not apply it.

No further store requests were made during that initial attempt; see the later retry above. We did not try alternate hosts, unofficial mirrors, browser impersonation, authentication, cart-based stock inference, or circumvent the proxy.

## Unverified questions

| Question | Result |
| --- | --- |
| Actual Riftbound Singles category URL and game identity/breadcrumbs | Not observed |
| Listing markup or embedded public data | Not observed |
| Product detail URL structure and variant identifiers | Not observed |
| Pagination links, page size, total pages | Not observed |
| CAD currency and whether displayed prices vary by condition/finish | Not observed |
| Numeric stock versus boolean availability | Not observed |
| Public API or supported inventory export | No API assumed; not investigated successfully |
| robots.txt, terms and permitted automation | Cannot establish from blocked request |

The URLs used in automated test fixtures are fictional local test data, not researched site routes. The production app does not depend on those URLs.

## Practical fallback now

Open the store in your normal browser. Navigate to the actual Riftbound Singles category, inspect the product's game/breadcrumb and exact printing, and copy only verifiable fields into the inventory template. Record the actual source links and check time. Leave numerical stock unknown if only “in stock” is displayed. If you cannot establish Riftbound membership, omit the inventory row and keep the deck card unresolved. You can also ask the store whether it offers a Riftbound inventory CSV/export with explicit variant, CAD price and numeric stock. The app can accept that export after mapping its headers and manually verifying game identity.

Local deck/collection calculations work even without inventory. The app makes zero network calls, so it has no remote cache, polling, retries, or rate load; imported CSV observations are the explicit reusable snapshots. It does not claim that zero calls constitute a live integration.

## Next investigation once access is permitted

1. Save the two domain additions in environment settings and retry the single robots request after runtime policy changes. Do not repeat the same blocked request in a loop. Investigate any new denial without bypassing it.
2. Read robots and publicly linked terms before crawling. If automation is disallowed or permissions unclear, keep manual import or ask the store for a supported export. A public HTTP response alone does not establish permission.
3. At most one request every five seconds, one request at a time: inspect home/category links, one actual Riftbound listing, one pagination link if present, and one product detail. Save fetched HTML with URL and fetch time locally to avoid repeat requests. Honor stricter published limits.
4. Identify game membership from actual category/breadcrumb data, not card name alone. Check exact collector numbers, purchasable variant identifiers, currency, condition, finish, displayed numeric inventory, and whether listing/detail fields agree. Follow observed pagination links only, with same-origin checks and cycle/page-count bounds. Do not guess API endpoints.
5. If permitted, implement an adapter backed by captured redacted fixtures. Cache catalog pages at least 24 hours and price/stock responses at least 15 minutes; display original observation time and stale status. No automatic refresh loop. Bound manual refresh batches and permit cancellation.
6. On 429 or 503, honor Retry-After; otherwise exponential backoff (at least 30, 60, 120 seconds), maximum three retries. Stop on 401/403 or a challenge. Network/parser errors must remain failed/unknown lookups; never replace them with zero stock or overwrite a good snapshot as if a failure were new inventory.
7. Validate a representative Riftbound printing, multiple versions, an unavailable item and pagination against the actual pages. If quantity is not publicly provided, expose stock as unknown/boolean and never invent numeric availability.

These are future investigation/adapter requirements, not claims of work already verified. Live integration remains incomplete until this evidence can be gathered.

## Subsequent successful public responses and robots restriction

At 00:27 UTC October 27 (October 26 Toronto), the Python diagnostic with an honest `RiftboundInventoryDiagnostic/0.1` user agent received HTTP 200 for robots.txt (197 bytes) and the homepage (507263 bytes). Earlier curl responses were 410; the cause of that difference is not established. Successful responses do not establish reliable access or permission to crawl.

The robots response says:

```text
User-agent: Googlebot
Disallow:
User-agent: Googlebot-Image
Disallow:
User-agent: AdsBot-Google
Disallow:
User-agent: *
Disallow: /
```

The initial diagnostic fetched the homepage before evaluating these directives. That sequencing was a mistake. The diagnostic now parses robots and stops before any homepage request when disallowed; no category/product crawl was made and no further live fetch is needed to test that fix (covered with a saved-policy test). We will not impersonate an allowed bot or change user agents to evade the restriction.

Inspection of the already retrieved homepage establishes:

- Platform metadata: `application-name` = `CrystalCommerce`.
- Actual category: `<li ... data-id="3953" data-name="Riftbound Singles">`, link **https://www.gamekeeperverdun.com/catalog/origins/3953**. Despite the `origins` URL slug, the homepage explicitly labels this category Riftbound Singles.
- The general search form includes text field `q` and category selector `c`, with `<option value="3953">Riftbound Singles</option>`. Its form method is GET; JavaScript affects the search UI and there is no explicit action in this captured form. A working scoped search endpoint/result has not been verified. Selecting Riftbound Singles in the normal site search is a useful browser experiment; it is not a proven API.
- Deckbuilder link: `/products/multi_search`; separate buylist link: `/buylist/multi_search`.
- Product markup on the homepage uses `li.product`, schema.org Product, product `a.link[itemprop=url]`, `h5.name[itemprop=name]`, and `span.price[itemprop=price]`. A featured **sealed Radiance box**, explicitly not a single, displays `CAD$ 199.99` and a product link under `/catalog/ccg_autres/.../661300`. This confirms only that the homepage displays CAD prices; it does not verify singles prices, conditions, finish, numeric stock, or pagination. This item must not enter a singles inventory.
- Public contact page: https://www.gamekeeperverdun.com/contact_us ; phone on homepage: (438) 381-1010.
- Terms link: `/conditions-utilisation`, not fetched.

Useful next input is a browser-saved HTML copy of the actual Riftbound category and one singles product page, preferably including the next-page link if present. Inspecting user-supplied saved public pages requires no crawler requests and can reveal whether the data needed is in the rendered markup. Alternatively, obtain an inventory export or explicit permission/supported integration from the store before an automated fetcher is developed. Do not request deck/collection CSVs to resolve this issue.

## User-supplied category snapshot: verified extraction

The user's ZIP attachment was successfully downloaded and inspected. It contained the 715603-byte saved category HTML plus a macOS metadata entry. Only the actual HTML was read; no attached scripts or website instructions were executed. Raw private/browser page content was not copied wholesale into the repository. A reduced public product-markup fixture supports regression tests.

Confirmed from this snapshot:

- Source comment: `https://www.gamekeeperverdun.com/catalog/origins/3953`; site settings identify category `3953`, `Riftbound Singles`, template `category_browse`, controller `products`, action `index`, and search path `/products/search`. The search path is metadata, not proof of a public inventory API.
- Actual category container: `.products-container.browse`, with **24** `li.product[data-catalog-id]` entries. Each has schema.org Product markup, a full product title and direct product URL. `data-catalog-id` is distinct from the path's product number and purchasable variant `data-vid`; do not conflate them.
- Three responsive views repeat variants: `.list-variants.grid`, `.list-variants.list`, and `.variants`. The importer reads the expanded `.variants .variant-row` and deduplicates `form[data-vid]`, preventing triple-counting. Forms are parsed as inert HTML only, never submitted.
- Each expanded row gives `variant-short-info`, e.g. `New, 4 En stock`, and `.regular.price` containing an explicit `CAD$` price. In this page all 24 rows have numeric counts and CAD prices. `0 En stock` means observed zero; missing/unparseable counts remain unknown. Quantity-selector `max` is not used as an inventory source.
- Abandon, collector `131/219`: regular listing CAD 0.99, 4 copies, condition `New`; foil CAD 5.99, 0 copies, condition `New`.
- Abandoned Hall, collector `205/219`: unmarked listing CAD 0.99, 4 copies; foil CAD 0.99, 2 copies. An unmarked finish is not assumed to mean Normal/Nonfoil.
- Full titles include collector numbers `066a/298`, `227*/221`, `SP3/006`, and print qualifiers such as Alternate Art, Overnumbered and Signature Overnumbered. Those strings and punctuation are preserved. Store prices, including unusually high showcase prices, are copied literally rather than “corrected”.
- Current page marker `1`; actual next URL `https://www.gamekeeperverdun.com/catalog/origins/3953?page=2&sort_by_price=0`. Links to pages 2–5 plus an ellipsis appear, so neither total pages nor total inventory is established. Page size is 24 in this snapshot only.
- Stock quick-filter URLs use `filter_by_stock=in-stock` and `filter_by_stock=out-of-stock`. The rendered “Afficher tout” link has two `?` characters: `?filter_by_stock=out-of-stock?filter_by_stock=in-stock`. This is a concrete malformed-link observation and could contribute to filtering problems; it does not prove the cause of reported crashes. No filter requests were sent.
- Metadata and markup establish game/category identity in this saved document, not live authenticity or current availability. No product-detail page was supplied, so consistency with details, multi-condition behavior and server-side response contracts remain unverified.

Result: 24 distinct purchasable variants extracted; 10 show positive stock, summing to 30 copies. Capture/check time is unknown because no reliable timestamp was present. Import time is recorded separately and never substituted. Generated CSV is `.local/riftbound-category.csv` and machine-readable report `.local/riftbound-category.report.json` (local generated artifacts). There are no unresolved parser warnings for this page.

Implementation: `python -m riftbound.store_html ... --output ...`, standard library only. Supports multiple user-saved pages, rejects wrong-game category metadata, untrusted product paths, conflicting duplicate variants and incomplete/error markup. Automated tests exercise captured real product snippets, layout deduplication, uncommon collector strings, unknown quantities and planning CSV roundtrip. No new store requests were made during this work. Further saved pages can extend coverage; permitted automatic refresh remains an external prerequisite.

## Authorized automatic retrieval

The user confirmed: **“Yes, I have permission”** in reply to the question asking whether Game Keeper Verdun granted permission to automatically retrieve its public inventory. That confirmation is the basis for the `--store-permission` run; the general robots rule is not being misrepresented as authorization or a technical protection bypass.

`riftbound.fetch_store` now performs bounded, read-only, category-only retrieval using the observed next links, an honest user agent, inherited HTTPS proxy/CA verification, sequential requests at least five seconds apart, a 15-minute content-checked cache, and per-page timestamps. There is no login, browser challenge evasion, cart submission or stock probing through cart behavior. Retry/backoff and stop conditions are documented in README.md. Progress files distinguish incomplete traversal from a complete output. Prior successful CSVs are never overwritten.

Live pagination uncovered additional real formats, which were diagnosed from cached responses: rune collector numbers without a denominator (`R04`, `R04a`); tokens without a collector number (`Buff - Token`); and out-of-stock product records without a form/variant ID. The latter retain explicit zero stock and an internal `unavailable-product-...` identifier, never an invented store variant ID. Some use `.price.no-stock` rather than `.regular.price`, now supported. Missing numeric stock remains unknown. Parser errors pause the traversal for inspection rather than silently dropping cards. Cached pages let the run resume without repeating fresh requests.

A real Playwright/Chromium smoke test of the local app succeeded: page load, sample input, three unresolved result rows, and enabled CSV export. The initial assertion that browser automation was unavailable was too broad: there is no dedicated browser tool, but Playwright and Chromium are installed and usable through shell execution.

The supplied Rifty CSV uses `code,name,count`: 82 entries and 156 copies, with 74 RAD rows, three OGN, three UNL, one SFD and one VEN. Counts are interpreted as requested shopping quantities because the user said the goal is completing this deck. No ownership subtraction is assumed. The shopping report flags that the store category exposes collector numbers but does not independently establish export set prefixes. Explicit full-name punctuation normalization and printing qualifiers are documented; collector disagreements are not silently accepted.

## Completed live run and target-deck result

The authorized run completed **66 pages and 1,563 distinct variant/product records**, following the observed next links until page 66 contained three products and no next link. Category data was checked between **October 26, 2026, 20:44:09 and 20:51:44 America/Toronto** (00:44–00:51 UTC October 27). This establishes traversal of that category's pagination at that time, not a transactional inventory snapshot or proof that every store product is assigned to that category. All 1,563 exported rows were accepted by the local inventory validator. Eleven parser warnings identify missing exposed variant IDs or retained unusual collector formats; no product was silently dropped. Repeated layout copies were not counted as extra stock.

With the user's confirmed preference **“Any valid printing; cheapest available”**, the Rifty report finds **26 candidate copies out of 156**, **130 unfilled**, and **CAD 109.37** subtotal for the available selected copies, before tax/shipping. Seven requested entries are covered by candidate quantities, two have insufficient stock, one has observed zero stock, and 72 have no full-name match in the traversed category (71 non-rune RAD entries plus VEN-106 Wind and Ghosts). No listing is not interpreted as zero stock. The standard and showcase/foil rune alternatives dominate the cost; the report exposes printings, quantities and prices rather than hiding that tradeoff. Source set prefixes remain flagged unless independently checked.

The any-printing result is `.local/deck-completion-any-printing/shopping-report.html`, with `shopping-summary.csv` (all 82 target entries) and `shopping-printings.csv` (selected allocations). The more collector-constrained comparison is `.local/deck-completion/`; it is not an exact-set guarantee. Full fetched inventory: `.local/store-inventory-live.csv`, with `.report.json` and `.progress.json`. Allocation verification confirmed no variant was over-allocated and each line uses the fetched decimal price.

One representative direct product detail request, Pakaa Cub (`/catalog/origins/pakaa_cub__135298__common/652674`), succeeded with TLS verification at 20:54:11 Toronto. It independently exposes `Card Name: Pakaa Cub`, `Card Number: 135/298`, `Finish: Regular`, `Set Name: Origins`, `New, 4 en stock`, and `CAD$ 0.99`, consistent with the category snapshot. Product-detail coverage is representative, not exhaustive. The browser's separate remote-page attempt encountered certificate trust failure and was stopped without disabling TLS checks; the Python HTTP retrieval uses the environment's configured trust and succeeded. Chromium tests of local application behavior are independent of that remote-browser trust limitation.

Final validation: **30 automated tests passed**; Playwright/Chromium imported the actual Rifty CSV and all 1,563 fetched inventory rows, rendered 82 requests totaling 156 copies, and downloaded a reviewed CSV. The generated shopping report also rendered all 82 entries in Chromium over a temporary local HTTP server. Earlier test-harness attempts using eval under CSP and file URLs were corrected to use locator assertions and the supported local HTTP workflow; application security settings were not relaxed. No orders, cart additions, login, or protective-control bypass occurred.
