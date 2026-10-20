<?php
namespace Lifeboat;

use WP_Error;

/**
 * Client for a hosted Lifeboat edge service. It performs the same object operations as R2_Client
 * through the service's ingest API (see worker/src/index.js), authenticated with this site's own
 * key. The service confines every key to the site's prefix, so a compromised site can never write
 * another site's snapshot, and the site never holds bucket-wide storage credentials.
 */
final class Service_Client implements Storage_Client {

	use Storage_Helpers;

	private string $base;
	private string $site;
	private string $key;
	private int $timeout;
	private int $retries = 3;

	public function __construct( string $base_url, string $site, string $key, int $timeout = 60 ) {
		$this->base    = rtrim( $base_url, '/' );
		$this->site    = $site;
		$this->key     = $key;
		$this->timeout = $timeout;
	}

	public static function from_settings(): ?self {
		if ( ! Settings::service_ready() ) {
			return null;
		}
		$s = Settings::all();
		return new self( $s['service_url'], Settings::host(), $s['service_key'], (int) apply_filters( 'lifeboat_r2_timeout', 60 ) );
	}

	public function label(): string {
		return 'Lifeboat service ' . (string) wp_parse_url( $this->base, PHP_URL_HOST );
	}

	/** @return array{host:string,prefix:string,mode:string,ai:string}|WP_Error what the service holds for this site. */
	public function site_info(): array|WP_Error {
		$r = $this->request( 'GET', '/v1/site' );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		$d = json_decode( $r['body'], true );
		if ( ! is_array( $d ) || ! isset( $d['host'], $d['prefix'], $d['mode'], $d['ai'] ) ) {
			return new WP_Error( 'service_bad_json', 'Unexpected answer from the Lifeboat service.' );
		}
		return $d;
	}

	public function check( string $prefix ): string|WP_Error {
		$info = $this->site_info();
		if ( is_wp_error( $info ) ) {
			return $info;
		}
		if ( $info['prefix'] !== $prefix ) {
			return new WP_Error(
				'service_prefix',
				sprintf( 'The service stores %s under %s, but this site writes to %s. Define LIFEBOAT_PREFIX as %s.', $info['host'], $info['prefix'], $prefix, $info['prefix'] )
			);
		}
		$r = $this->probe_roundtrip( $prefix );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		return sprintf( '%s: write/read/delete OK for %s (edge mode: %s, AI crawlers: %s).', $this->label(), $info['host'], $info['mode'], $info['ai'] );
	}

	/** @param array<string,string> $meta custom metadata (ASCII only; non-ASCII is percent-encoded). */
	public function put( string $key, string $body, string $content_type, array $meta = [], string $cache_control = '' ): bool|WP_Error {
		$headers = [
			'Content-Type'   => $content_type,
			// Sent explicitly so an empty object is still a well-formed upload.
			'Content-Length' => (string) strlen( $body ),
		];
		if ( '' !== $cache_control ) {
			$headers['Cache-Control'] = $cache_control;
		}
		if ( $meta ) {
			$ascii = [];
			foreach ( $meta as $k => $v ) {
				$ascii[ (string) $k ] = self::ascii( (string) $v );
			}
			$headers['X-Lifeboat-Metadata'] = (string) wp_json_encode( $ascii );
		}
		$r = $this->request( 'PUT', '/v1/object', [ 'key' => $key ], $body, $headers );
		return is_wp_error( $r ) ? $r : true;
	}

	public function get( string $key ): string|WP_Error {
		$r = $this->request( 'GET', '/v1/object', [ 'key' => $key ] );
		return is_wp_error( $r ) ? $r : $r['body'];
	}

	public function exists( string $key ): bool {
		return ! is_wp_error( $this->request( 'HEAD', '/v1/object', [ 'key' => $key ] ) );
	}

	public function copy( string $src_key, string $dst_key ): bool|WP_Error {
		$r = $this->post_json( '/v1/copy', [ 'from' => $src_key, 'to' => $dst_key ] );
		return is_wp_error( $r ) ? $r : true;
	}

