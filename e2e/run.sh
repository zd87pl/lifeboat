#!/usr/bin/env bash
# End-to-end proof of edge mode without a Cloudflare account or Docker: a real
# WordPress (PHP built-in server + SQLite) behind the real Worker (wrangler dev,
# i.e. workerd with a local R2 bucket), with the plugin publishing snapshots
# through the service ingest API using only a per-site key.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$REPO_DIR/worker"
CACHE_DIR="${LIFEBOAT_E2E_CACHE:-$SCRIPT_DIR/.cache}"
WORK_DIR="$SCRIPT_DIR/.work"
WP_DIR="$WORK_DIR/wordpress"
PHP_BIN="${LIFEBOAT_E2E_PHP:-php}"
ORIGIN_PORT="${LIFEBOAT_E2E_ORIGIN_PORT:-18080}"
EDGE_PORT="${LIFEBOAT_E2E_EDGE_PORT:-18787}"
PUBLIC_HOST="lifeboat.localhost"
PUBLIC_URL="http://$PUBLIC_HOST:$EDGE_PORT"
ORIGIN_URL="http://127.0.0.1:$ORIGIN_PORT"
INGEST_URL="http://127.0.0.1:$EDGE_PORT"
ADMIN_PASSWORD="lifeboat-e2e-$RANDOM$RANDOM"
GPTBOT='Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot'
KEEP_RUNNING=0

ORIGIN_PID=''
EDGE_PID=''
PASSED=0
FAILED=0
STATUS=''

usage() {
    cat <<'EOF'
Usage: e2e/run.sh [--keep-running]

Installs a throwaway WordPress under e2e/.work, starts it on PHP's built-in
server and the Lifeboat Worker under wrangler dev, publishes a snapshot through
the ingest API, and checks edge serving, dynamic routing, AI-crawler policy,
tenant isolation and outage fallback. Needs php (8.0+ with pdo_sqlite), node 22+,
npm, curl, tar, unzip and setsid. Downloads are cached in e2e/.cache.

  --keep-running   leave both servers up afterwards for manual testing

Environment: LIFEBOAT_E2E_PHP (PHP binary), LIFEBOAT_E2E_ORIGIN_PORT (18080),
LIFEBOAT_E2E_EDGE_PORT (18787), LIFEBOAT_E2E_CACHE (download cache directory).
EOF
}

while (($#)); do
    case "$1" in
        --keep-running) KEEP_RUNNING=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'error: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

for command in "$PHP_BIN" node npm curl tar unzip setsid; do
    command -v "$command" >/dev/null 2>&1 || { printf 'error: required command not found: %s\n' "$command" >&2; exit 1; }
done
"$PHP_BIN" -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);' || { printf 'error: %s lacks pdo_sqlite\n' "$PHP_BIN" >&2; exit 1; }

stop_group() {
    local pid="$1"
    [[ -n "$pid" ]] || return 0
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
}

cleanup() {
    if ((KEEP_RUNNING == 0)); then
        stop_group "$ORIGIN_PID"
        stop_group "$EDGE_PID"
    fi
}
trap cleanup EXIT

