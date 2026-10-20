# Local end-to-end test

`run.sh` proves the whole edge-mode path on one machine, without a Cloudflare
account or Docker:

```sh
./e2e/run.sh                 # about a minute after the first download
./e2e/run.sh --keep-running  # leave the servers up for manual poking
```

It needs PHP 8.0+ with `pdo_sqlite`, Node.js 22+ with npm, curl, tar, unzip
and setsid. WordPress (latest, checked against its published SHA-1), the SQLite
Database Integration plugin and WP-CLI (checked against its SHA-512) are cached
in `e2e/.cache`. Each run starts from an empty `e2e/.work`, which keeps the
logs afterwards.

## What runs

| Piece | How |
|---|---|
| WordPress origin | PHP's built-in server on `127.0.0.1:18080` with [`router.php`](router.php), SQLite instead of MySQL, `WP_HOME` = `http://lifeboat.localhost:18787` |
| Edge | the repository's Worker under `wrangler dev` on `127.0.0.1:18787` (workerd, local R2), `DEFAULT_MODE=edge`, `DEFAULT_AI=edge` |
| Ingest | the same Worker with `INGEST_HOST=127.0.0.1`; the plugin knows only `LIFEBOAT_SERVICE_URL` and its own `LIFEBOAT_SERVICE_KEY` |
| Fixture | [`fixtures.php`](fixtures.php) makes one page send `nocache_headers()`, as WooCommerce does for cart and checkout |

The site key, its SHA-256 and the edge secret are generated per run with
[`fleet/site-key.mjs`](../fleet/site-key.mjs). Origin traffic is counted from a
log the router writes for every request, because PHP's server stops logging
script requests once a router is in use.

## What it checks

- Plugin internals inside WordPress ([`checks.php`](checks.php)): cache-intent
  detection, link extraction, service URL validation, forwarded-request trust,
  both storage clients against intercepted HTTP, and PHP/Worker key-mapping
  parity.
- Publishing: `test-storage` (and the `test-r2` alias), a full build through
  the ingest API with exactly the fixture page marked private, `verify`, a
  second build that copies unchanged objects inside storage, and `prune`.
- Tenant isolation: a wrong key gets 401; the site's key cannot write another
  site's prefix.
- Edge serving: pages, campaign-tagged URLs and versioned assets come from the
  snapshot with no origin request; `If-None-Match` gets 304.
- Dynamic routing: search, the REST API and the no-store page reach WordPress
  exactly once each; a comment POST records the visitor IP forwarded by the
  verified edge; approving it refreshes the edge copy; logging in through the
  edge works and logged-in views are live.
- AI crawlers: GPTBot reads from the edge, its add-to-cart crawl trap gets the
  snapshot 404 and the REST API a 403, with no origin traffic.
- Outage: with WordPress stopped, edge pages still serve, then carry the
  saved-copy banner and disabled forms with `Cache-Control: no-store`; dynamic
  pages fall back to their snapshot path; comment POSTs and the REST API get
  the read-only 503; unknown URLs get the captured 404.
- No PHP warnings, notices or deprecations from the plugin (`WP_DEBUG_LOG`).

Set `LIFEBOAT_E2E_PHP=/path/to/php8.1` to run the same checks on another PHP
version. Ports and the cache directory can be changed with
`LIFEBOAT_E2E_ORIGIN_PORT`, `LIFEBOAT_E2E_EDGE_PORT` and `LIFEBOAT_E2E_CACHE`.