	public function delete( string $key ): bool|WP_Error {
		$r = $this->request( 'DELETE', '/v1/object', [ 'key' => $key ] );
		return is_wp_error( $r ) ? $r : true;
	}

	public function delete_many( array $keys ): bool|WP_Error {
		foreach ( array_chunk( array_values( $keys ), 1000 ) as $chunk ) {
			$r = $this->post_json( '/v1/delete', [ 'keys' => array_map( 'strval', $chunk ) ] );
			if ( is_wp_error( $r ) ) {
				return $r;
			}
		}
		return true;
	}

	public function list( string $prefix, string $delimiter = '', ?string $token = null, int $max = 1000 ): array|WP_Error {
		$q = [
			'prefix' => $prefix,
			'limit'  => (string) $max,
		];
		if ( '' !== $delimiter ) {
			$q['delimiter'] = $delimiter;
		}
		if ( null !== $token ) {
			$q['cursor'] = $token;
		}
		$r = $this->request( 'GET', '/v1/list', $q );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		$d = json_decode( $r['body'], true );
		if ( ! is_array( $d ) || ! isset( $d['keys'], $d['prefixes'] ) || ! is_array( $d['keys'] ) || ! is_array( $d['prefixes'] ) ) {
			return new WP_Error( 'service_bad_json', 'Unexpected listing from the Lifeboat service.' );
		}
		$out = [
			'keys'     => [],
			'prefixes' => array_map( 'strval', $d['prefixes'] ),
			'next'     => isset( $d['next'] ) && is_string( $d['next'] ) && '' !== $d['next'] ? $d['next'] : null,
		];
		foreach ( $d['keys'] as $k ) {
			$out['keys'][] = [
				'key'  => (string) ( $k['key'] ?? '' ),
				'size' => (int) ( $k['size'] ?? 0 ),
				'etag' => (string) ( $k['etag'] ?? '' ),
			];
		}
		return $out;
	}

	private function post_json( string $path, array $payload ): array|WP_Error {
		$body = (string) wp_json_encode( $payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		return $this->request(
			'POST',
			$path,
			[],
			$body,
			[
				'Content-Type'   => 'application/json',
				'Content-Length' => (string) strlen( $body ),
			]
		);
	}

	/**
	 * Authenticated request with the same retry policy as R2_Client. $query values are raw.
	 * @return array{status:int, body:string}|WP_Error
	 */
	private function request( string $method, string $path, array $query = [], string $body = '', array $headers = [] ): array|WP_Error {
		$url                        = $this->base . $path . ( $query ? '?' . http_build_query( $query, '', '&', PHP_QUERY_RFC3986 ) : '' );
		$headers['Authorization']   = 'Bearer ' . $this->key;
		$headers['X-Lifeboat-Site'] = $this->site;

		$attempt = 0;
		$res     = null;
		$status  = 0;
		while ( true ) {
			$attempt++;
			$res    = wp_remote_request(
				$url,
				[
					'method'      => $method,
					'headers'     => $headers,
					'body'        => $body,
					'timeout'     => $this->timeout,
					'redirection' => 0,
					'sslverify'   => true,
					'user-agent'  => 'Lifeboat/' . LIFEBOAT_VERSION,
				]
			);
			$status = is_wp_error( $res ) ? 0 : (int) wp_remote_retrieve_response_code( $res );
			if ( ! ( is_wp_error( $res ) || $status >= 500 || 429 === $status ) || $attempt >= $this->retries ) {
				break;
			}
			usleep( 250000 * ( 2 ** ( $attempt - 1 ) ) );
		}

		$what = $query['key'] ?? $path;
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'service_transport', "Lifeboat service $method $what: " . $res->get_error_message() );
		}
		if ( $status >= 400 ) {
			$d   = json_decode( (string) wp_remote_retrieve_body( $res ), true );
			$msg = is_array( $d ) && isset( $d['error'] ) && is_string( $d['error'] ) ? $d['error'] : '';
			return new WP_Error( 404 === $status ? 'not_found' : 'service_http_' . $status, trim( "Lifeboat service $method $what: HTTP $status $msg" ) );
		}
		return [
			'status' => $status,
			'body'   => (string) wp_remote_retrieve_body( $res ),
		];
	}
}
