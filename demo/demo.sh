#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/../worker" 2>/dev/null && pwd || true)"
ENV_FILE="$SCRIPT_DIR/.env"
COMMAND="run"
STOP_DATABASE=0

usage() {
    cat <<'EOF'
Usage: ./demo.sh [run] [--stop-db] [--env-file FILE]
       ./demo.sh restore|status|cleanup|reset [--env-file FILE]

  run        Build the sample, prove the live origin, stop WordPress, and prove fallback.
  restore    Restart WordPress after a successful run (the quick tunnel must still exist).
  status     Show containers and the non-secret public URLs saved by the last run.
  cleanup    Remove containers and the network, preserving WordPress/MariaDB data.
  reset      Remove containers, volumes, and saved runtime URLs for a clean first run.

The default run stops only WordPress; --stop-db stops MariaDB as well.
EOF
}

while (($#)); do
    case "$1" in
        run|restore|status|cleanup|reset)
            COMMAND="$1"
            shift
            ;;
        --stop-db)
            STOP_DATABASE=1
            shift
            ;;
        --env-file)
            [[ $# -ge 2 ]] || { printf 'error: --env-file needs a path\n' >&2; exit 2; }
            ENV_FILE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'error: unknown argument: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ "$ENV_FILE" != /* ]]; then
    ENV_FILE="$(pwd)/$ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
    printf 'error: %s does not exist\n' "$ENV_FILE" >&2
    printf 'Create it with: cp %s/.env.example %s/.env\n' "$SCRIPT_DIR" "$SCRIPT_DIR" >&2
    exit 1
fi

# .env.example intentionally uses shell-compatible KEY=value syntax.
# shellcheck source=/dev/null
source "$ENV_FILE"

# The Worker and R2 normally live in the same Cloudflare account. Keep the
# second name as an override for unusual setups without making it mandatory.
LIFEBOAT_R2_ACCOUNT_ID="${LIFEBOAT_R2_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lifeboat-demo}"
STATE_SLUG="$(printf '%s' "$PROJECT_NAME" | tr -cs '[:alnum:]_.-' '-')"
STATE_FILE="$SCRIPT_DIR/.runtime-${STATE_SLUG}.env"

compose() {
    docker compose \
        --project-directory "$SCRIPT_DIR" \
        --env-file "$ENV_FILE" \
        -f "$SCRIPT_DIR/compose.yaml" \
        "$@"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'error: required command not found: %s\n' "$1" >&2
        return 1
    }
}

require_value() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        printf 'error: %s must be set in %s\n' "$name" "$ENV_FILE" >&2
        return 1
    fi
}

wp_cli() {
    compose run --rm --no-deps cli --quiet "$@"
}

wait_for_database() {
    local attempt
    printf 'Waiting for MariaDB'
    for attempt in {1..60}; do
        if compose exec -T database healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
            printf ' ready.\n'
            return 0
        fi
        printf '.'
        sleep 2
    done
    printf '\nerror: MariaDB did not become ready\n' >&2
    return 1
}

wait_for_wordpress_files() {
    local attempt
    printf 'Waiting for the WordPress volume'
    for attempt in {1..60}; do
        if compose exec -T wordpress test -f /var/www/html/wp-config.php >/dev/null 2>&1; then
            printf ' ready.\n'
            return 0
        fi
        printf '.'
        sleep 2
    done
    printf '\nerror: WordPress did not finish preparing its shared volume\n' >&2
    return 1
}

discover_tunnel_url() {
    local attempt url
    printf 'Waiting for the Cloudflare Quick Tunnel URL' >&2
    for attempt in {1..60}; do
        url="$(compose logs --no-color cloudflared 2>/dev/null \
            | grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' \
            | tail -n 1 || true)"
        if [[ -n "$url" ]]; then
            printf ' ready.\n' >&2
            printf '%s\n' "$url"
            return 0
        fi
        printf '.' >&2
        sleep 2
    done
    printf '\nerror: cloudflared did not publish a Quick Tunnel URL\n' >&2
    compose logs --no-color --tail=80 cloudflared >&2 || true
    return 1
}

