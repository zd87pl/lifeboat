<?php
namespace Lifeboat;

use WP_Error;

/**
 * Minimal S3-compatible client for Cloudflare R2 (SigV4, path-style, region "auto").
 * No SDK dependency; uses the WordPress HTTP API.
 */
final class R2_Client {

	private string $host;
	private string $endpoint;
	private string $bucket;
	private string $key_id;
	private string $secret;
	private int $timeout;
	private int $retries = 3;

	public function __construct( string $account_id, string $bucket, string $key_id, string $secret, int $timeout = 60 ) {
		$this->host     = $account_id . '.r2.cloudflarestorage.com';
		$this->endpoint = 'https://' . $this->host;
		$this->bucket   = $bucket;
		$this->key_id   = $key_id;
		$this->secret   = $secret;
		$this->timeout  = $timeout;
	}

	public static function from_settings(): ?self {
		if ( ! Settings::r2_ready() ) {
			return null;
		}
		$s = Settings::all();
		return new self(
			$s['r2_account_id'],
			$s['r2_bucket'],
			$s['r2_access_key_id'],
			$s['r2_secret_access_key'],
			(int) apply_filters( 'lifeboat_r2_timeout', 60 )
		);
	}

	public function bucket(): string {
		return $this->bucket;
	}

	/** @param array<string,string> $meta stored as x-amz-meta-* (ASCII only; non-ASCII is percent-encoded). */
	public function put( string $key, string $body, string $content_type, array $meta = [] ): true|WP_Error {
		$headers = [ 'Content-Type' => $content_type ];
		foreach ( $meta as $k => $v ) {
			$headers[ 'x-amz-meta-' . $k ] = self::ascii( (string) $v );
		}
		$r = $this->request( 'PUT', $key, [], $body, $headers );
		return is_wp_error( $r ) ? $r : true;
	}

	public function get( string $key ): string|WP_Error {
		$r = $this->request( 'GET', $key );
		return is_wp_error( $r ) ? $r : $r['body'];
	}

	public function get_json( string $key ): array|WP_Error {
		$b = $this->get( $key );
		if ( is_wp_error( $b ) ) {
			return $b;
		}
		$d = json_decode( $b, true );
		return is_array( $d ) ? $d : new WP_Error( 'r2_bad_json', "Object $key is not valid JSON." );
	}

	public function exists( string $key ): bool {
		return ! is_wp_error( $this->request( 'HEAD', $key ) );
	}

	/** Server-side copy within the bucket (no re-upload). */
	public function copy( string $src_key, string $dst_key ): true|WP_Error {
		$r = $this->request(
			'PUT',
			$dst_key,
			[],
			'',
			[ 'x-amz-copy-source' => '/' . rawurlencode( $this->bucket ) . '/' . self::encode_key( $src_key ) ]
		);
		return is_wp_error( $r ) ? $r : true;
	}

	public function delete( string $key ): true|WP_Error {
		$r = $this->request( 'DELETE', $key );
		if ( is_wp_error( $r ) && 'not_found' === $r->get_error_code() ) {
			return true;
		}
		return is_wp_error( $r ) ? $r : true;
	}

	/** Multi-object delete, 1000 keys per request. */
	public function delete_many( array $keys ): true|WP_Error {
		foreach ( array_chunk( array_values( $keys ), 1000 ) as $chunk ) {
			$xml = '<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>';
			foreach ( $chunk as $k ) {
				$xml .= '<Object><Key>' . htmlspecialchars( (string) $k, ENT_XML1 | ENT_QUOTES, 'UTF-8' ) . '</Key></Object>';
			}
			$xml .= '</Delete>';
			$r    = $this->request(
				'POST',
				'',
				[ 'delete' => '' ],
				$xml,
				[
					'Content-Type' => 'application/xml',
					'Content-MD5'  => base64_encode( md5( $xml, true ) ),
				]
			);
			if ( is_wp_error( $r ) ) {
				return $r;
			}
			if ( false !== stripos( $r['body'], '<Error>' ) ) {
				return new WP_Error( 'r2_delete_partial', 'Some objects could not be deleted: ' . substr( $r['body'], 0, 500 ) );
			}
		}
		return true;
	}

