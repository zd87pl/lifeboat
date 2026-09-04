<?php
namespace Lifeboat;

use WP_Error;

/**
 * Fetches site paths from the origin (loopback preferred) and extracts links and asset references.
 */
final class Crawler {

	private const VAL = '(?:"([^"]*)"|\'([^\']*)\'|([^\s>"\']+))';

	private const TYPES = [
		'css'         => 'text/css',
		'js'          => 'application/javascript',
		'mjs'         => 'application/javascript',
		'map'         => 'application/json',
		'json'        => 'application/json',
		'webmanifest' => 'application/manifest+json',
		'xml'         => 'application/xml',
		'txt'         => 'text/plain',
		'vtt'         => 'text/vtt',
		'html'        => 'text/html',
		'htm'         => 'text/html',
		'svg'         => 'image/svg+xml',
		'png'         => 'image/png',
		'jpg'         => 'image/jpeg',
		'jpeg'        => 'image/jpeg',
		'gif'         => 'image/gif',
		'webp'        => 'image/webp',
		'avif'        => 'image/avif',
		'ico'         => 'image/x-icon',
		'woff'        => 'font/woff',
		'woff2'       => 'font/woff2',
		'ttf'         => 'font/ttf',
		'otf'         => 'font/otf',
		'eot'         => 'application/vnd.ms-fontobject',
		'pdf'         => 'application/pdf',
		'mp4'         => 'video/mp4',
		'webm'        => 'video/webm',
		'mp3'         => 'audio/mpeg',
		'ogg'         => 'audio/ogg',
		'wav'         => 'audio/wav',
		'wasm'        => 'application/wasm',
	];

	private string $host;
	private string $site_base;
	private string $origin_base;
	private bool $ssl_verify;
	private bool $forward_proto;
	private int $max_bytes;
	private string $secret;
	private int $timeout;

	public function __construct( array $s ) {
		$home = home_url( '/' );
		$p    = wp_parse_url( $home );

		$this->host          = strtolower( (string) ( $p['host'] ?? '' ) );
		$this->site_base     = ( $p['scheme'] ?? 'https' ) . '://' . ( $p['host'] ?? '' ) . ( isset( $p['port'] ) ? ':' . $p['port'] : '' );
		$this->origin_base   = rtrim( trim( (string) $s['origin_url'] ), '/' );
		$this->ssl_verify    = '' === $this->origin_base ? true : (bool) $s['origin_ssl_verify'];
		$this->forward_proto = '' !== $this->origin_base && 0 === stripos( $this->origin_base, 'http://' ) && 0 === stripos( $home, 'https://' );
		$this->max_bytes     = max( 1, (int) $s['max_asset_mb'] ) * MB_IN_BYTES;
		$this->secret        = (string) $s['crawl_secret'];
		$this->timeout       = (int) apply_filters( 'lifeboat_fetch_timeout', 60 );
	}

	public function site_base(): string {
		return $this->site_base;
	}

	public function host(): string {
		return $this->host;
	}

	/**
	 * Fetch a decoded site path as an anonymous visitor, without following redirects.
	 * @return array{status:int,type:string,body:string,location:?string,truncated:bool}|WP_Error
	 */
	public function fetch( string $path ): array|WP_Error {
		$enc     = Keys::encode_path( $path );
		$headers = [
			'Accept'           => '*/*',
			'X-Lifeboat-Crawl' => '' !== $this->secret ? $this->secret : '1',
		];
		if ( '' !== $this->origin_base ) {
			$url             = $this->origin_base . $enc;
			$headers['Host'] = $this->host;
			if ( $this->forward_proto ) {
				$headers['X-Forwarded-Proto'] = 'https';
			}
		} else {
			$url = $this->site_base . $enc;
		}

		$args = [
			'timeout'             => $this->timeout,
			'redirection'         => 0,
			'headers'             => $headers,
			'sslverify'           => $this->ssl_verify,
			'limit_response_size' => $this->max_bytes + 1,
			'decompress'          => true,
			'user-agent'          => 'Lifeboat/' . LIFEBOAT_VERSION . ' (+static snapshot crawler)',
		];
		$res  = wp_remote_get( $url, apply_filters( 'lifeboat_fetch_args', $args, $path ) );
		if ( is_wp_error( $res ) ) {
			return $res;
		}

		$snapshot = self::header( $res, 'x-lifeboat' );
		if ( '' !== $snapshot ) {
			return new WP_Error(
				'lifeboat_fallback',
				"Responses are being served from the fallback snapshot ($snapshot), not from WordPress. Set LIFEBOAT_ORIGIN_URL so the crawler reaches the origin directly."
			);
		}

		$body = (string) wp_remote_retrieve_body( $res );
		return [
			'status'    => (int) wp_remote_retrieve_response_code( $res ),
			'type'      => self::header( $res, 'content-type' ),
			'body'      => $body,
			'location'  => self::header( $res, 'location' ) ?: null,
			'truncated' => strlen( $body ) > $this->max_bytes,
		];
	}