ok() { PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$1"; }
check() {
    local label="$1"
    shift
    if "$@"; then ok "$label"; else bad "$label"; fi
}
section() { printf '\n%s\n' "$1"; }

wp() {
    "$PHP_BIN" -d memory_limit=512M "$CACHE_DIR/wp-cli.phar" --path="$WP_DIR" --allow-root "$@"
}

download() {
    local url="$1" file="$2"
    [[ -s "$CACHE_DIR/$file" ]] && return 0
    printf 'Downloading %s\n' "$url"
    curl -fsSL --retry 3 -o "$CACHE_DIR/$file.part" "$url"
    mv "$CACHE_DIR/$file.part" "$CACHE_DIR/$file"
}

verify_sha() {
    local file="$1" url="$2" tool="$3" expected actual
    expected="$(curl -fsSL --retry 3 "$url" | awk '{ print $1 }')"
    actual="$("$tool" "$CACHE_DIR/$file" | awk '{ print $1 }')"
    if [[ -z "$expected" || "$expected" != "$actual" ]]; then
        printf 'error: checksum mismatch for %s; delete it from %s and retry\n' "$file" "$CACHE_DIR" >&2
        exit 1
    fi
}

wait_for_port() {
    local url="$1" name="$2" attempt
    for attempt in $(seq 1 90); do
        if curl -s -o /dev/null --max-time 2 --resolve "$PUBLIC_HOST:$EDGE_PORT:127.0.0.1" "$url"; then
            return 0
        fi
        sleep 1
    done
    printf 'error: %s did not start; see %s\n' "$name" "$WORK_DIR" >&2
    exit 1
}

# request <path> [curl args...]: response headers in $HEADERS, body in $BODY, status in $STATUS.
HEADERS="$WORK_DIR/headers.txt"
BODY="$WORK_DIR/body.txt"
request() {
    local path="$1"
    shift
    STATUS="$(curl -sS --max-time 30 --resolve "$PUBLIC_HOST:$EDGE_PORT:127.0.0.1" \
        -D "$HEADERS" -o "$BODY" -w '%{http_code}' "$@" "$PUBLIC_URL$path" || true)"
}

ingest() {
    local path="$1"
    shift
    STATUS="$(curl -sS --max-time 30 -D "$HEADERS" -o "$BODY" -w '%{http_code}' \
        -H "X-Lifeboat-Site: $PUBLIC_HOST" "$@" "$INGEST_URL$path" || true)"
}

header() {
    awk -v name="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
        { line = $0; sub(/\r$/, "", line); split(line, parts, ":") }
        tolower(parts[1]) == name { sub(/^[^:]*:[ \t]*/, "", line); print line; exit }
    ' "$HEADERS"
}

origin_hits() { wc -l <"$WORK_DIR/origin-requests.log" | tr -d ' '; }
origin_saw() { grep -Fxq -- "$1" "$WORK_DIR/origin-requests.log"; }

status_is() { [[ "$STATUS" == "$1" ]]; }
route_is() { [[ "$(header X-Lifeboat-Route)" == "$1" ]]; }
from_snapshot() { [[ -n "$(header X-Lifeboat)" ]]; }
from_origin() { [[ -z "$(header X-Lifeboat)" ]]; }
body_has() { grep -Fq -- "$1" "$BODY"; }
body_lacks() { ! grep -Fq -- "$1" "$BODY"; }
equal() { [[ "$1" == "$2" ]]; }
not_grep() { ! grep -q "$@"; }
not_equal() { [[ "$1" != "$2" ]]; }

start_origin() {
    LIFEBOAT_E2E_REQUEST_LOG="$WORK_DIR/origin-requests.log" PHP_CLI_SERVER_WORKERS=4 setsid "$PHP_BIN" -S "127.0.0.1:$ORIGIN_PORT" -t "$WP_DIR" "$SCRIPT_DIR/router.php" >>"$WORK_DIR/origin.log" 2>&1 &
    ORIGIN_PID=$!
    wait_for_port "$ORIGIN_URL/wp-login.php" "the WordPress origin"
}

start_edge() {
    (
        cd "$WORKER_DIR"
        WRANGLER_SEND_METRICS=false exec setsid node_modules/.bin/wrangler dev \
            --ip 127.0.0.1 --port "$EDGE_PORT" --persist-to "$WORK_DIR/wrangler-state" \
            --var "DEFAULT_HOST:$PUBLIC_HOST" \
            --var "DEFAULT_ORIGIN:$ORIGIN_URL" \
            --var "DEFAULT_MODE:edge" \
            --var "DEFAULT_AI:edge" \
            --var "DEFAULT_INGEST_KEY_SHA256:$SITE_KEY_SHA256" \
            --var "DEFAULT_EDGE_SECRET:$EDGE_SECRET" \
            --var "INGEST_HOST:127.0.0.1" \
            --var "POINTER_TTL_MS:0"
    ) >>"$WORK_DIR/edge.log" 2>&1 &
    EDGE_PID=$!
    wait_for_port "$PUBLIC_URL/" "wrangler dev"
}

section "Preparing dependencies"
mkdir -p "$CACHE_DIR"
download https://wordpress.org/latest.tar.gz wordpress.tar.gz
verify_sha wordpress.tar.gz https://wordpress.org/latest.tar.gz.sha1 sha1sum
download https://downloads.wordpress.org/plugin/sqlite-database-integration.zip sqlite-database-integration.zip
download https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar wp-cli.phar
verify_sha wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512 sha512sum
if [[ ! -x "$WORKER_DIR/node_modules/.bin/wrangler" ]]; then
    (cd "$WORKER_DIR" && npm ci --no-audit --no-fund)
fi

# Start from an empty work directory. The guard keeps the removal pinned to
# e2e/.work even if a variable were ever mis-set.
if [[ "$WORK_DIR" == "$SCRIPT_DIR/.work" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
fi
mkdir -p "$WORK_DIR"
: >"$WORK_DIR/origin.log"
: >"$WORK_DIR/origin-requests.log"

CREDENTIALS="$(node "$REPO_DIR/fleet/site-key.mjs")"
SITE_KEY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).siteKey)' "$CREDENTIALS")"
SITE_KEY_SHA256="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).siteKeySha256)' "$CREDENTIALS")"
EDGE_SECRET="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).edgeSecret)' "$CREDENTIALS")"

section "Installing WordPress on SQLite ($("$PHP_BIN" -r 'echo PHP_VERSION;'))"
tar -xzf "$CACHE_DIR/wordpress.tar.gz" -C "$WORK_DIR"
unzip -q "$CACHE_DIR/sqlite-database-integration.zip" -d "$WP_DIR/wp-content/plugins"
cp "$WP_DIR/wp-content/plugins/sqlite-database-integration/db.copy" "$WP_DIR/wp-content/db.php"
mkdir -p "$WP_DIR/wp-content/plugins/lifeboat" "$WP_DIR/wp-content/mu-plugins"
cp -R "$REPO_DIR/lifeboat.php" "$REPO_DIR/uninstall.php" "$REPO_DIR/includes" "$WP_DIR/wp-content/plugins/lifeboat/"
cp "$SCRIPT_DIR/fixtures.php" "$WP_DIR/wp-content/mu-plugins/lifeboat-e2e-fixtures.php"

salts=''
for name in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
    salts+="define( '$name', '$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')' );"$'\n'
done
cat >"$WP_DIR/wp-config.php" <<EOF
<?php
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '' );
define( 'DB_CHARSET', 'utf8' );
define( 'DB_COLLATE', '' );
define( 'DB_DIR', __DIR__ . '/wp-content/database/' );
define( 'DB_FILE', '.ht.sqlite' );
$salts
\$table_prefix = 'wp_';