	/**
	 * One page of ListObjectsV2.
	 * @return array{keys: array<int, array{key:string,size:int,etag:string}>, prefixes: string[], next: ?string}|WP_Error
	 */
	public function list( string $prefix, string $delimiter = '', ?string $token = null, int $max = 1000 ): array|WP_Error {
		$q = [
			'list-type' => '2',
			'prefix'    => $prefix,
			'max-keys'  => (string) $max,
		];
		if ( '' !== $delimiter ) {
			$q['delimiter'] = $delimiter;
		}
		if ( null !== $token ) {
			$q['continuation-token'] = $token;
		}
		$r = $this->request( 'GET', '', $q );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		// Regex parsing keeps us independent of the SimpleXML extension; the document is flat and machine-generated.
		$xml = $r['body'];
		if ( false === stripos( $xml, '<ListBucketResult' ) ) {
			return new WP_Error( 'r2_bad_xml', 'Unexpected ListObjectsV2 response.' );
		}
		$out = [
			'keys'     => [],
			'prefixes' => [],
			'next'     => null,
		];
		if ( preg_match_all( '#<Contents>(.*?)</Contents>#s', $xml, $blocks ) ) {
			foreach ( $blocks[1] as $block ) {
				$out['keys'][] = [
					'key'  => self::xml_text( $block, 'Key' ),
					'size' => (int) self::xml_text( $block, 'Size' ),
					'etag' => trim( self::xml_text( $block, 'ETag' ), '"' ),
				];
			}
		}
		if ( preg_match_all( '#<CommonPrefixes>\s*<Prefix>(.*?)</Prefix>\s*</CommonPrefixes>#s', $xml, $pm ) ) {
			foreach ( $pm[1] as $p ) {
				$out['prefixes'][] = html_entity_decode( $p, ENT_QUOTES | ENT_XML1, 'UTF-8' );
			}
		}
		if ( 'true' === self::xml_text( $xml, 'IsTruncated' ) && '' !== self::xml_text( $xml, 'NextContinuationToken' ) ) {
			$out['next'] = self::xml_text( $xml, 'NextContinuationToken' );
		}
		return $out;
	}

	/** @return string[]|WP_Error all keys under $prefix (capped at 250k). */
	public function list_all_keys( string $prefix ): array|WP_Error {
		$keys  = [];
		$token = null;
		do {
			$page = $this->list( $prefix, '', $token );
			if ( is_wp_error( $page ) ) {
				return $page;
			}
			foreach ( $page['keys'] as $k ) {
				$keys[] = $k['key'];
			}
			$token = $page['next'];
		} while ( null !== $token && count( $keys ) < 250000 );
		return $keys;
	}

	/** @return string[]|WP_Error immediate "sub-directories" under $prefix (which must end with "/"). */
	public function list_prefixes( string $prefix ): array|WP_Error {
		$prefixes = [];
		$token    = null;
		do {
			$page = $this->list( $prefix, '/', $token );
			if ( is_wp_error( $page ) ) {
				return $page;
			}
			$prefixes = array_merge( $prefixes, $page['prefixes'] );
			$token    = $page['next'];
		} while ( null !== $token );
		return $prefixes;
	}

