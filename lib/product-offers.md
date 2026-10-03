# Product offers — task #1985, parent #1982

## Integration (parent-owned, required before deployment)

In health-api/server.js import `refreshDueProductOffers` from `./lib/product-offer-cache`.
Call `refreshDueProductOffers(getDB()).catch(() => console.error('[product-offers] refresh failed'))`
in BOTH the existing initial 30-second health scheduler callback and its 60-minute interval.
Do not create another timer, service, paid subscription, or external scheduling account.
The child branch deliberately does not edit server.js. Scheduling is NOT activated by this branch alone.

`GET /api/catalog/offers` is cache-only. `POST /api/catalog/offers/refresh` checks due entries;
it does not force a refresh within the 24-hour attempt TTL. Both use the existing catalog mount/auth.
Helper returns `deferred_cpu` (manual route 503) when load1 > 6 or sampled CPU steal >= 25%.
Sequential maximum 12 source fetches per run; each deadline 8 seconds including DNS and body;
2 MiB/page; single flight per database handle and a 120-second Mongo lease per catalog item.
`checked_at` is the last source observation, `last_attempt_at` the attempt; a failed repeat retains
the previous offer with its old timestamp and a stale/error state. Exact 24h boundary is stale.
Existing Mongo collection API creates `supplement_product_offers` on first refresh; deterministic
`_id = catalog:<id>` uses Mongo's built-in uniqueness, no migration/index command required.

## Identity and source contract

Exact `supplement_catalog.name` mappings cover GymBeam Omega 3 and GymBeam Vitamin D3 and point
to gymbeam.ua product pages verified by the parent. Prices are never constants in source code.
Variants are candidate packages to buy, NOT a claim about the owner's actual package.
All nested `AggregateOffer.offers` are considered independently. `lowPrice`, `highPrice`, reviews,
search snippets, and cheapest/first-variant heuristics are never accepted as an exact price.
Product.name must match expected identity; each offer needs an exact name, package and form.
Unidentified multi-variant pages (e.g. Applied Nutrition 91g/390g) remain unknown.

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

API: `node --test lib/product-offers.test.js lib/product-offer-cache.test.js lib/product-offer-routes.test.js`
UI: `npm test -- src/tests/Supplements --maxWorkers=1`; `npm run build`.
Browser: `node src/tests/SupplementsOffers.e2e.mjs` in health-dashboard, CHROME_BIN optional.
The browser smoke starts only a loopback server and intercepts all API traffic with fixtures;
it does not establish deployed-state correctness. Parent must run production smoke after merge/deploy.
Live read-only merchant probes returned 5 Omega 3 and 3 D3 exact variants on 2026-10-04 Kyiv.

## Scope not completed by this child

Parent scheduler hookup, merge/deploy, production authenticated smoke, independent provider QA.
Evidence validator/readiness are owned by another agent; cards expose existing evidence with an
unknown verification date when absent. Generic products and missing pack/form stay price-unknown.