define( 'WP_HOME', '$PUBLIC_URL' );
define( 'WP_SITEURL', '$PUBLIC_URL' );
define( 'DISABLE_WP_CRON', true );
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_DEBUG_LOG', '$WORK_DIR/debug.log' );

// Lifeboat: crawl the origin directly, publish through the service with this site's key only.
define( 'LIFEBOAT_ORIGIN_URL', '$ORIGIN_URL' );
define( 'LIFEBOAT_SERVICE_URL', '$INGEST_URL' );
define( 'LIFEBOAT_SERVICE_KEY', '$SITE_KEY' );
define( 'LIFEBOAT_EDGE_SECRET', '$EDGE_SECRET' );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
EOF

wp core install --url="$PUBLIC_URL" --title='Lifeboat e2e' --admin_user=admin \
    --admin_password="$ADMIN_PASSWORD" --admin_email=admin@example.invalid --skip-email --quiet
wp rewrite structure '/%postname%/' --quiet
POST_ID="$(wp post create --post_type=post --post_status=publish --post_title='Lifeboat e2e post' \
    --post_name=lifeboat-e2e-post --post_content='<p>Served from the edge while WordPress does other work.</p>' --porcelain)"
wp post create --post_type=page --post_status=publish --post_title='Private page' --post_name=private-page \
    --post_content='<p>The origin marks this page no-store.</p>' --porcelain >/dev/null
wp plugin activate lifeboat --quiet
printf 'WordPress %s at %s (origin %s)\n' "$(wp core version)" "$PUBLIC_URL" "$ORIGIN_URL"

section "Starting the origin and the edge"
start_origin
start_edge
printf 'origin pid %s, edge pid %s, logs in %s\n' "$ORIGIN_PID" "$EDGE_PID" "$WORK_DIR"

section "Plugin checks inside WordPress"
if wp eval-file "$SCRIPT_DIR/checks.php" "$WORK_DIR/keys.json"; then ok "plugin checks"; else bad "plugin checks"; fi
if node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const worker = await import(process.argv[1]);
    const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const wrong = cases.filter(({ path, key, asset }) => worker.pathToKey(path) !== key || worker.isAssetPath(path) !== asset);
    for (const item of wrong) console.error("mismatch", JSON.stringify(item), worker.pathToKey(item.path), worker.isAssetPath(item.path));
    process.exit(wrong.length ? 1 : 0);
' "$WORKER_DIR/src/index.js" "$WORK_DIR/keys.json"; then
    ok "Worker key mapping matches the plugin for every sample path"
else
    bad "Worker key mapping matches the plugin for every sample path"
fi

