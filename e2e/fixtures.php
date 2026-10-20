<?php
/**
 * Plugin Name: Lifeboat e2e fixtures
 * Description: Test-only behavior for e2e/run.sh. Never install this on a real site.
 */

// The origin marks this page uncacheable, as WooCommerce does for cart, checkout and account pages.
add_action(
	'template_redirect',
	static function (): void {
		if ( is_page( 'private-page' ) ) {
			nocache_headers();
		}
	}
);
