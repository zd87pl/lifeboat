# Fleet inventory

One Worker, R2 bucket, and `SITES` KV namespace can front a large fleet. Keep the
hostname-to-origin mapping in one reviewed JSON file instead of deploying a
Worker per WordPress site.

This is the production pattern; the random Quick Tunnel used by the local demo
is development-only. Fleet origins must be stable HTTPS addresses or named,
access-controlled tunnels that Cloudflare can reach.

Start with the example:

```sh
cp fleet/sites.example.json fleet/sites.json
node fleet/sync-sites.mjs --inventory fleet/sites.json
```

The second command is always a dry run unless `--apply` is present. Its JSON
output contains the exact KV records and a deterministic, staggered six-hour
cron suggestion for every canonical site. With at most 360 sites, suggestions
occupy distinct minute slots; larger fleets are spread as evenly as possible.
Aliases do not get duplicate build jobs.

For an initial 100-site rollout:

1. Configure one copy of [`../worker/`](../worker/) with the shared R2 bucket
   and a `SITES` KV namespace, but do not attach production routes yet.
2. Put every canonical host, stable origin, optional alias, and unique snapshot
   prefix in one inventory; validate it without `--apply`.
3. Install Lifeboat on each WordPress origin, inject its R2 credentials and
   matching `LIFEBOAT_PREFIX`, and keep `LIFEBOAT_ORIGIN_URL` private/direct.
4. Build the canary snapshot, apply the reviewed inventory, deploy the Worker,
   attach only the canary route, and prove it end to end.
5. For every remaining batch, build and verify every site before attaching that
   batch's Worker Routes or Custom Domains. Roll out the emitted staggered
   schedules, alert on build failures and snapshot age, and regularly exercise
   the canary's live-to-fallback path.

## Inventory contract

```json
{
  "version": 1,
  "sites": [
    {
      "canonicalHost": "example.com",
      "origin": "https://wp-origin.example.net",
      "prefix": "sites/example.com",
      "aliases": ["www.example.com"]
    }
  ]
}
```

- `canonicalHost` is required, lowercase, and globally unique. Alias names are
  also lowercase and cannot overlap any other canonical name or alias. It must
  exactly equal the hostname in that WordPress site's `home_url()`; the Worker
  validates the promoted `current.json.host` and fails closed on a mismatch.
- `origin` is required and must be an origin-only HTTPS URL: no path, query,
  fragment, or embedded credentials. For a local-only inventory, the explicit
  `--development` flag also permits HTTP. A remote Worker cannot reach
  `localhost`; use a deliberately exposed development tunnel or a routable
  staging origin. Never use an ephemeral Quick Tunnel as a production origin.
  This is the Worker's edge origin and must bypass any route that sends it back
  through the same Worker. It may differ from the plugin's private
  `LIFEBOAT_ORIGIN_URL` crawl address.
- `prefix` is optional and defaults to `sites/<canonicalHost>`. Prefixes must be
  unique so two sites cannot overwrite one another's snapshots. The plugin's
  `LIFEBOAT_PREFIX`, this value, and the Worker's R2 bucket binding must describe
  the same bucket/key location or fallback fails closed.
- `aliases` is optional. Each alias gets its own KV record with `canonicalHost`
  and the canonical site's origin and prefix. The Worker can therefore serve the
  same snapshot on both names. The compiler does not turn aliases into HTTP
  redirects. If aliases should redirect for SEO, use a Cloudflare Redirect Rule
  to send them to the canonical hostname.

Origin redirects captured by the plugin are a separate feature: when source and
target map to different snapshot keys, fallback returns a 301 `Location` with
`X-Lifeboat`. Trailing-slash variants map to the same object key and are not
preserved as redundant redirects.

All generated records set `force_fallback` to `false`, so applying the inventory
also ends any active failover drill for the listed hosts.

## Bootstrap the shared edge resources

Run these commands from the repository root. Ensure the R2 `bucket_name` in
`worker/wrangler.jsonc` names the shared production bucket, then create and bind
one KV namespace. The pinned local Wrangler can update the JSONC config with
the returned namespace ID:

```sh
cd worker
npm ci
npm run fleet:bootstrap-kv
cd ..
```

The bootstrap script is the one mutating step in this section: it creates the
remote namespace and asks the pinned Wrangler to add its real ID to
`worker/wrangler.jsonc`. Do this once, review the resulting `kv_namespaces`
entry, and commit the non-secret namespace ID through the normal configuration
review. Do not put R2 S3 keys or the Cloudflare API token in `wrangler.jsonc`.

The base Worker config deliberately omits `SITES`, so the local single-site
demo needs no dummy namespace. After bootstrap, the optional binding does not
complicate that demo: a KV miss still falls through to its exact
`DEFAULT_HOST`/`DEFAULT_ORIGIN` configuration.

