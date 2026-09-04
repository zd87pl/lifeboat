<?php
namespace Lifeboat;

/**
 * URL normalisation and path → object key mapping.
 *
 * "Site path" throughout the plugin means the percent-DECODED path from the domain root,
 * with no query string or fragment (e.g. "/o-nas/łódź/"). The Worker must apply the same
 * mapping (decodeURIComponent(url.pathname) → key) — see README.
 */
final class Keys {

	public const ASSET_EXT = [
		'css', 'js', 'mjs', 'map', 'json', 'xml', 'txt', 'ico', 'webmanifest', 'wasm', 'vtt',
		'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'tif', 'tiff',
		'woff', 'woff2', 'ttf', 'otf', 'eot',
		'mp3', 'mp4', 'm4a', 'm4v', 'webm', 'ogg', 'ogv', 'wav',
		'pdf', 'zip', 'gz', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
	];

	/** Resolve a reference found in HTML/CSS against its base URL. Returns an absolute http(s) URL or null. */
	public static function absolutize( string $ref, string $base ): ?string {
		$ref = trim( html_entity_decode( $ref, ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
		if ( '' === $ref || '#' === $ref[0] ) {
			return null;
		}
		if ( preg_match( '#^[a-z][a-z0-9+.-]*:#i', $ref ) && ! preg_match( '#^https?:#i', $ref ) ) {
			return null; // data:, mailto:, javascript:, tel: …
		}
		if ( 0 === strpos( $ref, '//' ) ) {
			$ref = ( (string) wp_parse_url( $base, PHP_URL_SCHEME ) ?: 'https' ) . ':' . $ref;
		}
		if ( preg_match( '#^https?://#i', $ref ) ) {
			return $ref;
		}
		$b = wp_parse_url( $base );
		if ( ! is_array( $b ) || empty( $b['host'] ) ) {
			return null;
		}
		$origin = ( $b['scheme'] ?? 'https' ) . '://' . $b['host'] . ( isset( $b['port'] ) ? ':' . $b['port'] : '' );
		$path   = $b['path'] ?? '/';
		if ( '/' === $ref[0] ) {
			return $origin . $ref;
		}
		if ( '?' === $ref[0] ) {
			return $origin . $path . $ref;
		}
		$dir = substr( $path, 0, (int) strrpos( $path, '/' ) + 1 );
		return $origin . self::resolve_dots( $dir . $ref );
	}

	/** Collapse "." and ".." segments. Keeps a trailing slash. */
	public static function resolve_dots( string $path ): string {
		$trailing = '' !== $path && ( '/' === substr( $path, -1 ) || '/.' === substr( $path, -2 ) || '/..' === substr( $path, -3 ) );
		$out      = [];
		foreach ( explode( '/', $path ) as $seg ) {
			if ( '' === $seg || '.' === $seg ) {
				continue;
			}
			if ( '..' === $seg ) {
				array_pop( $out );
				continue;
			}
			$out[] = $seg;
		}
		$p = '/' . implode( '/', $out );
		if ( $trailing && $out ) {
			$p .= '/';
		}
		return $p;
	}

	/** Decoded site path if $url is on $host (any scheme/port), otherwise null. */
	public static function to_site_path( string $url, string $host ): ?string {
		$p = wp_parse_url( $url );
		if ( ! is_array( $p ) || empty( $p['host'] ) || strtolower( $p['host'] ) !== $host ) {
			return null;
		}
		$path = rawurldecode( $p['path'] ?? '/' );
		return self::resolve_dots( '' === $path ? '/' : $path );
	}

	/** Re-encode a decoded site path for the wire. */
	public static function encode_path( string $path ): string {
		return implode( '/', array_map( 'rawurlencode', explode( '/', $path ) ) );
	}

	public static function has_query( string $url ): bool {
		return false !== strpos( $url, '?' );
	}

	public static function is_asset_path( string $path ): bool {
		if ( preg_match( '#^/wp-(content|includes)/#', $path ) ) {
			return '.php' !== substr( $path, -4 );
		}
		$ext = strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
		return '' !== $ext && in_array( $ext, self::ASSET_EXT, true );
	}

	/**
	 * Map a decoded site path to an object key. Mirrors the Worker:
	 *   /              → index.html
	 *   /about/        → about/index.html
	 *   /about         → about/index.html   (no dot in last segment)
	 *   /a/b.css       → a/b.css
	 */
	public static function path_to_key( string $path ): string {
		$path = '/' . ltrim( $path, '/' );
		if ( '/' === $path ) {
			return 'index.html';
		}
		if ( '/' === substr( $path, -1 ) ) {
			return ltrim( $path, '/' ) . 'index.html';
		}
		$last = substr( $path, (int) strrpos( $path, '/' ) + 1 );
		if ( false === strpos( $last, '.' ) ) {
			return ltrim( $path, '/' ) . '/index.html';
		}
		return ltrim( $path, '/' );
	}

	public static function excluded( string $path, array $patterns ): bool {
		foreach ( $patterns as $re ) {
			if ( preg_match( '~' . str_replace( '~', '\~', $re ) . '~u', $path ) ) {
				return true;
			}
		}
		return false;
	}
}
