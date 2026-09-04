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
	];

	public const CHECKBOXES = [ 'origin_ssl_verify', 'use_wp_cron', 'incremental' ];

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