## Apply to Cloudflare

Authenticate Wrangler, review the dry-run output, then opt into the remote
write using the pinned executable installed above:

```sh
node fleet/sync-sites.mjs \
  --inventory fleet/sites.json \
  --config worker/wrangler.jsonc \
  --wrangler worker/node_modules/.bin/wrangler \
  --apply
```

The apply path creates a mode-`0600` temporary Wrangler bulk file, runs
`wrangler kv bulk put ... --binding SITES --remote`, and removes the temporary
file. Use `--wrangler /path/to/wrangler` when it is not on `PATH`, or
`--binding NAME` if the Worker uses another binding.

Bulk put only upserts the inventory's current keys; it intentionally does not
delete unlisted KV keys. Remove retired hosts in a separate, reviewed operation
so a typo or partial inventory cannot take unrelated sites offline.

Applying the inventory writes `force_fallback: false` for every listed host. A
controlled drill can temporarily set that field to `true` in one exact canary
record so the Worker skips its origin; reapplying the reviewed inventory ends
the drill.

After the KV records exist, deploy the shared Worker and attach each public
hostname with Cloudflare Worker Routes or Custom Domains:

```sh
cd worker
npx wrangler deploy
```

Keep route/DNS changes as the final cutover step. Before a hostname reaches the
Worker, its snapshot, exact KV record, and stable origin should already exist.

## Roll out the WordPress side

For the simplest large-fleet profile, use immutable full promotions only. After
activating the plugin, preserve its generated crawler secret while disabling
incremental hooks and plugin-managed WP-Cron scheduling:

```sh
wp lifeboat status
# Finish or intentionally cancel any current snapshot job before changing mode.
wp eval '$s = get_option( "lifeboat_settings", array() ); $s["incremental"] = 0; $s["use_wp_cron"] = 0; $s["schedule_hours"] = 0; update_option( "lifeboat_settings", $s ); foreach ( array( "lifeboat_scheduled_build", "lifeboat_full_rebuild", "lifeboat_run_job", "lifeboat_incremental" ) as $hook ) { wp_clear_scheduled_hook( $hook ); } delete_option( "lifeboat_pending" );'
```

Join each emitted cron expression to that site's deployment metadata. For
example, if the plan contains `17 2-23/6 * * *`, install only the resumable full
build:

```cron
17 2-23/6 * * * cd /var/www/example.com/current && wp lifeboat build --quiet >> /var/log/lifeboat.log 2>&1
```

Do not add `--fresh` to scheduled builds: an interrupted job should resume. If
near-real-time publishing is worth mutable in-place updates, explicitly enable
incrementals and run due WordPress cron events separately; that is an opt-in
operating profile rather than a requirement for failover. Configuration cannot
prevent a privileged operator from manually invoking `wp lifeboat incremental`,
so treat full-only behavior as an operating policy as well as a saved setting.

Use the same configuration-management job to install the plugin and set its R2
credentials and `LIFEBOAT_PREFIX`. The prefix must match this inventory. At 100+
sites, keep one inventory and one edge deployment; vary only the origin, prefix,
WordPress document root, and credentials supplied by the deployment system.

R2 S3 write permissions are bucket-scoped, not restricted to a
`sites/<canonicalHost>` prefix. Separate tokens for one shared bucket improve
rotation and revocation but do not prevent a compromised origin from writing
another site's keys. Treat the shared bucket as one trust boundary; divide
higher-risk tenants across separate buckets and Worker deployments when that
fleet-wide write blast radius is unacceptable.

The crawler should reach WordPress directly, not through the public Worker. If
that is impossible, a request header is not sufficient by itself: the Worker
bypasses fallback only when `X-Lifeboat-Crawl` exactly matches its configured
`CRAWL_SECRET`. With no binding or a mismatched value, the header is ignored;
after an origin failure, only an exact match changes the result from snapshot
fallback to a read-only 503. The binding is Worker-wide and cannot represent
100 independently generated plugin secrets, so private per-site origin paths
are the simpler and safer fleet design.

## Verify live and offline behavior

For each canary, first build and validate the promoted pointer:

```sh
wp lifeboat test-r2
wp lifeboat build --fresh --budget=300
wp lifeboat verify
```

Then request a known snapshotted page through its public hostname. While the
origin is healthy, require HTTP 200 and no `X-Lifeboat` header. During a
controlled origin stop or exact-record `force_fallback` drill, require the same
content with HTTP 200 and `X-Lifeboat: <snapshot-id>`. Also test an unknown path:
the fallback should return the captured `__404.html` with HTTP 404 and the same
snapshot header. Restore the origin or reapply the inventory immediately after
the drill.

```sh
curl --silent --show-error --dump-header - --output /dev/null \
  https://example.com/a-known-snapshotted-page/
```
