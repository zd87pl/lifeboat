<?php
/**
 * An incremental update in which one storage call fails must still publish what it did change, or
 * the edge would keep serving copies it replaced or removed. Run by e2e/run.sh through
 * `wp eval-file partial-incremental.php <path to delete> <path whose deletion is made to fail>`.
 */
[ $gone, $failing ] = $args;
$storage = Lifeboat\Settings::storage();
$pointer = Lifeboat\Settings::prefix() . '/current.json';
$before  = $storage->get_json( $pointer );

$failing_key = '/' . Lifeboat\Keys::path_to_key( $failing );
$inject      = static function ( $pre, $request, $url ) use ( $failing_key ) {
	$query = rawurldecode( (string) wp_parse_url( $url, PHP_URL_QUERY ) );
	if ( 'DELETE' !== $request['method'] || ! str_ends_with( $query, $failing_key ) ) {
		return $pre;
	}
	return [
		'headers'  => [],
		'body'     => '{"error":"injected failure"}',
		'response' => [
			'code'    => 500,
			'message' => '',
		],
		'cookies'  => [],
		'filename' => null,
	];
};
add_filter( 'pre_http_request', $inject, 10, 3 );
$builder = new Lifeboat\Snapshot_Builder();
$job     = $builder->start_incremental( [], [ $gone, $failing ] );
$result  = is_wp_error( $job ) ? $job : $builder->run( 120 );
remove_filter( 'pre_http_request', $inject, 10 );

$after = $storage->get_json( $pointer );
echo wp_json_encode(
	[
		'job_ok'         => is_wp_error( $result ) ? $result->get_error_message() : $result['ok'],
		'revision_moved' => ( $before['revision'] ?? '' ) !== ( $after['revision'] ?? '' ),
		'pages_before'   => $before['counts']['pages'],
		'pages_after'    => $after['counts']['pages'],
	]
) . "\n";
