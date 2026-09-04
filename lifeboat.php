<?php
/**
 * Plugin Name:       Lifeboat — static failover snapshots for Cloudflare R2
 * Description:       Publishes a static snapshot of this site to Cloudflare R2 on a schedule and on publish, so a Cloudflare Worker can serve it when the origin is down.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      8.0
 * License:           MIT
 * Text Domain:       lifeboat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'LIFEBOAT_VERSION', '1.0.0' );
define( 'LIFEBOAT_FILE', __FILE__ );
define( 'LIFEBOAT_DIR', plugin_dir_path( __FILE__ ) );

spl_autoload_register(
	static function ( string $class ): void {
		if ( 0 !== strncmp( $class, 'Lifeboat\\', 9 ) ) {
			return;
		}
		$file = LIFEBOAT_DIR . 'includes/class-' . strtolower( str_replace( '_', '-', substr( $class, 9 ) ) ) . '.php';
		if ( is_file( $file ) ) {
			require $file;
		}
	}
);

register_activation_hook( __FILE__, [ 'Lifeboat\\Plugin', 'activate' ] );
register_deactivation_hook( __FILE__, [ 'Lifeboat\\Plugin', 'deactivate' ] );

add_action(
	'plugins_loaded',
	static function (): void {
		\Lifeboat\Plugin::instance()->boot();
	}
);
