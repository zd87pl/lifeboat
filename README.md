# Lifeboat

WordPress plugin that keeps a static snapshot of your site in Cloudflare R2 so a Cloudflare Worker can serve it when the origin (GCP / Azure / AWS, or WordPress itself) is down.

The plugin only **builds and pushes** snapshots. Failover is decided at the edge by a Worker that reads the same bucket — the contract is documented below so the Worker can be written independently.

## What it does

- Enumerates URLs from WordPress internals (posts, pages, CPTs, terms, authors, archives, feed, sitemaps) and discovers the rest by crawling links.
- Fetches everything through a **loopback to the origin** (never through Cloudflare) as an anonymous visitor.
- Uploads pages, assets and redirects to R2 under a versioned prefix; unchanged objects are **server-side copied** from the previous snapshot instead of re-uploaded (sha256 manifest diff).
- Writes `current.json` **last**, so the Worker never sees a half-built snapshot. A build that fails its sanity checks is never promoted — the previous snapshot stays live.
- Runs full rebuilds on a schedule (WP-CLI from system cron recommended) and **incremental updates** a couple of minutes after a post is published, updated, trashed or deleted.
- Keeps the last N snapshots and prunes the rest.
- Exposes `GET /wp-json/lifeboat/v1/health` for the Worker's circuit-breaker probe.

Requirements: WordPress 6.2+, PHP 8.0+, pretty permalinks, an R2 bucket.

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

Incremental updates write into the current prefix in place and rewrite `manifest.json` and `current.json` (same `snapshot_id`, new `updated_at`).

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

The origin's redirects (e.g. old slugs, `/about` → `/about/`) are stored as small HTML meta-refresh objects with custom metadata `lifeboat-redirect` = absolute target. The Worker should return a `301 Location: <target>` when that metadata is present.

### Headers the Worker must honour

- Requests carrying `X-Lifeboat-Crawl: <secret>` come from the plugin's crawler (only relevant if the crawler is not on loopback). Pass them straight to the origin and never answer them from the snapshot. The secret is generated on activation and shown nowhere by default; read it with `wp option get lifeboat_settings`.
- Responses served from the snapshot must carry `X-Lifeboat: <snapshot_id>`. The crawler aborts a build if it sees this header, which prevents snapshotting the snapshot.
- Health probe: `GET /wp-json/lifeboat/v1/health` returns 200 (`{"ok":true,...}`) or 503, with `Cache-Control: no-store`. `/wp-json/*` is pass-through in the Worker.

### Recommended Worker behaviour (summary)

- Pass through: non-GET/HEAD, `/wp-admin`, `/wp-login.php`, `/wp-json`, `/wp-cron.php`, requests with a `wordpress_logged_in_*` cookie, and crawler requests. If the origin is down for these, answer 503 with a "site is read-only right now" page and `Retry-After`.
- Otherwise fetch the origin with a 5–8 s timeout. Status < 500 → pass through (real 404s stay 404). 5xx / 52x / 530 / timeout → serve from R2 with the mapping above, inject a small "showing a saved copy" banner via HTMLRewriter, disable forms.
- Circuit breaker: an isolate-local trip (~30 s) plus a 1-minute Cron Trigger that probes the health endpoint and writes `up`/`down` to KV; while `down`, skip the origin fetch entirely. A `force_fallback` KV flag makes drills trivial.

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

- Query-string URLs are never snapshotted (search, `?p=`, `?replytocom=`…); the Worker should treat them as pass-through or map them to the query-less key.
- Assets larger than "Max object size" are skipped (bodies are held in memory; keep it below PHP's memory limit).
- Incremental runs refresh pages and fetch **new** assets only; theme/plugin asset changes are picked up by the next full build. Customizer, theme switch and menu changes schedule a full rebuild automatically.
- Objects in R2 are left in place on uninstall.
- Cost: R2 Class A ops on every full build ≈ number of changed objects + one copy per unchanged object; a 3,000-object site rebuilt 4×/day is well under $1/month.
