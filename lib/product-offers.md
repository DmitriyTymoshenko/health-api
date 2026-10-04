# Product offers — task #1985, parent #1982

## Integration (live)

The existing server.js health scheduler calls refreshDueProductOffers after the initial
30 seconds and every 60 minutes. This is already enabled in production; no new timer,
paid API, subscription, or account is used. GET never fetches merchant pages.

`GET /api/catalog/offers` is cache-only. `POST /api/catalog/offers/refresh` checks due entries;
it does not force a refresh within the 24-hour attempt TTL. Both use the existing catalog mount/auth.
Helper returns `deferred_cpu` (manual route 503) when load1 > 6 or sampled CPU steal >= 25%.
Active catalog entries only; archived records remain stored and excluded from purchase responses.
Sequential maximum 12 source fetches per run; a complete item reserves its required requests
before acquiring a lease. Items that cannot fit are skipped without changing last_attempt_at.
On the next tick, already attempted items are TTL-cached so skipped items get a fair turn.
No partial-item clock reset or repeated successful-source fetch storm; each deadline 8 seconds including DNS and body;
2 MiB/page; single flight per database handle and a 120-second Mongo lease per catalog item.
`checked_at` is the last source observation, `last_attempt_at` the attempt; a failed repeat retains
the previous offer with its old timestamp and a stale/error state. Exact 24h boundary is stale.
Existing Mongo collection API creates `supplement_product_offers` on first refresh; deterministic
`_id = catalog:<id>` uses Mongo's built-in uniqueness, no migration/index command required.

## Identity and source contract

Eight mappings cover 8 of 11 active catalog entries (15 total, 4 archived): GymBeam D3,
GymBeam Omega 3, Nutrend Ashwagandha, Nutrend Isodrinx Tabs, VPLab ZMA, Applied Nutrition
Amino Fuel EAA, and explicitly labelled GymBeam purchase candidates for generic Beta-Alanine
and Vitamin C 500mg. The latter two do not establish the owner's brand. All package variants
remain purchase candidates and never change regimen, dose, or stock.
Firsthand JSON-LD probes on 2026-10-04 validated all eight sources with current prices.
Six sources publish UAH, VPLab EUR and Applied Nutrition GBP; no conversion is fabricated. Prices are never constants in source code.
Variants are candidate packages to buy, NOT a claim about the owner's actual package.
All nested `AggregateOffer.offers` are considered independently. `lowPrice`, `highPrice`, reviews,
search snippets, and cheapest/first-variant heuristics are never accepted as an exact price.
Product.name must match expected identity; each offer needs an exact name, package and form.
Applied Nutrition Shopify variants join data-only metadata by handle, variant ID, SKU and
price consistency. This distinguishes 91g from 390g without choosing cheapest or first.
Single-package VPLab requires exact SKU and package text in Product.description. Nutrend
requires matching WooCommerce product ID with every variant sharing the curated package.
Missing or inconsistent package proof fails closed. Prices come only from JSON-LD Offer,
including merchant-published rounding; checkout prices may differ.

Additional curated mappings may be provided through the existing supplement_knowledge update flow:
`product_sources: [{url, product_name, sku?, pack?, form?}]` (maximum 3/item).
Use the exact merchant Product.name; sku/pack narrow to an explicitly chosen variant. form is a
curated label for non-capsule/tablet products; do not infer a form from the owner's daily dose.
No arbitrary URL input is accepted by the refresh endpoint. Existing `purchase_url` remains a
source link but alone cannot establish exact identity. All HTTP requests and parsed offer URLs
must use the code allowlist, HTTPS, no credentials/nonstandard ports/search URLs. Offer links
must also use the same origin and pathname as the fetched source. Redirects are rejected.
DNS resolves IPv4 only, rejects nonpublic answers, then pins the checked address for the TLS
connection; IPv6 is deliberately unsupported. No browser scripts from merchant pages execute.

Native UAH prices have `price_uah`; other currencies remain original with null `price_uah`.
No exchange rate, delivery fee, availability, or medical benefit is invented. A verified-source
link means the structured offer was parsed from that page; it is not a merchant endorsement.

## Validation

API: `npm test -- --runInBand product-offer` (included in standard Jest and deployment gates; #1991)
UI: `npm test -- src/tests/Supplements --maxWorkers=1`; `npm run build`.
Browser: `node src/tests/SupplementsOffers.e2e.mjs` in health-dashboard, CHROME_BIN optional.
The browser smoke starts only a loopback server and intercepts all API traffic with fixtures;
it does not establish deployed-state correctness. Parent must run production smoke after merge/deploy.
Live read-only merchant probes returned 5 Omega 3 and 3 D3 exact variants on 2026-10-04 Kyiv.

## Remaining unknowns and verification

Three active entries remain unknown: NOW Psyllium (official source denied public fetch;
a Ukrainian merchant requires separately reviewed allowlist/identity integration), Amix
Creatine HCl (no integrated exact-package proof), and Immune Labs Lion's Mane (no integrated
firsthand structured exact-package offer). No brand or price is substituted for these.

#1991 migrated existing helper tests into standard Jest src/tests. #1992 adds its own
product-coverage-1992.test.ts with saved firsthand fixtures, variant mismatch/fail-closed
checks, active filtering and fair bounded retry tests. Independent Max Opus QA and actual
post-deploy observations are recorded in task #1992; this document is not itself a QA verdict.
Evidence validator/readiness remain owned by another agent.
