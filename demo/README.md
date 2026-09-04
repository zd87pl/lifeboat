# Local end-to-end failover demo

This demo runs unmodified Docker images for MariaDB, WordPress, WP-CLI, and
`cloudflared`. It read-only mounts only this repository's plugin PHP files,
publishes a snapshot to R2, deploys the Worker, then stops WordPress and
confirms that the Worker still returns the page with an `X-Lifeboat` header.

The two origin paths are deliberately separate: the Worker reaches WordPress
through the disposable Quick Tunnel, while the plugin crawler always uses the
internal `http://wordpress` loopback and can never crawl the fallback Worker.

## Run it

Prerequisites: Docker Compose, curl, Node.js 22+ with npm, an existing R2 bucket
named `lifeboat-demo`, an R2 Object Read & Write S3 token for that bucket, and a
Cloudflare API token that can deploy Workers. The account also needs an active
`workers.dev` subdomain unless `WORKER_PUBLIC_URL` already names a routed Worker
domain. The two tokens are different: Wrangler uses the Cloudflare API token,
while WordPress uses the R2 S3 access key and secret.

```bash
cd demo
cp .env.example .env
# Fill in the blank Cloudflare/R2 values without committing .env.
./demo.sh
```

The script performs and checks the complete sequence:

1. Start MariaDB, WordPress, and `cloudflared`, then discover the random origin
   URL.
2. Deploy the included Worker, make its `workers.dev` hostname WordPress's
   canonical URL, and activate Lifeboat.
3. Run `wp lifeboat test-r2`, build a fresh versioned snapshot, and read its
   `current.json` pointer back with `wp lifeboat verify`.
4. Fetch the sample post through the Worker and require HTTP 200 with no
   `X-Lifeboat` header, proving the response came from WordPress.
5. Stop only WordPress, keep the tunnel connected, fetch the same URL again,
   and require HTTP 200 plus `X-Lifeboat: <snapshot-id>`. It also checks the
   saved-copy banner, disabled forms, a static asset, the captured 404 page,
   and that an origin-only API path never leaks into the public snapshot.

The script prints the non-secret Quick Tunnel and Worker URLs, but never prints
the API token or R2 keys. At the end WordPress is intentionally stopped while
MariaDB and `cloudflared` remain up. Useful follow-ups are:

```bash
./demo.sh status
./demo.sh restore       # bring the origin back
./demo.sh cleanup       # remove containers; retain WordPress and DB volumes
./demo.sh reset         # also delete the local WordPress/MariaDB volumes
```

Add `--stop-db` to the run if the outage drill should stop both WordPress and
MariaDB. `reset` does not delete the deployed Worker, R2 bucket, or snapshots.
After `cleanup`, use `run` rather than `restore` because a Quick Tunnel URL does
not survive removal of its `cloudflared` container.

After `restore`, an isolate that recently saw the outage may continue serving
the snapshot for up to the Worker's 30-second breaker TTL. Retry until the
`X-Lifeboat` header disappears before declaring the live origin restored.

The demo configures a full-build-only operating profile: incremental hooks and
plugin-managed WP-Cron scheduling are disabled, and the script never invokes an
incremental command. Each normal run therefore proves an immutable full
snapshot promotion: objects are written under a new versioned prefix and
`current.json` changes only after the home page, captured 404 page, manifest,
and promotion checks succeed. Production sites may enable incremental refreshes
when in-place updates to the currently promoted prefix are preferable.

Quick Tunnels have random, temporary public URLs, no production SLA, and are
intended only for this local drill. Do not copy this origin setup into a live
fleet, put real content in the sample site, or reuse the demo passwords. The
tunnel makes this WordPress container publicly reachable without Cloudflare
Access for the duration of the drill. For 100 sites, use stable origin addresses
or named, access-controlled tunnels, one Worker, one R2 bucket, and an exact
`SITES` KV record per hostname. Provision plugin constants with each host's
secret manager and schedule `wp lifeboat build` per site.
[`../fleet/README.md`](../fleet/README.md) covers the inventory and staggered
rollout pattern.