worker_bucket_name() {
    local config
    for config in "$WORKER_DIR/wrangler.jsonc" "$WORKER_DIR/wrangler.toml"; do
        if [[ -f "$config" ]]; then
            sed -nE 's/.*"?bucket_name"?[[:space:]]*[:=][[:space:]]*"([^"]+)".*/\1/p' "$config" \
                | head -n 1
            return 0
        fi
    done
}

install_worker_dependencies() {
    if [[ -x "$WORKER_DIR/node_modules/.bin/wrangler" ]]; then
        return 0
    fi
    printf '\nInstalling the Worker dependencies once...\n'
    if [[ -f "$WORKER_DIR/package-lock.json" ]]; then
        (cd "$WORKER_DIR" && npm ci --no-audit --no-fund)
    else
        (cd "$WORKER_DIR" && npm install --no-package-lock --no-audit --no-fund)
    fi
}

deploy_worker() {
    local origin_url="$1"
    local default_host="${2:-}"
    local log_file="$3"
    local -a args=(deploy --var "DEFAULT_ORIGIN:$origin_url")
    if [[ -n "$default_host" ]]; then
        args+=(--var "DEFAULT_HOST:$default_host")
    fi
    (cd "$WORKER_DIR" && npx --no-install wrangler "${args[@]}") 2>&1 | tee "$log_file"
}

saved_worker_url() {
    if [[ -n "${WORKER_PUBLIC_URL:-}" ]]; then
        printf '%s\n' "${WORKER_PUBLIC_URL%/}"
        return 0
    fi
    if [[ -f "$STATE_FILE" ]]; then
        local WP_PUBLIC_URL='' LIFEBOAT_ORIGIN_URL='' LIFEBOAT_PREFIX=''
        # This file is generated by save_state and contains no credentials.
        # shellcheck source=/dev/null
        source "$STATE_FILE"
        if [[ -n "$WP_PUBLIC_URL" ]]; then
            printf '%s\n' "${WP_PUBLIC_URL%/}"
        fi
    fi
}

save_state() {
    local origin_url="$1"
    local worker_url="$2"
    local prefix="$3"
    {
        printf 'LIFEBOAT_ORIGIN_URL=%q\n' "$origin_url"
        printf 'WP_PUBLIC_URL=%q\n' "$worker_url"
        printf 'LIFEBOAT_PREFIX=%q\n' "$prefix"
    } >"$STATE_FILE"
}

configure_sample_site() {
    if ! wp_cli core is-installed >/dev/null 2>&1; then
        printf '\nInstalling WordPress...\n'
        wp_cli core install \
            --url="$WP_PUBLIC_URL" \
            --title='Lifeboat failover demo' \
            --admin_user="${WORDPRESS_ADMIN_USER:-lifeboat}" \
            --admin_password="${WORDPRESS_ADMIN_PASSWORD:-lifeboat-demo-change-me}" \
            --admin_email="${WORDPRESS_ADMIN_EMAIL:-lifeboat@example.invalid}" \
            --skip-email
    else
        printf '\nReusing the installed WordPress database.\n'
    fi

    wp_cli rewrite structure '/%postname%/' --hard
    wp_cli option update blogname 'Lifeboat failover demo'
    wp_cli option update blogdescription 'The origin can sink; this page stays afloat.'

    if [[ -z "$(wp_cli post list --post_type=post --post_status=any --name=lifeboat-demo-snapshot --format=ids)" ]]; then
        wp_cli post create \
            --post_type=post \
            --post_status=publish \
            --post_name=lifeboat-demo-snapshot \
            --post_title='Lifeboat demo snapshot' \
            --post_content='<p>This content is served by WordPress while the origin is healthy and from Cloudflare R2 after the origin is stopped.</p>' \
            --porcelain >/dev/null
    fi
    if [[ -z "$(wp_cli post list --post_type=page --post_status=any --name=about-the-demo --format=ids)" ]]; then
        wp_cli post create \
            --post_type=page \
            --post_status=publish \
            --post_name=about-the-demo \
            --post_title='About the Lifeboat demo' \
            --post_content='<p>A small, repeatable WordPress failover drill.</p>' \
            --porcelain >/dev/null
    fi

    wp_cli plugin activate lifeboat
    wp_cli eval '$settings = get_option( "lifeboat_settings", array() ); $settings["incremental"] = 0; $settings["use_wp_cron"] = 0; $settings["schedule_hours"] = 0; update_option( "lifeboat_settings", $settings ); foreach ( array( "lifeboat_scheduled_build", "lifeboat_full_rebuild", "lifeboat_run_job", "lifeboat_incremental" ) as $hook ) { wp_clear_scheduled_hook( $hook ); } delete_option( "lifeboat_pending" );'
}

