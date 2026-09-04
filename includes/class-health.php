<?php
namespace Lifeboat;

/**
 * GET /wp-json/lifeboat/v1/health → 200 when WordPress and its database respond, 503 otherwise.
 * The Worker's scheduled probe uses this to open/close the circuit breaker; it lives under
 * /wp-json/ so the Worker always passes it through to the origin.
 */
final class Health {

	public static function register(): void {
		register_rest_route(
			'lifeboat/v1',
			'/health',
			[
				'methods'             => 'GET',
				'callback'            => [ self::class, 'check' ],
				'permission_callback' => '__return_true',
			]
		);
	}

	public static function check(): \WP_REST_Response {
		global $wpdb;

		$db = false;
		try {
			$db = $wpdb->check_connection( false ) && '1' === (string) $wpdb->get_var( 'SELECT 1' );
		} catch ( \Throwable $e ) {
			$db = false;
		}
		$ok   = (bool) apply_filters( 'lifeboat_health_ok', $db );
		$last = Snapshot_Builder::last_snapshot();
		$job  = Snapshot_Builder::current_job();

		$body = [
			'ok'       => $ok,
			'checks'   => [ 'db' => $db ],
			'snapshot' => $last ? [
				'id'         => $last['id'],
				'updated_at' => gmdate( 'c', (int) $last['updated_at'] ),
				'age_s'      => time() - (int) $last['updated_at'],
			] : null,
			'building' => $job ? [
				'kind'      => $job['kind'],
				'processed' => $job['processed'],
				'remaining' => count( $job['queue'] ),
			] : null,
			'time'     => gmdate( 'c' ),
		];

		$response = new \WP_REST_Response( $body, $ok ? 200 : 503 );
		$response->header( 'Cache-Control', 'no-store, max-age=0' );
		$response->header( 'X-Lifeboat-Health', $ok ? 'ok' : 'fail' );
		return $response;
	}
}
