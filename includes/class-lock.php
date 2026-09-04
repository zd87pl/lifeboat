<?php
namespace Lifeboat;

/**
 * Atomic lock stored as an options row (plain INSERT fails on the unique option_name),
 * bypassing the object cache so it is safe across WP-Cron, WP-CLI and multiple web nodes.
 */
final class Lock {

	private static function key( string $name ): string {
		return 'lifeboat_lock_' . $name;
	}

	public static function acquire( string $name, int $ttl ): bool {
		global $wpdb;
		$key = self::key( $name );
		$now = time();

		$prev = $wpdb->suppress_errors( true );
		$ok   = $wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
				$key,
				(string) ( $now + $ttl )
			)
		);
		$wpdb->suppress_errors( $prev );
		if ( $ok ) {
			return true;
		}

		// Row exists: take it over only if the holder's TTL has expired (compare-and-swap).
		$exp = (int) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key ) );
		if ( $exp > 0 && $exp < $now ) {
			$wpdb->query(
				$wpdb->prepare(
					"UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
					(string) ( $now + $ttl ),
					$key,
					(string) $exp
				)
			);
			return 1 === (int) $wpdb->rows_affected;
		}
		return false;
	}

	public static function refresh( string $name, int $ttl ): void {
		global $wpdb;
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s",
				(string) ( time() + $ttl ),
				self::key( $name )
			)
		);
	}

	public static function release( string $name ): void {
		global $wpdb;
		$wpdb->delete( $wpdb->options, [ 'option_name' => self::key( $name ) ] );
		wp_cache_delete( self::key( $name ), 'options' );
	}

	public static function held( string $name ): bool {
		global $wpdb;
		$exp = (int) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::key( $name ) ) );
		return $exp >= time();
	}
}