curl_worker() {
    local url="$1"
    local headers_file="$2"
    local body_file="$3"
    curl --silent --show-error \
        --max-time 25 \
        --dump-header "$headers_file" \
        --output "$body_file" \
        --write-out '%{http_code}' \
        "$url"
}

verify_live_origin() {
    local worker_url="$1"
    local headers_file="$2"
    local body_file="$3"
    local attempt status='000'
    printf '\nChecking the live Worker URL'
    for attempt in {1..20}; do
        status="$(curl_worker "$worker_url/lifeboat-demo-snapshot/" "$headers_file" "$body_file" || true)"
        if [[ "$status" == "200" ]] && grep -Fq 'Lifeboat demo snapshot' "$body_file"; then
            break
        fi
        printf '.'
        sleep 2
    done
    printf '\n'
    if [[ "$status" != "200" ]] || ! grep -Fq 'Lifeboat demo snapshot' "$body_file"; then
        printf 'error: live site check failed (HTTP %s)\n' "$status" >&2
        return 1
    fi
    if grep -Eiq '^x-lifeboat:' "$headers_file"; then
        printf 'error: expected WordPress, but the live check already used a snapshot\n' >&2
        return 1
    fi
    printf 'Live origin verified: %s (HTTP %s, no X-Lifeboat header).\n' "$worker_url" "$status"
}

verify_fallback() {
    local worker_url="$1"
    local headers_file="$2"
    local body_file="$3"
    local attempt status='000' snapshot_id='' asset_url='' asset_snapshot=''
    printf 'Waiting for the Worker to fail over to R2'
    for attempt in {1..15}; do
        status="$(curl_worker "$worker_url/lifeboat-demo-snapshot/" "$headers_file" "$body_file" || true)"
        snapshot_id="$(awk -F ': *' 'tolower($1) == "x-lifeboat" { gsub("\\r", "", $2); print $2; exit }' "$headers_file")"
        if [[ "$status" == "200" && -n "$snapshot_id" ]] && grep -Fq 'Lifeboat demo snapshot' "$body_file"; then
            printf ' ready.\n'
            break
        fi
        printf '.'
        sleep 2
    done
    if [[ "$status" != "200" || -z "$snapshot_id" ]] || ! grep -Fq 'Lifeboat demo snapshot' "$body_file"; then
        printf '\nerror: fallback did not return the saved page with X-Lifeboat (last HTTP %s)\n' "$status" >&2
        return 1
    fi
    if ! grep -Fq 'id="lifeboat-saved-copy"' "$body_file"; then
        printf 'error: fallback HTML is missing the saved-copy banner\n' >&2
        return 1
    fi
    if ! grep -Fq 'data-lifeboat-disabled="true"' "$body_file"; then
        printf 'error: fallback HTML did not disable its form controls\n' >&2
        return 1
    fi

    # Select only a real href/src attribute. CSS sourceURL comments look like
    # asset URLs too, but they are debugging metadata and are not page loads.
    asset_url="$(grep -Eo '(href|src)="https://[^"]+\.(css|js)(\?[^"]*)?"' "$body_file" \
        | head -n 1 \
        | sed -E 's/^[^=]+="([^"]+)"$/\1/' || true)"
    if [[ -z "$asset_url" ]]; then
        printf 'error: saved page did not contain a stylesheet or script URL to verify\n' >&2
        return 1
    fi
    status="$(curl_worker "$asset_url" "$headers_file" "$body_file" || true)"
    asset_snapshot="$(awk -F ': *' 'tolower($1) == "x-lifeboat" { gsub("\\r", "", $2); print $2; exit }' "$headers_file")"
    if [[ "$status" != "200" || "$asset_snapshot" != "$snapshot_id" ]]; then
        printf 'error: saved asset check failed (HTTP %s, X-Lifeboat: %s)\n' "$status" "${asset_snapshot:-missing}" >&2
        return 1
    fi

    status="$(curl_worker "$worker_url/definitely-not-in-the-snapshot/" "$headers_file" "$body_file" || true)"
    asset_snapshot="$(awk -F ': *' 'tolower($1) == "x-lifeboat" { gsub("\\r", "", $2); print $2; exit }' "$headers_file")"
    if [[ "$status" != "404" || "$asset_snapshot" != "$snapshot_id" ]]; then
        printf 'error: saved 404 check failed (HTTP %s, X-Lifeboat: %s)\n' "$status" "${asset_snapshot:-missing}" >&2
        return 1
    fi

    status="$(curl_worker "$worker_url/wp-json/lifeboat/v1/health" "$headers_file" "$body_file" || true)"
    if [[ "$status" != "503" ]] || grep -Eiq '^x-lifeboat:' "$headers_file"; then
        printf 'error: origin-only health endpoint was incorrectly served from the snapshot (HTTP %s)\n' "$status" >&2
        return 1
    fi

    printf 'Fallback verified: page, banner, disabled forms, static asset, 404, and origin-only bypass all passed with snapshot %s.\n' "$snapshot_id"
}

