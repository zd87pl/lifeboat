<?php
namespace Lifeboat;

use WP_Error;

/**
 * Where snapshots are written: straight to a Cloudflare R2 bucket (R2_Client) or through a hosted
 * Lifeboat service that confines this site to its own prefix (Service_Client). Keys are always the
 * full bucket keys described in the README, e.g. sites/example.com/current.json.
 */
interface Storage_Client {

	/** Human-readable description for status screens, e.g. "Cloudflare R2 bucket wp-lifeboat". */
	public function label(): string;

	/**
	 * Write/read/delete a probe object below $prefix and report what the store holds for this site.
	 * @return string|WP_Error a success message
	 */
	public function check( string $prefix ): string|WP_Error;

	/** @param array<string,string> $meta custom object metadata (ASCII only; the rest is percent-encoded). */
	public function put( string $key, string $body, string $content_type, array $meta = [], string $cache_control = '' ): bool|WP_Error;

	public function get( string $key ): string|WP_Error;

	public function get_json( string $key ): array|WP_Error;

	public function exists( string $key ): bool;

	/** Copy within the store, metadata included, without re-uploading the body. */
	public function copy( string $src_key, string $dst_key ): bool|WP_Error;

	public function delete( string $key ): bool|WP_Error;

	public function delete_many( array $keys ): bool|WP_Error;

	/**
	 * One page of a listing.
	 * @return array{keys: array<int, array{key:string,size:int,etag:string}>, prefixes: string[], next: ?string}|WP_Error
	 */
	public function list( string $prefix, string $delimiter = '', ?string $token = null, int $max = 1000 ): array|WP_Error;

	/** @return string[]|WP_Error all keys under $prefix (capped at 250k). */
	public function list_all_keys( string $prefix ): array|WP_Error;

	/** @return string[]|WP_Error immediate "sub-directories" under $prefix (which must end with "/"). */
	public function list_prefixes( string $prefix ): array|WP_Error;
}
