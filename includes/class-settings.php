<?php
namespace Lifeboat;

/**
 * Plugin settings. Values defined as constants in wp-config.php override the stored option.
 */
final class Settings {

	public const OPTION = 'lifeboat_settings';

	public const CONSTANTS = [
		'r2_account_id'        => 'LIFEBOAT_R2_ACCOUNT_ID',
		'r2_bucket'            => 'LIFEBOAT_R2_BUCKET',
		'r2_access_key_id'     => 'LIFEBOAT_R2_ACCESS_KEY_ID',
		'r2_secret_access_key' => 'LIFEBOAT_R2_SECRET_ACCESS_KEY',
		'origin_url'           => 'LIFEBOAT_ORIGIN_URL',
		'prefix'               => 'LIFEBOAT_PREFIX',
		'service_url'          => 'LIFEBOAT_SERVICE_URL',
		'service_key'          => 'LIFEBOAT_SERVICE_KEY',
		'edge_secret'          => 'LIFEBOAT_EDGE_SECRET',
	];

	public const CHECKBOXES = [ 'origin_ssl_verify', 'use_wp_cron', 'incremental', 'trust_edge_host' ];

	/** Settings whose stored value is kept when the form field is left blank. */
	public const SECRETS = [ 'r2_secret_access_key', 'service_key', 'edge_secret' ];

	/** Paths matching any of these (PCRE, no delimiters, matched against the decoded path) are never crawled. */
	public const DEFAULT_EXCLUDES = [
		'^/wp-admin(/|$)',
		'^/wp-login\.php',
		'^/wp-json(/|$)',
		'^/xmlrpc\.php',
		'^/wp-cron\.php',
		'^/wp-signup\.php',
		'^/wp-activate\.php',
		'^/wp-comments-post\.php',
		'\.php$',
		'^/.+/feed/?$',   // every feed except the root one
		'/embed/?$',
	];

	public static function defaults(): array {
		return [
			'r2_account_id'        => '',
			'r2_bucket'            => '',
			'r2_access_key_id'     => '',
			'r2_secret_access_key' => '',
			'prefix'               => '',      // defaults to sites/<host>
			'service_url'          => '',      // hosted Lifeboat ingest endpoint; replaces the R2 credentials
			'service_key'          => '',
			'edge_secret'          => '',      // shared with the Worker (SITES record edgeSecret)
			'trust_edge_host'      => 1,       // accept the edge's X-Forwarded-Host when it names this site
			'origin_url'           => '',      // loopback base, e.g. https://127.0.0.1 — strongly recommended
			'origin_ssl_verify'    => 0,
			'schedule_hours'       => 6,       // 0 disables the WP-Cron schedule
			'use_wp_cron'          => 1,
			'time_budget'          => 20,      // seconds of work per WP-Cron tick
			'max_urls'             => 20000,
			'max_asset_mb'         => 50,
			'keep_snapshots'       => 3,
			'max_error_pct'        => 1,       // promote only if failed uploads stay under this
			'incremental'          => 1,
			'debounce'             => 120,
			'extra_urls'           => '',
			'exclude'              => '',
			'crawl_secret'         => '',
		];
	}

	public static function all(): array {
		$opt = get_option( self::OPTION, [] );
		$s   = array_merge( self::defaults(), is_array( $opt ) ? $opt : [] );
		foreach ( self::CONSTANTS as $key => $const ) {
			if ( defined( $const ) ) {
				$s[ $key ] = (string) constant( $const );
			}
		}
		return $s;
	}

	public static function get( string $key ) {
		return self::all()[ $key ] ?? null;
	}

	public static function is_constant( string $key ): bool {
		return isset( self::CONSTANTS[ $key ] ) && defined( self::CONSTANTS[ $key ] );
	}

	public static function r2_ready(): bool {
		$s = self::all();
		return '' !== $s['r2_account_id'] && '' !== $s['r2_bucket'] && '' !== $s['r2_access_key_id'] && '' !== $s['r2_secret_access_key'];
	}

	public static function service_ready(): bool {
		$s = self::all();
		return '' !== $s['service_url'] && '' !== $s['service_key'] && self::valid_service_url( $s['service_url'] );
	}

	public static function storage_ready(): bool {
		return null === self::storage_problem();
	}

	/**
	 * Where snapshots go: the hosted Lifeboat service when a service URL is set (never silently your
	 * own bucket instead), otherwise your own R2 bucket.
	 */
	public static function storage(): ?Storage_Client {
		return '' !== (string) self::get( 'service_url' ) ? Service_Client::from_settings() : R2_Client::from_settings();
	}

	/** Why storage() is unavailable, or null when it is ready. */
	public static function storage_problem(): ?string {
		$s = self::all();
		if ( '' !== $s['service_url'] ) {
			if ( ! self::valid_service_url( $s['service_url'] ) ) {
				return 'The Lifeboat service URL must be an https:// address (plain http only for localhost), because the site key travels with every request.';
			}
			return '' === $s['service_key'] ? 'The Lifeboat service key is missing (LIFEBOAT_SERVICE_KEY).' : null;
		}
		return self::r2_ready() ? null : 'No snapshot storage is configured: connect a Lifeboat service or a Cloudflare R2 bucket.';
	}

	/** The site key travels in every request, so only loopback development may use plain HTTP. */
	public static function valid_service_url( string $url ): bool {
		$p = wp_parse_url( $url );
		if ( ! is_array( $p ) || empty( $p['host'] ) || isset( $p['user'] ) || isset( $p['query'] ) || isset( $p['fragment'] ) ) {
			return false;
		}
		if ( 'https' === strtolower( (string) ( $p['scheme'] ?? '' ) ) ) {
			return true;
		}
		$host = strtolower( trim( $p['host'], '[]' ) );
		return 'http' === strtolower( (string) ( $p['scheme'] ?? '' ) )
			&& ( 'localhost' === $host || str_ends_with( $host, '.localhost' ) || '127.0.0.1' === $host || '::1' === $host );
	}

	/** Lower-cased host of the site, e.g. example.com */
	public static function host(): string {
		return strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) );
	}

	/** Bucket prefix for this site, e.g. sites/example.com */
	public static function prefix(): string {
		$p = trim( (string) self::get( 'prefix' ), '/' );
		return '' !== $p ? $p : 'sites/' . self::host();
	}

	/** @return string[] valid PCRE patterns (no delimiters). */
	public static function exclude_patterns(): array {
		$patterns = self::DEFAULT_EXCLUDES;
		foreach ( preg_split( '/\r\n|\r|\n/', (string) self::get( 'exclude' ) ) as $line ) {
			$line = trim( $line );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			if ( false === @preg_match( '~' . str_replace( '~', '\~', $line ) . '~u', '' ) ) {
				continue; // invalid pattern, ignore
			}
			$patterns[] = $line;
		}
		return apply_filters( 'lifeboat_exclude_patterns', $patterns );
	}
}