restore_site() {
    if [[ ! -f "$STATE_FILE" ]]; then
        printf 'error: no runtime state found; run the demo first\n' >&2
        return 1
    fi
    # shellcheck source=/dev/null
    source "$STATE_FILE"
    export WP_PUBLIC_URL LIFEBOAT_ORIGIN_URL LIFEBOAT_PREFIX
    if [[ -z "$(compose ps -q cloudflared)" ]]; then
        printf 'error: the saved Quick Tunnel is no longer running; use run to create and deploy a new one\n' >&2
        return 1
    fi
    compose up -d database wordpress
    printf 'WordPress restored. Public URL: %s\n' "$WP_PUBLIC_URL"
}

run_demo() {
    local origin_url crawl_origin_url worker_url worker_host prefix configured_bucket
    local deploy_log headers_file body_file

    require_command docker
    require_command curl
    require_command node
    require_command npm
    require_value CLOUDFLARE_ACCOUNT_ID
    require_value CLOUDFLARE_API_TOKEN
    require_value LIFEBOAT_R2_ACCOUNT_ID
    require_value LIFEBOAT_R2_BUCKET
    require_value LIFEBOAT_R2_ACCESS_KEY_ID
    require_value LIFEBOAT_R2_SECRET_ACCESS_KEY

    if [[ -z "$WORKER_DIR" || ! -f "$WORKER_DIR/package.json" ]]; then
        printf 'error: expected the Worker project at %s/../worker\n' "$SCRIPT_DIR" >&2
        return 1
    fi
    configured_bucket="$(worker_bucket_name)"
    if [[ -n "$configured_bucket" && "$configured_bucket" != "$LIFEBOAT_R2_BUCKET" ]]; then
        printf 'error: LIFEBOAT_R2_BUCKET must match the Worker binding (%s)\n' "$configured_bucket" >&2
        return 1
    fi

    export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN LIFEBOAT_R2_ACCOUNT_ID
    docker info >/dev/null
    compose config --quiet

    printf 'Starting MariaDB, WordPress, and a Cloudflare Quick Tunnel...\n'
    compose up -d database wordpress cloudflared
    wait_for_database
    wait_for_wordpress_files
    origin_url="$(discover_tunnel_url)"
    printf 'Origin tunnel: %s\n' "$origin_url"

    install_worker_dependencies
    deploy_log="$(mktemp -t lifeboat-deploy.XXXXXX)"
    headers_file="$(mktemp -t lifeboat-headers.XXXXXX)"
    body_file="$(mktemp -t lifeboat-body.XXXXXX)"
    trap 'rm -f "${deploy_log:-}" "${headers_file:-}" "${body_file:-}"' EXIT

    worker_url="$(saved_worker_url || true)"
    if [[ -n "$worker_url" ]]; then
        worker_host="${worker_url#https://}"
        if [[ "$worker_url" != https://* || "$worker_host" == */* ]]; then
            printf 'error: WORKER_PUBLIC_URL must be an https:// URL with no path\n' >&2
            return 1
        fi
        printf '\nDeploying the Worker with the new tunnel origin...\n'
        deploy_worker "$origin_url" "$worker_host" "$deploy_log"
    else
        printf '\nDeploying the Worker and discovering its workers.dev URL...\n'
        deploy_worker "$origin_url" '' "$deploy_log"
        worker_url="$(grep -Eo 'https://[-A-Za-z0-9._]+\.workers\.dev' "$deploy_log" | tail -n 1 || true)"
        if [[ -z "$worker_url" ]]; then
            printf 'error: Wrangler did not report a workers.dev URL; set WORKER_PUBLIC_URL in %s\n' "$ENV_FILE" >&2
            return 1
        fi
        worker_url="${worker_url%/}"
        worker_host="${worker_url#https://}"
        printf '\nPinning the snapshot host to %s...\n' "$worker_host"
        deploy_worker "$origin_url" "$worker_host" "$deploy_log"
    fi

    prefix="sites/$worker_host"
    crawl_origin_url="${LIFEBOAT_CRAWL_ORIGIN_URL:-http://wordpress}"
    export WP_PUBLIC_URL="$worker_url"
    export LIFEBOAT_ORIGIN_URL="$crawl_origin_url"
    export LIFEBOAT_PREFIX="$prefix"
    save_state "$crawl_origin_url" "$worker_url" "$prefix"

    # wp-config.php contains getenv() calls, so a recreate applies the newly
    # discovered public URLs without writing credentials to the volume.
    compose up -d --force-recreate wordpress
    wait_for_database
    configure_sample_site

    printf '\nTesting R2 credentials...\n'
    wp_cli lifeboat test-r2
    printf '\nSnapshot seed URLs:\n'
    wp_cli lifeboat urls
    printf '\nBuilding and promoting the snapshot...\n'
    wp_cli lifeboat build --fresh --budget=300
    printf '\nReading the promoted snapshot back from R2...\n'
    wp_cli lifeboat verify

    verify_live_origin "$worker_url" "$headers_file" "$body_file"

    printf '\nStopping WordPress; cloudflared remains connected to demonstrate an origin outage...\n'
    compose stop wordpress
    if ((STOP_DATABASE)); then
        compose stop database
    fi
    if [[ -z "$(compose ps -q cloudflared)" ]]; then
        printf 'error: cloudflared is not still running\n' >&2
        return 1
    fi
    verify_fallback "$worker_url" "$headers_file" "$body_file"

    printf '\nDemo complete. WordPress is stopped and the snapshot is still public at:\n  %s\n' "$worker_url"
    printf 'Restore with: %s restore%s\n' "$0" "${ENV_FILE:+ --env-file $ENV_FILE}"
    printf 'Clean up with: %s cleanup%s\n' "$0" "${ENV_FILE:+ --env-file $ENV_FILE}"
}

case "$COMMAND" in
    run)
        run_demo
        ;;
    restore)
        require_command docker
        restore_site
        ;;
    status)
        require_command docker
        compose ps
        if [[ -f "$STATE_FILE" ]]; then
            printf '\nSaved public runtime values:\n'
            sed -nE 's/^(LIFEBOAT_ORIGIN_URL|WP_PUBLIC_URL|LIFEBOAT_PREFIX)=/  \1=/p' "$STATE_FILE"
        fi
        ;;
    cleanup)
        require_command docker
        compose down --remove-orphans
        printf 'Containers removed; named volumes and %s were preserved.\n' "$STATE_FILE"
        ;;
    reset)
        require_command docker
        compose down --volumes --remove-orphans
        rm -f "$STATE_FILE"
        printf 'Containers, demo volumes, and saved runtime URLs removed. R2 objects and the Worker were not deleted.\n'
        ;;
esac
