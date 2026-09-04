# Lifeboat

Lifeboat keeps a static snapshot of a WordPress site in Cloudflare R2 and serves it from a Cloudflare Worker when the origin (GCP / Azure / AWS, or WordPress itself) is down.

This repository includes the complete path: the WordPress plugin builds and pushes snapshots, [`worker/`](worker/) performs origin-first edge failover, [`demo/`](demo/) proves the live-to-offline flow locally, and [`fleet/`](fleet/) compiles hostname routing for a large rollout.

```text
visitor ──> Worker ──> healthy WordPress origin
                 └──> R2 snapshot on timeout or 5xx

WP-CLI/plugin crawler ──> private origin ──> versioned R2 promotion
```

## What it does

- Enumerates URLs from WordPress internals (posts, pages, CPTs, terms, authors, archives, feed, sitemaps) and discovers the rest by crawling links.
- Fetches as an anonymous visitor through a separately configured **direct origin/loopback**, avoiding the public Worker; a fallback-header guard aborts a misrouted build.
- Uploads pages, assets and redirects to R2 under a versioned prefix; unchanged objects are **server-side copied** from the previous snapshot instead of re-uploaded (sha256 manifest diff).
- Writes `current.json` **last**, so the Worker never sees a half-built snapshot. A build that fails its sanity checks is never promoted — the previous snapshot stays live.
- Runs full rebuilds on a schedule (WP-CLI from system cron recommended) and **incremental updates** a couple of minutes after a post is published, updated, trashed or deleted.
- Keeps the last N snapshots and prunes the rest.
- Exposes `GET /wp-json/lifeboat/v1/health` for monitoring or a durable circuit-breaker integration.

Requirements: WordPress 6.2+, PHP 8.0+, pretty permalinks, an R2 bucket.

## End-to-end quickstart

The local demo requires Docker Compose, curl, and Node.js 22+ with npm. It uses stock MariaDB, WordPress, WP-CLI and `cloudflared` images, deploys the included Worker, creates sample content, promotes a snapshot, proves the healthy origin, stops WordPress, and proves the R2 fallback.

```sh
cp demo/.env.example demo/.env
# Fill in the Cloudflare Worker token and R2 S3 credentials; use bucket lifeboat-demo.
./demo/demo.sh
```

A successful run reports a live HTTP 200 with no `X-Lifeboat` header, then an offline HTTP 200 with `X-Lifeboat: <snapshot-id>`. WordPress is intentionally left stopped:

```sh
./demo/demo.sh restore   # return to the live origin
./demo/demo.sh cleanup   # remove containers, preserving local data
```

See [`demo/README.md`](demo/README.md) for credentials and lifecycle details. The random `trycloudflare.com` Quick Tunnel is development-only; production should use a stable, access-controlled origin address or named tunnel.

The demo disables incremental updates and plugin-managed WP-Cron scheduling, so its proof uses only immutable, versioned full promotions. Incremental refreshes remain available for normal installations.

## Live presentation dashboard

[`showcase/`](showcase/) adds a self-explanatory React control room for demos. It sends a public probe every 1.25 seconds, visualizes the active Visitor → Cloudflare → WordPress/R2 route, and displays the raw `HTTP`, `CF-Ray`, origin-health, and `X-Lifeboat` evidence behind every claim.

After the end-to-end demo has been provisioned once:

```sh
cd showcase
npm ci
LIFEBOAT_DOCKER_CONTEXT=desktop-linux npm run present
```

The outage switch is localhost-only and can start or stop only the demo's fixed `wordpress` service. The hosted audience view remains live but read-only. See [`showcase/README.md`](showcase/README.md) for the presentation script and security boundary.

## Install

1. Upload `lifeboat.zip` via Plugins → Add New → Upload, or copy the `lifeboat/` folder to `wp-content/plugins/`. Activate.
2. In Cloudflare, create an R2 bucket (e.g. `wp-lifeboat`) and an R2 API token with **Object Read & Write** scoped to that bucket. Note the account ID, access key ID and secret.
3. Add to `wp-config.php` (constants override the settings screen and keep secrets out of the database):

