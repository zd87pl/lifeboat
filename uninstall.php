<?php
/**
 * Removes Lifeboat's options and scheduled events. Objects in R2 are left in place.
 */
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

foreach ( [
	'lifeboat_settings',
	'lifeboat_job',
	'lifeboat_prev_manifest',
	'lifeboat_last_snapshot',
	'lifeboat_last_result',
	'lifeboat_pending',
	'lifeboat_lock_build',
] as $option ) {
	delete_option( $option );
}

foreach ( [ 'lifeboat_scheduled_build', 'lifeboat_full_rebuild', 'lifeboat_run_job', 'lifeboat_incremental' ] as $hook ) {
	wp_clear_scheduled_hook( $hook );
}