	/**
	 * AWS Signature Version 4 for S3. Returns the headers to send (input headers + auth headers)
	 * and the query string pairs to append to the URL.
	 *
	 * @return array{headers: array<string,string>, query: string[]}
	 */
	public static function sign( string $method, string $host, string $path, array $query, array $headers, string $payload_hash, string $amz_date, string $region, string $key_id, string $secret ): array {
		$date  = substr( $amz_date, 0, 8 );
		$canon = [
			'host'                 => $host,
			'x-amz-content-sha256' => $payload_hash,
			'x-amz-date'           => $amz_date,
		];
		foreach ( $headers as $k => $v ) {
			$canon[ strtolower( $k ) ] = trim( preg_replace( '/\s+/', ' ', (string) $v ) );
		}
		ksort( $canon, SORT_STRING );
		$canon_headers = '';
		foreach ( $canon as $k => $v ) {
			$canon_headers .= "$k:$v\n";
		}
		$signed = implode( ';', array_keys( $canon ) );

		ksort( $query, SORT_STRING );
		$cq = [];
		$uq = [];
		foreach ( $query as $k => $v ) {
			$ek   = rawurlencode( (string) $k );
			$ev   = rawurlencode( (string) $v );
			$cq[] = "$ek=$ev";
			$uq[] = '' === (string) $v ? $ek : "$ek=$ev";
		}

		$creq  = implode( "\n", [ $method, $path, implode( '&', $cq ), $canon_headers, $signed, $payload_hash ] );
		$scope = "$date/$region/s3/aws4_request";
		$sts   = "AWS4-HMAC-SHA256\n$amz_date\n$scope\n" . hash( 'sha256', $creq );

		$k = hash_hmac( 'sha256', $date, 'AWS4' . $secret, true );
		foreach ( [ $region, 's3', 'aws4_request' ] as $part ) {
			$k = hash_hmac( 'sha256', $part, $k, true );
		}
		$signature = hash_hmac( 'sha256', $sts, $k );

		$send                         = $headers;
		$send['x-amz-content-sha256'] = $payload_hash;
		$send['x-amz-date']           = $amz_date;
		$send['Authorization']        = "AWS4-HMAC-SHA256 Credential=$key_id/$scope, SignedHeaders=$signed, Signature=$signature";

		return [
			'headers' => $send,
			'query'   => $uq,
		];
	}

	public static function encode_key( string $key ): string {
		return implode( '/', array_map( 'rawurlencode', explode( '/', $key ) ) );
	}

	private static function xml_text( string $xml, string $tag ): string {
		return preg_match( "#<$tag>(.*?)</$tag>#s", $xml, $m ) ? html_entity_decode( trim( $m[1] ), ENT_QUOTES | ENT_XML1, 'UTF-8' ) : '';
	}

	private static function ascii( string $v ): string {
		return preg_replace_callback( '/[^\x21-\x7E]/', static fn( $m ) => rawurlencode( $m[0] ), $v );
	}

	/**
	 * Signed request. $query values are raw (unencoded).
	 * @return array{status:int, headers:mixed, body:string}|WP_Error
	 */
	private function request( string $method, string $key, array $query = [], string $body = '', array $headers = [] ): array|WP_Error {
		$path   = '/' . rawurlencode( $this->bucket ) . ( '' !== $key ? '/' . self::encode_key( $key ) : '' );
		$signed = self::sign( $method, $this->host, $path, $query, $headers, hash( 'sha256', $body ), gmdate( 'Ymd\THis\Z' ), 'auto', $this->key_id, $this->secret );
		$send   = $signed['headers'];
		$uq     = $signed['query'];

		$url     = $this->endpoint . $path . ( $uq ? '?' . implode( '&', $uq ) : '' );
		$attempt = 0;
		$res     = null;
		$status  = 0;
		while ( true ) {
			$attempt++;
			$res    = wp_remote_request(
				$url,
				[
					'method'      => $method,
					'headers'     => $send,
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

		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'r2_transport', "R2 $method $key: " . $res->get_error_message() );
		}
		if ( $status >= 400 ) {
			$b    = (string) wp_remote_retrieve_body( $res );
			$code = preg_match( '#<Code>(.*?)</Code>#', $b, $m ) ? $m[1] : '';
			$msg  = preg_match( '#<Message>(.*?)</Message>#', $b, $m2 ) ? $m2[1] : '';
			return new WP_Error( 404 === $status ? 'not_found' : 'r2_http_' . $status, trim( "R2 $method $key: HTTP $status $code $msg" ) );
		}
		return [
			'status'  => $status,
			'headers' => wp_remote_retrieve_headers( $res ),
			'body'    => (string) wp_remote_retrieve_body( $res ),
		];
	}
}
