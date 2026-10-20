<?php
namespace Lifeboat;

use WP_Error;

/**
 * Operations every Storage_Client builds the same way from its primitives (get, put, delete, list).
 */
trait Storage_Helpers {

	public function get_json( string $key ): array|WP_Error {
		$b = $this->get( $key );
		if ( is_wp_error( $b ) ) {
			return $b;
		}
		$d = json_decode( $b, true );
		return is_array( $d ) ? $d : new WP_Error( 'storage_bad_json', "Object $key is not valid JSON." );
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

	/** Write, read back and delete a probe object below $prefix. */
	private function probe_roundtrip( string $prefix ): bool|WP_Error {
		$key = $prefix . '/__lifeboat-probe.txt';
		$r   = $this->put( $key, 'ok ' . gmdate( 'c' ), 'text/plain' );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		$b = $this->get( $key );
		$this->delete( $key );
		return is_wp_error( $b ) ? $b : true;
	}

	/** Object metadata must be ASCII (S3 x-amz-meta-* rules); percent-encode everything else. */
	private static function ascii( string $v ): string {
		return preg_replace_callback( '/[^\x21-\x7E]/', static fn( $m ) => rawurlencode( $m[0] ), $v );
	}
}