section "Publishing through the ingest API with a per-site key"
STORAGE_OUTPUT="$(wp lifeboat test-storage 2>&1 || true)"
printf '%s\n' "$STORAGE_OUTPUT" | sed 's/^/    /'
check "test-storage reaches the service and reports edge mode" grep -Fq 'edge mode: edge' <<<"$STORAGE_OUTPUT"
check "the test-r2 alias still works" wp lifeboat test-r2 --quiet
BUILD_OUTPUT="$(wp lifeboat build --fresh --budget=300 2>&1 || true)"
printf '%s\n' "$BUILD_OUTPUT" | tail -n 3 | sed 's/^/    /'
check "a full snapshot is built and promoted" grep -q 'promoted' <<<"$BUILD_OUTPUT"
check "exactly the no-store page is recorded as private" grep -Fq '(1 private)' <<<"$BUILD_OUTPUT"
check "verify reads current.json back through the service" wp lifeboat verify --quiet
check "the build requested no URLs made of inline-script fragments" not_grep -E '/r$|defer' "$WORK_DIR/origin-requests.log"

ingest /v1/site -H "Authorization: Bearer lbk_not-the-right-key-0123456789"
check "a wrong site key is rejected (HTTP $STATUS)" status_is 401
ingest "/v1/object?key=sites%2Fother.example%2Fcurrent.json" -X PUT -H "Authorization: Bearer $SITE_KEY" --data-binary 'x'
check "the site key cannot write another site's prefix (HTTP $STATUS)" status_is 403

section "Edge mode: anonymous traffic never reaches WordPress"
before="$(origin_hits)"
request /
ETAG="$(header ETag)"
check "home page: HTTP $STATUS from the edge" route_is edge
check "home page carries the snapshot id" from_snapshot
check "home page is the real WordPress page" body_has 'Lifeboat e2e'
request "/lifeboat-e2e-post/?utm_source=newsletter&fbclid=abc"
check "a campaign-tagged post URL is served from the edge" route_is edge
request / -H "If-None-Match: $ETAG"
check "revalidation with the ETag returns 304 (got $STATUS)" status_is 304
request /lifeboat-e2e-post/
ASSET="$(grep -oE "(href|src)=['\"]$PUBLIC_URL/wp-[^'\"]+\.(css|js)\?ver=[^'\"]+" "$BODY" | head -n 1 | sed -E "s/^[^=]+=['\"]//; s#^$PUBLIC_URL##" || true)"
if [[ -n "$ASSET" ]]; then
    request "$ASSET"
    check "a versioned theme asset ($ASSET) is served from the edge" route_is edge
else
    bad "the post page references a versioned stylesheet or script"
fi
check "none of these requests reached the origin" equal "$(origin_hits)" "$before"

section "Edge mode: dynamic requests reach WordPress"
before="$(origin_hits)"
request "/?s=lifeboat"
check "search: HTTP $STATUS answered by WordPress" from_origin
check "search results come from the live site (no redirect loop)" body_has 'Lifeboat e2e post'
request /wp-json/
check "REST API: HTTP $STATUS answered by WordPress" from_origin
check "REST API returns JSON" body_has '"namespaces"'
request /private-page/
check "a page the origin marks no-store is fetched live (HTTP $STATUS)" from_origin
check "each of them reached the origin exactly once" equal "$(origin_hits)" "$((before + 3))"
check "the origin saw the search with its query string" origin_saw 'GET /?s=lifeboat'

request /wp-comments-post.php -X POST -H 'CF-Connecting-IP: 203.0.113.7' \
    --data-urlencode 'comment=Comments keep working behind the edge.' --data-urlencode 'author=E2E Visitor' \
    --data-urlencode 'email=visitor@example.invalid' --data "comment_post_ID=$POST_ID&comment_parent=0"
check "a comment POST is answered by WordPress (HTTP $STATUS)" status_is 302
COMMENT="$(wp comment list --post_id="$POST_ID" --status=hold --fields=comment_ID,comment_author_IP --format=csv | tail -n +2 | head -n 1)"
check "WordPress recorded the visitor's IP from the verified edge ($COMMENT)" equal "${COMMENT#*,}" '203.0.113.7'

wp comment approve "${COMMENT%%,*}" --quiet
INCREMENTAL_OUTPUT="$(wp lifeboat incremental 2>&1 || true)"
check "approving the comment queued an incremental refresh of its post" grep -q '1 refreshed' <<<"$INCREMENTAL_OUTPUT"
request /lifeboat-e2e-post/
check "the edge copy shows the approved comment" body_has 'Comments keep working behind the edge.'
check "and is still served from the edge" route_is edge
FIRST_SNAPSHOT="$(header X-Lifeboat)"