	private static function header( $res, string $name ): string {
		$h = wp_remote_retrieve_header( $res, $name );
		if ( is_array( $h ) ) {
			$h = reset( $h );
		}
		return is_string( $h ) ? trim( $h ) : '';
	}

	public static function is_html( string $type ): bool {
		return 0 === stripos( $type, 'text/html' ) || 0 === stripos( $type, 'application/xhtml' );
	}

	public static function is_css( string $type ): bool {
		return 0 === stripos( $type, 'text/css' );
	}

	public static function is_xml( string $type ): bool {
		return false !== stripos( $type, 'xml' );
	}

	public static function guess_type( string $path ): string {
		$ext = strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
		return self::TYPES[ $ext ] ?? 'application/octet-stream';
	}

	/**
	 * @return array{links: string[], assets: string[]} absolute URLs found in an HTML document.
	 */
	public function extract_from_html( string $html, string $base ): array {
		$links  = [];
		$assets = [];

		foreach ( self::grab( '#<(?:a|area)\b[^>]*?\bhref\s*=\s*' . self::VAL . '#i', $html ) as $r ) {
			$links[] = $r;
		}

		// <link> tags: only rel values that reference renderable assets.
		if ( preg_match_all( '#<link\b[^>]*>#i', $html, $lm ) ) {
			foreach ( $lm[0] as $tag ) {
				if ( ! preg_match( '#\brel\s*=\s*' . self::VAL . '#i', $tag, $rm ) ) {
					continue;
				}
				$rel = strtolower( self::first( $rm ) );
				if ( ! preg_match( '#(?:^|\s)(?:stylesheet|icon|apple-touch-icon|preload|modulepreload|prefetch|manifest|mask-icon)(?:\s|$)#', $rel ) ) {
					continue;
				}
				if ( preg_match( '#\bhref\s*=\s*' . self::VAL . '#i', $tag, $hm ) ) {
					$assets[] = self::first( $hm );
				}
			}
		}

		foreach ( self::grab( '#\b(?:src|poster|data-src|data-lazy-src|data-bg|data-background|data-large_image|data-thumb)\s*=\s*' . self::VAL . '#i', $html ) as $r ) {
			$assets[] = $r;
		}

		if ( preg_match_all( '#\b(?:srcset|data-srcset|data-lazy-srcset)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')#i', $html, $sm, PREG_SET_ORDER ) ) {
			foreach ( $sm as $x ) {
				foreach ( explode( ',', self::first( $x ) ) as $cand ) {
					$cand = trim( $cand );
					if ( '' !== $cand ) {
						$assets[] = preg_split( '/\s+/', $cand )[0];
					}
				}
			}
		}

		// Inline style attributes and <style> blocks.
		foreach ( $this->extract_from_css( $html ) as $r ) {
			$assets[] = $r;
		}

		$abs = static function ( array $list ) use ( $base ): array {
			$out = [];
			foreach ( $list as $ref ) {
				$u = Keys::absolutize( $ref, $base );
				if ( null !== $u ) {
					$out[ $u ] = 1;
				}
			}
			return array_keys( $out );
		};

		return [
			'links'  => $abs( $links ),
			'assets' => $abs( $assets ),
		];
	}

	/** @return string[] raw (non-absolutized) references from CSS text. */
	public function extract_from_css( string $css ): array {
		$out = [];
		if ( preg_match_all( '#url\(\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s)"\']+))\s*\)#i', $css, $m, PREG_SET_ORDER ) ) {
			foreach ( $m as $x ) {
				$out[] = self::first( $x );
			}
		}
		if ( preg_match_all( '#@import\s+(?!url\()["\']([^"\']+)["\']#i', $css, $m2 ) ) {
			foreach ( $m2[1] as $ref ) {
				$out[] = $ref;
			}
		}
		return array_values( array_unique( array_filter( $out, static fn( $r ) => '' !== trim( $r ) ) ) );
	}

	/** @return string[] absolute <loc> URLs if $xml is a sitemap or sitemap index. */
	public static function extract_sitemap_locs( string $xml ): array {
		if ( false === stripos( $xml, '<urlset' ) && false === stripos( $xml, '<sitemapindex' ) ) {
			return [];
		}
		if ( ! preg_match_all( '#<loc>\s*(.*?)\s*</loc>#is', $xml, $m ) ) {
			return [];
		}
		return array_values( array_unique( array_map( static fn( $u ) => trim( html_entity_decode( $u, ENT_QUOTES | ENT_XML1, 'UTF-8' ) ), $m[1] ) ) );
	}

	/** Run a VAL-style regex and return the captured value of each match. */
	private static function grab( string $re, string $subject ): array {
		$out = [];
		if ( preg_match_all( $re, $subject, $m, PREG_SET_ORDER ) ) {
			foreach ( $m as $x ) {
				$out[] = self::first( $x );
			}
		}
		return $out;
	}

	/** First non-empty capture group of a VAL match. */
	private static function first( array $m ): string {
		foreach ( [ 1, 2, 3 ] as $i ) {
			if ( isset( $m[ $i ] ) && '' !== $m[ $i ] ) {
				return $m[ $i ];
			}
		}
		return '';
	}
}