```php
define( 'LIFEBOAT_R2_ACCOUNT_ID',        '0123456789abcdef0123456789abcdef' );
define( 'LIFEBOAT_R2_BUCKET',            'wp-lifeboat' );
define( 'LIFEBOAT_R2_ACCESS_KEY_ID',     '...' );
define( 'LIFEBOAT_R2_SECRET_ACCESS_KEY', '...' );
define( 'LIFEBOAT_ORIGIN_URL',           'https://127.0.0.1' ); // loopback base — see below
// define( 'LIFEBOAT_PREFIX', 'sites/example.com' );          // default: sites/<host>
```

4. Verify: `wp lifeboat test-r2`, then `wp lifeboat urls` to see the seed list, then `wp lifeboat build`.
5. `wp lifeboat verify` reads `current.json` back and reports what the Worker would serve.
6. Deploy [`worker/`](worker/) with its `SNAPSHOTS` R2 binding pointed at the same bucket. Use `DEFAULT_HOST`/`DEFAULT_ORIGIN` for one site, or the `SITES` KV inventory below for a fleet, then attach the public hostname to the Worker.

## Loopback (LIFEBOAT_ORIGIN_URL)

The crawler must reach WordPress **directly**, not through Cloudflare — otherwise during an outage it would snapshot the fallback page (the plugin refuses to store any response carrying an `X-Lifeboat` header, but don't rely on that alone).

- `https://127.0.0.1` — requests go to the local web server with `Host: <your host>`; TLS verification is off by default for loopback. Use this on single-node setups.
- `https://origin.internal` / a load-balancer address — for multi-node setups. Turn on "Verify origin TLS certificate" if the cert is valid for that name.
- `http://127.0.0.1` — the plugin sends `X-Forwarded-Proto: https`; make sure wp-config honours it (`$_SERVER['HTTPS'] = 'on'` when `HTTP_X_FORWARDED_PROTO` is https), or every page will look like a redirect to https and be skipped.
- Basic-auth-protected origins: `https://user:pass@origin.internal`.
- If `WP_HTTP_BLOCK_EXTERNAL` is defined, add the origin host to `WP_ACCESSIBLE_HOSTS`.

"Test origin fetch" on the settings page shows exactly what the crawler gets for `/`.

## Scheduling

**Recommended:** disable HTTP-triggered WP-Cron and drive everything from system cron.

```php
define( 'DISABLE_WP_CRON', true );
```

```cron
# full rebuild every 6 hours (resumable; exits non-zero if the snapshot is not promoted)
0 */6 * * *  cd /var/www/html && wp lifeboat build --quiet >> /var/log/lifeboat.log 2>&1
# runs WP-Cron events, including debounced incremental updates after publishing
* * * * *    cd /var/www/html && wp cron event run --due-now --quiet
```

With this setup untick "Schedule full builds with WP-Cron" and set the time budget to 300+ (no PHP time limit under WP-CLI).

**Without WP-CLI:** leave "Schedule full builds with WP-Cron" ticked. Builds run in slices of the time budget (keep it at ~20 s when wp-cron.php is triggered over HTTP, below PHP's max_execution_time). A 10k-URL site takes a few hours this way; that's fine for a background failover, but WP-CLI is much faster.

Only one job runs at a time (DB-backed lock, safe across nodes). Job state lives in the `lifeboat_job` option, so a WP-Cron slice can continue on a different web node.

## Promotion rules

A full build is promoted only if:

- `index.html` (the home page) was captured as a page,
- `__404.html` was captured from a real HTML 404 response,
- no page upload failed,
- failed uploads are at or below "Max failed uploads (%)" (default 1%).

Otherwise `manifest.json` is written with `"promoted": false`, `current.json` is untouched and the admin shows an error notice. `wp lifeboat build` exits non-zero so your cron mailer/alerting sees it.

Alert on **staleness**, not just build failures: the dashboard warns when the live snapshot is older than 2× the schedule interval, and the health endpoint reports `snapshot.age_s`.

## Bucket layout (the Worker contract)

```
<prefix>/current.json                      pointer to the promoted snapshot — read this first
<prefix>/snapshots/<id>/manifest.json      all objects with sha256 / size / type / kind
<prefix>/snapshots/<id>/__404.html         the theme's 404 page (serve with status 404)
<prefix>/snapshots/<id>/<key>              the objects
```

`<prefix>` defaults to `sites/<host>`; one bucket serves any number of sites. `<id>` is `YYYYMMDD-HHMMSS` (UTC), so lexical order = chronological order.

`current.json`:

```json
{
  "snapshot_id": "20260901-140000",
  "prefix": "sites/example.com/snapshots/20260901-140000",
  "manifest": "sites/example.com/snapshots/20260901-140000/manifest.json",
  "host": "example.com",
  "updated_at": "2026-09-01T14:07:12+00:00",
  "counts": { "pages": 812, "assets": 1930, "redirects": 4, "bytes": 412331021 },
  "generator": "lifeboat/1.0.0"
}
```

Full builds create a new versioned prefix and atomically promote it by writing `current.json` last. Incremental updates instead mutate the current prefix in place, then rewrite `manifest.json` and `current.json` with the same `snapshot_id` and a new `updated_at`.

### Key mapping

The Worker maps the request to a key exactly like the plugin, using the **percent-decoded** path (`decodeURIComponent(url.pathname)`); query strings are ignored:

| Path            | Key                 |
|-----------------|---------------------|
| `/`             | `index.html`        |
| `/about/`       | `about/index.html`  |
| `/about`        | `about/index.html`  (no dot in the last segment) |
| `/feed/`        | `feed/index.html`   (Content-Type is stored as `application/rss+xml`) |
| `/wp-content/uploads/2026/08/a.jpg` | `wp-content/uploads/2026/08/a.jpg` |

Serve the object with its stored `Content-Type` (httpMetadata). On a miss, serve `__404.html` with status 404.

### Redirects

When an origin redirect resolves to a different snapshot key or another host, the plugin stores a small HTML fallback object with custom metadata `lifeboat-redirect` = the absolute target. The included Worker normalizes that stored redirect to `301 Location: <target>`. Same-key spelling variants such as `/about` and `/about/` share `about/index.html`, so Lifeboat does not persist a redundant trailing-slash redirect.

### Headers the Worker must honour

- The plugin crawler sends `X-Lifeboat-Crawl: <secret>`. The included Worker treats it as a bypass **only** when its `CRAWL_SECRET` binding is configured and the value matches exactly; an arbitrary or merely present header has no effect. This is only needed when a crawler cannot use a private origin. The per-site secret is generated on activation and can be read with `wp option get lifeboat_settings`.
- Responses served from the snapshot must carry `X-Lifeboat: <snapshot_id>`. The crawler aborts a build if it sees this header, which prevents snapshotting the snapshot.
- Health endpoint: `GET /wp-json/lifeboat/v1/health` returns 200 (`{"ok":true,...}`) or 503, with `Cache-Control: no-store`. `/wp-json/*` is pass-through in the Worker.

### Included Worker behaviour

- Exact-host routing comes from `DEFAULT_HOST`/`DEFAULT_ORIGIN` for the single-site demo or the optional `SITES` KV binding for a fleet. Unknown hosts fail closed with a read-only 503.
- The Worker fetches the origin with a 7 s default timeout. Status below 500 passes through unchanged, including real 404 responses. A 5xx, timeout, or transport error opens an isolate-local 30 s breaker and serves the promoted R2 snapshot.
- Non-GET/HEAD, `/wp-admin`, `/wp-login.php`, `/wp-json`, `/wp-cron.php`, logged-in requests, and an exactly authenticated crawler request may reach the origin but never receive a public snapshot; an outage returns the read-only 503 page with `Retry-After`.
- Snapshot HTML receives a saved-copy banner and disabled forms. Stored content metadata, HEAD requests, redirect metadata, and the captured 404 page are preserved.
- A `force_fallback: true` site record skips the origin for controlled drills. The repository does not install a Cron Trigger or durable health state by default.

## 100-site pattern

Use one Worker, one R2 bucket, and one `SITES` KV namespace rather than one edge deployment per site. Every canonical hostname gets an exact KV record with its stable origin and a unique `sites/<canonical-host>` prefix; each WordPress installation is configured for that prefix.

Validate the inventory, then install the pinned Worker dependencies and bootstrap its `SITES` KV binding as described in the fleet runbook:

```sh
cp fleet/sites.example.json fleet/sites.json
node fleet/sync-sites.mjs --inventory fleet/sites.json          # dry run
(cd worker && npm ci && npm run fleet:bootstrap-kv)              # one-time KV bootstrap
node fleet/sync-sites.mjs --inventory fleet/sites.json \
  --config worker/wrangler.jsonc \
  --wrangler worker/node_modules/.bin/wrangler --apply          # reviewed write
```

The dry run validates isolation and emits deterministic, staggered six-hour cron suggestions. `fleet:bootstrap-kv` is an explicit one-time Cloudflare mutation: Wrangler creates the namespace and writes its non-secret real ID into `worker/wrangler.jsonc`; no placeholder ID is committed. Provision plugin constants through each site's secret manager, keep crawler traffic on a private origin, and attach production routes only after snapshots and records exist. R2 S3 write authorization is bucket-scoped rather than prefix-scoped, so a shared bucket trades simplicity for a fleet-wide write blast radius; split separate trust boundaries across buckets and Worker deployments. See [`fleet/README.md`](fleet/README.md).

## WP-CLI

```
wp lifeboat build [--budget=<s>] [--fresh]     full snapshot (resumes if interrupted)
wp lifeboat incremental [--path=<a,b,c>]       apply pending publish changes, or refresh given paths
wp lifeboat status                             live snapshot, current job, last result, pending queue
wp lifeboat urls                               seed URL list
wp lifeboat verify                             read current.json back from R2
wp lifeboat test-r2                            write/read/delete a probe object
wp lifeboat prune [--keep=<n>]                 delete old snapshots
wp lifeboat cancel                             discard the in-progress job
```

## Hooks

- `lifeboat_seed_urls` (array $urls) — add/remove seed URLs.
- `lifeboat_post_types` (array $types) — post types to enumerate.
- `lifeboat_exclude_patterns` (array $patterns) — regexes (no delimiters) matched against decoded paths.
- `lifeboat_affected_urls` (array $urls, WP_Post $post) — URLs refreshed incrementally when a post changes.
- `lifeboat_fetch_args` (array $args, string $path) — WP HTTP args for crawler requests.
- `lifeboat_fetch_timeout`, `lifeboat_r2_timeout` (int seconds).
- `lifeboat_health_ok` (bool) — add your own checks to the health endpoint.
- Action `lifeboat_job_finished` (array $result) — send it to Slack/PagerDuty; `$result['ok']` is false when a build was not promoted.

## Limits and notes

- Query-string URLs are never snapshotted (search, `?p=`, `?replytocom=`…). The included Worker sends the full query to a healthy origin, then ignores it only when mapping a failed request to the static key.
- Assets larger than "Max object size" are skipped (bodies are held in memory; keep it below PHP's memory limit).
- Incremental runs refresh pages and fetch **new** assets only; theme/plugin asset changes are picked up by the next full build. Customizer, theme switch and menu changes schedule a full rebuild automatically.
- Objects in R2 are left in place on uninstall.
- Cost: R2 Class A ops on every full build ≈ number of changed objects + one copy per unchanged object; a 3,000-object site rebuilt 4×/day is well under $1/month.