REBUILD_OUTPUT="$(wp lifeboat build --budget=300 2>&1 || true)"
printf '%s\n' "$REBUILD_OUTPUT" | tail -n 1 | sed 's/^/    /'
check "a second full build is promoted" grep -q 'promoted' <<<"$REBUILD_OUTPUT"
check "its unchanged objects are copied inside storage, not re-uploaded" grep -Eq ' [1-9][0-9]* copied' <<<"$REBUILD_OUTPUT"
PRUNE_OUTPUT="$(wp lifeboat prune --keep=1 2>&1 || true)"
check "prune removes the superseded snapshot" grep -q "Pruned sites/$PUBLIC_HOST/snapshots/$FIRST_SNAPSHOT/" <<<"$PRUNE_OUTPUT"
ingest "/v1/list?prefix=sites%2F$PUBLIC_HOST%2Fsnapshots%2F&delimiter=%2F" -H "Authorization: Bearer $SITE_KEY"
check "exactly one snapshot remains in storage" equal "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).prefixes.length)' <"$BODY")" 1
request /lifeboat-e2e-post/
check "the edge serves the new snapshot" not_equal "$(header X-Lifeboat)" "$FIRST_SNAPSHOT"
check "including the approved comment" body_has 'Comments keep working behind the edge.'

JAR="$WORK_DIR/cookies.txt"
request /wp-login.php -c "$JAR" -b "$JAR"
request /wp-login.php -c "$JAR" -b "$JAR" --data-urlencode 'log=admin' --data-urlencode "pwd=$ADMIN_PASSWORD" \
    --data-urlencode "redirect_to=$PUBLIC_URL/wp-admin/" --data 'testcookie=1'
check "logging in through the edge works (HTTP $STATUS)" status_is 302
check "the login cookie is issued for the public host" grep -qi 'set-cookie: wordpress_logged_in_' "$HEADERS"
request / -b "$JAR"
check "a logged-in home page view goes to WordPress" from_origin
check "and shows the admin toolbar" body_has 'id="wpadminbar"'

section "AI crawlers: served from the edge, never doing dynamic work"
before="$(origin_hits)"
request /lifeboat-e2e-post/ -A "$GPTBOT"
check "GPTBot reads the post from the edge (HTTP $STATUS)" route_is edge
request "/?add-to-cart=1" -A "$GPTBOT"
check "GPTBot's add-to-cart crawl trap gets the snapshot 404 (HTTP $STATUS)" status_is 404
request /wp-json/wp/v2/posts -A "$GPTBOT"
check "GPTBot cannot reach the REST API (HTTP $STATUS)" status_is 403
check "no crawler request reached the origin" equal "$(origin_hits)" "$before"

section "Origin outage"
stop_group "$ORIGIN_PID"
ORIGIN_PID=''
for _ in $(seq 1 20); do curl -s -o /dev/null --max-time 1 "$ORIGIN_URL/" || break; sleep 0.5; done
request /lifeboat-e2e-post/
check "the post is still served from the edge (HTTP $STATUS)" route_is edge
request "/?s=outage"
check "a dynamic page falls back to the snapshot (HTTP $STATUS)" route_is fallback
check "and is labelled as a saved copy" body_has 'id="lifeboat-saved-copy"'
request /lifeboat-e2e-post/
check "edge pages now carry the saved-copy banner" body_has 'id="lifeboat-saved-copy"'
check "with the comment form disabled" body_has 'data-lifeboat-disabled="true"'
check "and are not cached by browsers" equal "$(header Cache-Control)" 'no-store'
request /wp-comments-post.php -X POST --data "comment=x&comment_post_ID=$POST_ID"
check "a comment POST gets the read-only 503 (HTTP $STATUS)" status_is 503
request /wp-json/
check "the REST API gets the read-only 503, never a page (HTTP $STATUS)" status_is 503
request /never-published/
check "an unknown URL gets the captured 404 page (HTTP $STATUS)" status_is 404
check "from the snapshot" from_snapshot

section "PHP notices"
if [[ -f "$WORK_DIR/debug.log" ]] && grep -E 'plugins/lifeboat/' "$WORK_DIR/debug.log" >"$WORK_DIR/lifeboat-notices.log"; then
    bad "Lifeboat logged PHP warnings or notices (see $WORK_DIR/lifeboat-notices.log)"
    sed 's/^/    /' "$WORK_DIR/lifeboat-notices.log" | head -n 20
else
    ok "Lifeboat logged no PHP warnings, notices or deprecations"
fi

printf '\n%d passed, %d failed. Logs: %s\n' "$PASSED" "$FAILED" "$WORK_DIR"
if ((KEEP_RUNNING)); then
    printf 'Still running: edge %s (origin stopped by the outage drill; restart it with php -S as in this script).\n' "$PUBLIC_URL"
fi
((FAILED == 0))
