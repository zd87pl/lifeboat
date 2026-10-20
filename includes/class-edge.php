<?php
namespace Lifeboat;

/**
 * Makes WordPress accept requests the Lifeboat Worker forwards to the origin.
 *
 * The Worker reaches the origin through the origin's own hostname and reports the public one in
 * X-Forwarded-Host/Proto. Without this, redirect_canonical() would answer every forwarded request
 * with a redirect back to the public hostname, which the Worker would relay: an endless loop.
 *
 * - The host and scheme are adopted only when X-Forwarded-Host names this site's own home host,
 *   so a client can at most make WordPress treat a request as one for its canonical address.
 * - With an edge secret configured, the Worker must also prove itself with X-Lifeboat-Edge; only
 *   then is X-Lifeboat-Client-IP used as REMOTE_ADDR (comments, rate limits and login throttling
 *   would otherwise see one Cloudflare address for every visitor).
 */
final class Edge {

	/** Runs while the plugin file loads: before WordPress parses the request or redirects canonically. */
	public static function trust_forwarded_request(): void {
		if ( empty( $_SERVER['HTTP_X_FORWARDED_HOST'] ) && empty( $_SERVER['HTTP_X_LIFEBOAT_EDGE'] ) ) {
			return;
		}
		$s        = Settings::all();
		$secret   = (string) $s['edge_secret'];
		$given    = isset( $_SERVER['HTTP_X_LIFEBOAT_EDGE'] ) ? (string) $_SERVER['HTTP_X_LIFEBOAT_EDGE'] : '';
		$verified = '' !== $secret && '' !== $given && hash_equals( $secret, $given );

		if ( $s['trust_edge_host'] && ( '' === $secret || $verified ) ) {
			self::adopt_forwarded_host();
		}
		if ( $verified ) {
			$ip = isset( $_SERVER['HTTP_X_LIFEBOAT_CLIENT_IP'] ) ? trim( (string) $_SERVER['HTTP_X_LIFEBOAT_CLIENT_IP'] ) : '';
			if ( false !== filter_var( $ip, FILTER_VALIDATE_IP ) ) {
				$_SERVER['REMOTE_ADDR'] = $ip;
			}
		}
	}

	private static function adopt_forwarded_host(): void {
		$home = wp_parse_url( (string) get_option( 'home' ) );
		if ( ! is_array( $home ) || empty( $home['host'] ) ) {
			return;
		}
		$expected  = strtolower( $home['host'] ) . ( isset( $home['port'] ) ? ':' . $home['port'] : '' );
		$forwarded = strtolower( trim( explode( ',', (string) ( $_SERVER['HTTP_X_FORWARDED_HOST'] ?? '' ) )[0] ) );
		if ( $forwarded !== $expected ) {
			return;
		}
		$_SERVER['HTTP_HOST']   = $expected;
		$_SERVER['SERVER_NAME'] = strtolower( $home['host'] );

		$proto = strtolower( trim( explode( ',', (string) ( $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '' ) )[0] ) );
		if ( 'https' === $proto && 'https' === strtolower( (string) ( $home['scheme'] ?? '' ) ) ) {
			$_SERVER['HTTPS']       = 'on';
			$_SERVER['SERVER_PORT'] = (string) ( $home['port'] ?? 443 );
		}
	}
}
