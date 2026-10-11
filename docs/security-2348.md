# Dependency investigation #2348

Verified 2026-10-11. Baseline: health-api `657869a`. Evidence in the parent
repository `data/2348/`; npm registry metadata and upstream security advisories
were checked the same day. This change ships only the qs minor override.

## Production reachability and result

Express 4.22.1 resolves qs 6.14.2 for its default extended query parser; body-parser
already resolves 6.16.0. The actual exported server's requests were traced in
`scripts/probe-parsing-2348.js`, without connecting Mongo or starting service jobs.
Nested filters, arrays, Unicode, zero and empty strings preserve their values.
Express supplies `allowPrototypes: true`, but not `comma: true`. The application
uses JSON body parsing and has no URL-encoded body middleware.

The hostile constructor shape reaches the query parser. The upstream
parse-to-stringify TypeError is reproducible in a hypothetical round-trip outside
the application, and stops reproducing after qs 6.16.0. Source inventory found no
application qs.stringify sink. This proves parser reachability and the library
defect, not a remotely exploitable application crash. Production /health with the
hostile query stays 200 before and after. No malicious heavy payload was sent to
production.

References:
- https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g
- https://github.com/ljharb/qs/security/advisories/GHSA-x5fp-wj9c-mxmx
- https://github.com/ljharb/qs/security/advisories/GHSA-q8mj-m7cp-5q26

The pinned override qs=6.16.0 retains the same major version and deduplicates the
already-patched body-parser copy. It exceeds Express's declared ~6.14.0 range;
the real parser probe, regression cases and full suite are the compatibility
evidence. No Express settings or application routes change.

## Remaining development chain and separate major plan

Full audit: 21 -> 20 moderate; production audit: 1 -> 0. Critical/high stay zero.
The 20 reports are a propagated dependency chain, not 20 proven exploits:
Jest -> babel-plugin-istanbul -> @istanbuljs/load-nyc-config 1.1.0 -> js-yaml
3.15.2 -> argparse 1.0.10 -> sprintf-js 1.0.3. sprintf-js's current registry
release 1.1.3 is also affected, so a minor formatter override is not a fix.
The actual server does not load sprintf-js. Dev tooling can load YAML config;
argparse formats CLI help/errors. Runtime exposure through health-api is not
established; this does not claim the dependency is harmless.

References:
- https://github.com/alexei/sprintf.js/issues/237
- https://github.com/advisories/GHSA-hp3w-g68c-fv3c
- https://github.com/istanbuljs/load-nyc-config/blob/master/index.js
- https://github.com/nodeca/js-yaml/releases/tag/4.3.2

Separate candidate: narrowly override @istanbuljs/load-nyc-config's js-yaml to
4.3.2, which uses argparse 2.0.1 without sprintf-js. The isolated real
loadNycConfig YAML fixture yields the same output as v3 and its small dependency
tree audits clean. An initial 4.3.0 candidate introduced two high audit entries
and was rejected; 4.3.2 addresses those advisories. This candidate is NOT shipped
in #2348: it changes a transitive major and one fixture is not full compatibility
proof. No Jest/ts-jest downgrade and no npm --force.

Execution plan for that separate major change:
1. Re-measure the current dependency tree and audit; verify no competing task.
2. Add the scoped js-yaml override in an isolated worktree, retaining qs 6.16.0.
3. Check every installed load-nyc-config YAML/API consumer and repo YAML config;
   test extends, anchors, malformed YAML and relevant scalar/schema differences.
4. npm ci --include=dev, full/prod audits, build and full Jest suite including
   coverage execution through the real Istanbul transform; all must pass.
5. Land and deploy through standard scripts, then public authenticated smoke and
   independent other-provider QA. Reject on audit regression or changed config
   behavior. No production data or secret changes are needed.

Risk: transitive-major override exceeds ^3.13.1 and v3/v4 YAML semantics differ;
remaining uncertainty is full toolchain/coverage compatibility. Effort is not
measured yet; no cost or completion-time claim is made.

## Rollback

For the qs change, revert its health-api commit and land the reverting branch
with the parent gitlink update, run npm ci --include=dev, build/test, restart via
absolute ops-restart.sh health-api --task 2348, then repeat public smoke. Restore
the package.json/package-lock.json blobs from 657869a if an explicit baseline
rollback is required; do not reset the live tree or overwrite unrelated later
commits. That baseline retains the critical fixes but reintroduces the known qs
moderate. For the future dev-major change, revert only its scoped override/lock
delta to keep the qs patch; 657869a remains the requested emergency reference.
