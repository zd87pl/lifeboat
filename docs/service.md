# Running Lifeboat as a service

In service mode one operator runs the edge — a Worker, an R2 bucket and a
`SITES` KV namespace — for many WordPress sites. A site owner installs the
plugin and adds three constants; they never hold Cloudflare or bucket
credentials, and their key can write only their own site's snapshots.

```text
                 operator's Cloudflare account
              ┌──────────────────────────────────────────────┐
visitor ──────┼─> Worker (custom hostname via Cloudflare for SaaS)
              │      ├─ edge: R2 snapshot  (+ per-colo cache)  │
              │      └─ dynamic / miss / outage logic ─────────┼──> customer's WordPress origin
              │                                                │        (X-Forwarded-Host, X-Lifeboat-Edge)
WordPress ────┼─> Worker on INGEST_HOST (per-site key) ──> R2: sites/<host>/…
  plugin      │   SITES KV: routing, policy, key hash          │
              │   Analytics Engine: one data point per request │
              └──────────────────────────────────────────────┘
```

## Onboarding a site

1. **Credentials.** `node fleet/site-key.mjs` prints a `siteKey` (for the
   customer only), its `siteKeySha256` (for the inventory) and an `edgeSecret`.
   The service stores only the hash, so neither the inventory nor KV holds a
   usable key.
2. **Inventory.** Add the site to `fleet/sites.json` and its edge secret to a
   separate, unversioned secrets file:

   ```json
   { "canonicalHost": "example.com", "origin": "https://origin.example.com",
     "aliases": ["www.example.com"], "mode": "edge", "ai": "edge",
     "ingestKeySha256": "<siteKeySha256>" }
   ```

   ```json
   { "example.com": { "edgeSecret": "<edgeSecret>" } }
   ```

   Review the dry run, then apply:
   `node fleet/sync-sites.mjs --inventory fleet/sites.json --secrets secrets.json --apply …`
   (see [`fleet/README.md`](../fleet/README.md)).
3. **Origin address.** The Worker must reach WordPress on an address that is
   *not* routed back through the Worker, for example a DNS-only
   `origin.example.com` or the host's own temporary hostname, over HTTPS. The
   plugin accepts the forwarded public hostname, so WordPress needs no
   configuration for this.
4. **Customer setup.** The customer adds to `wp-config.php`:

   ```php
   define( 'LIFEBOAT_SERVICE_URL', 'https://ingest.your-service.example' );
   define( 'LIFEBOAT_SERVICE_KEY', '<siteKey>' );
   define( 'LIFEBOAT_EDGE_SECRET', '<edgeSecret>' );
   define( 'LIFEBOAT_ORIGIN_URL', 'https://127.0.0.1' ); // or another private crawl address
   ```

   then runs `wp lifeboat test-storage` (it reports the prefix and the policies
   the service holds) and `wp lifeboat build`, or uses the buttons under
   Settings → Lifeboat.
5. **Hostname.** With Cloudflare for SaaS, add the customer's hostname as a
   custom hostname on the service zone, route `*/*` on that zone to the Worker,
   and have the customer point a CNAME at the service. Apex domains need CNAME
   flattening at the customer's DNS provider, because apex proxying is an
   Enterprise add-on. Cut DNS over only after the first snapshot is promoted;
   until then edge mode passes everything through to the origin anyway.
6. **Verify.** A known page answers with `X-Lifeboat-Route: edge`; `/wp-json/`
   answers without `X-Lifeboat`; a `force_fallback: true` drill on the record
   shows the saved-copy banner.

## Ingest API

Served only on `INGEST_HOST`. Every request carries
`X-Lifeboat-Site: <canonical host>` and `Authorization: Bearer <site key>`.
Keys are absolute bucket keys and must lie under the site's prefix
(`sites/<host>/` unless the record sets `prefix`).

| Method and path | Purpose |
|---|---|
| `GET /v1/site` | `{ host, prefix, mode, ai }` as the service holds them |
| `GET /v1/object?key=…` | object body with its content type (`HEAD`: 200 or 404) |
| `PUT /v1/object?key=…` | upload; `Content-Length` required (`INGEST_MAX_BYTES`, default 100 MiB); `Content-Type`, optional `Cache-Control`, optional `X-Lifeboat-Metadata` (JSON object of ASCII strings) |
| `DELETE /v1/object?key=…` | delete (idempotent) |
| `POST /v1/copy` `{ "from", "to" }` | copy inside the bucket, metadata included |
| `GET /v1/list?prefix=…&delimiter=/&cursor=…&limit=…` | `{ keys: [{ key, size, etag }], prefixes, next }` |
| `POST /v1/delete` `{ "keys": [...] }` | delete 1–1000 keys; refused entirely if any key is outside the prefix |

Errors are JSON `{ "error": "…" }`: 400 malformed, 401 unknown site or wrong
key (one message for every case, so the endpoint does not reveal which hosts
exist), 403 key outside the prefix, 404, 405, 411, 413.

## Isolation guarantees

- A key authenticates exactly one canonical site. Alias records, sites without
  `ingestKeySha256` and the `workers.dev` bootstrap host can never ingest.
- Every key a request names is confined to that site's prefix, without empty,
  `.` or `..` segments or control characters. The fleet compiler refuses
  prefixes that nest inside one another, so no site's prefix contains another's.
- The edge validates every promoted pointer: `current.json` must name the
  site's own host and its own `<prefix>/snapshots/<id>`, so even a site that
  writes a malicious pointer cannot make the edge serve another site's objects.
- Keys are compared by SHA-256 digest in constant time; only the digest is
  stored.

Rotation today means replacing `ingestKeySha256` and the customer's
`LIFEBOAT_SERVICE_KEY` together; accepting two hashes during a rotation window
is an obvious next step.

## Metering

Add an Analytics Engine dataset to the Worker:

```jsonc
"analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "lifeboat_requests" }]
```

Each site request writes one data point: index `host`; `blob1` host, `blob2`
route (`edge`, `origin`, `fallback`, `readonly`, `blocked`, `redirect`),
`blob3` `visitor` or `ai`, `blob4` HTTP status; `double1` = 1. Monthly usage
per site and route, accounting for sampling:

```sql
SELECT blob1 AS host, blob2 AS route, blob3 AS client, SUM(_sample_interval) AS requests
FROM lifeboat_requests
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY host, route, client
ORDER BY host, requests DESC
```

`edge` plus `blocked` divided by the total is the share of traffic WordPress
never saw — the number customers care about — and the `ai` rows show how much
of it was crawlers.

## Resilience notes

- `SITES` records are memoized per isolate for 60 s and read with a KV
  `cacheTtl`; during a KV incident the last record each isolate saw keeps
  serving. A host an isolate has never resolved still fails closed.
- The snapshot pointer is memoized for 5 s; during an R2 incident the last
  pointer keeps edge-cached objects serving, and edge mode passes requests the
  cache cannot answer to the origin.
- Cloudflare itself remains a dependency. Sell this as protection against
  origin and host outages, not as uptime independent of Cloudflare.

## Not built yet

A commercial service also needs pieces this repository does not contain:
sign-up, billing and a customer dashboard (the metering above is the data
source); automated custom-hostname provisioning through the Cloudflare for
SaaS API; a scheduled origin health monitor with durable state, so outage
labelling does not depend on each isolate seeing a failure; rate limits on the
ingest API; key rotation with overlapping keys; and a purge endpoint for
removing a page from the edge immediately.
