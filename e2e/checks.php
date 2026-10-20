<?php
/**
 * Plugin checks that need a WordPress runtime but no HTTP traffic. Run by e2e/run.sh through
 * `wp eval-file e2e/checks.php <key-parity-output.json>`.
 */

$failures = 0;
$check    = static function ( bool $ok, string $label ) use ( &$failures ): void {
	echo ( $ok ? '  ok    ' : '  FAIL  ' ) . $label . "\n";
	if ( ! $ok ) {
		$failures++;
	}
};

echo "Crawler cache intent\n";
$check( Lifeboat\Crawler::is_private( 'no-cache, must-revalidate, max-age=0, no-store, private', false ), 'WordPress nocache_headers() is private' );
$check( Lifeboat\Crawler::is_private( '', true ), 'a Set-Cookie response is private' );
$check( Lifeboat\Crawler::is_private( 'no-cache="Set-Cookie"', false ), 'a field-scoped no-cache is private' );
$check( ! Lifeboat\Crawler::is_private( 'public, max-age=600', false ), 'public, max-age is shareable' );
$check( ! Lifeboat\Crawler::is_private( 'max-age=0, must-revalidate', false ), 'max-age=0 alone is shareable' );
$check( ! Lifeboat\Crawler::is_private( '', false ), 'no Cache-Control is shareable' );

echo "Crawler link extraction\n";
$crawler = new Lifeboat\Crawler( Lifeboat\Settings::all() );
$found   = $crawler->extract_from_html(
	'<script src="/wp-includes/js/a.js?ver=1"></script>'
	. '<script>!function(i,n){var t=i.createElement("script");t.src=r;n.src=e,t.defer=!0}(window,document);</script>'
	. '<script type="importmap" id="wp-importmap">{"imports":{"@wordpress/interactivity":"/wp-includes/js/dist/script-modules/interactivity/index.min.js?ver=2"}}</script>'
	. '<img src="/wp-content/uploads/b.png"><a href="/about/">About</a>',
	'https://example.com/post/'
);
$assets = array_map( static fn( $u ) => (string) wp_parse_url( $u, PHP_URL_PATH ), $found['assets'] );
$check( in_array( '/wp-includes/js/a.js', $assets, true ) && in_array( '/wp-content/uploads/b.png', $assets, true ), 'script and image sources are collected' );
$check( in_array( '/wp-includes/js/dist/script-modules/interactivity/index.min.js', $assets, true ), 'import map modules are collected' );
$check( 3 === count( $assets ) && ! in_array( '/post/r', $assets, true ), 'code inside inline scripts is not mistaken for attributes' );
$check( [ 'https://example.com/about/' ] === $found['links'], 'page links are collected' );

echo "Service URL validation\n";
$check( Lifeboat\Settings::valid_service_url( 'https://ingest.example.net' ), 'https is accepted' );
$check( Lifeboat\Settings::valid_service_url( 'http://127.0.0.1:8787' ), 'http on 127.0.0.1 is accepted' );
$check( Lifeboat\Settings::valid_service_url( 'http://dev.localhost' ), 'http on *.localhost is accepted' );
$check( ! Lifeboat\Settings::valid_service_url( 'http://ingest.example.net' ), 'plain http elsewhere is refused' );
$check( ! Lifeboat\Settings::valid_service_url( 'https://user:pass@ingest.example.net' ), 'embedded credentials are refused' );
$check( ! Lifeboat\Settings::valid_service_url( 'ftp://ingest.example.net' ), 'other schemes are refused' );


echo "Forwarded request trust (LIFEBOAT_EDGE_SECRET is defined for this run)\n";
$home     = wp_parse_url( home_url( '/' ) );
$expected = $home['host'] . ( isset( $home['port'] ) ? ':' . $home['port'] : '' );
$attempt  = static function ( array $headers ): array {
	$saved = $_SERVER;
	foreach ( [ 'HTTP_HOST', 'SERVER_NAME', 'HTTPS', 'REMOTE_ADDR', 'HTTP_X_FORWARDED_HOST', 'HTTP_X_FORWARDED_PROTO', 'HTTP_X_LIFEBOAT_EDGE', 'HTTP_X_LIFEBOAT_CLIENT_IP' ] as $k ) {
		unset( $_SERVER[ $k ] );
	}
	$_SERVER['HTTP_HOST']   = '127.0.0.1:9';
	$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
	foreach ( $headers as $k => $v ) {
		$_SERVER[ $k ] = $v;
	}
	Lifeboat\Edge::trust_forwarded_request();
	$after   = [
		'host' => $_SERVER['HTTP_HOST'],
		'ip'   => $_SERVER['REMOTE_ADDR'],
	];
	$_SERVER = $saved;
	return $after;
};
$secret = LIFEBOAT_EDGE_SECRET;

$r = $attempt( [ 'HTTP_X_FORWARDED_HOST' => $expected, 'HTTP_X_LIFEBOAT_EDGE' => $secret, 'HTTP_X_LIFEBOAT_CLIENT_IP' => '203.0.113.9' ] );
$check( $expected === $r['host'] && '203.0.113.9' === $r['ip'], 'the verified edge sets the public host and the visitor IP' );
$r = $attempt( [ 'HTTP_X_FORWARDED_HOST' => $expected, 'HTTP_X_LIFEBOAT_EDGE' => 'wrong', 'HTTP_X_LIFEBOAT_CLIENT_IP' => '203.0.113.9' ] );
$check( '127.0.0.1:9' === $r['host'] && '127.0.0.1' === $r['ip'], 'a wrong edge secret changes nothing' );
$r = $attempt( [ 'HTTP_X_FORWARDED_HOST' => $expected ] );
$check( '127.0.0.1:9' === $r['host'], 'without the secret the forwarded host is ignored once a secret is configured' );
$r = $attempt( [ 'HTTP_X_FORWARDED_HOST' => 'attacker.example', 'HTTP_X_LIFEBOAT_EDGE' => $secret ] );
$check( '127.0.0.1:9' === $r['host'], 'a forwarded host other than the home host is never adopted' );
$r = $attempt( [ 'HTTP_X_FORWARDED_HOST' => $expected, 'HTTP_X_LIFEBOAT_EDGE' => $secret, 'HTTP_X_LIFEBOAT_CLIENT_IP' => 'not-an-ip' ] );
$check( '127.0.0.1' === $r['ip'], 'an invalid client IP is ignored' );

echo "Storage clients (HTTP intercepted with pre_http_request)\n";
$sent      = [];
$responses = [];
$intercept = static function ( $pre, $args, $url ) use ( &$sent, &$responses ) {
	$sent[]            = [
		'url'     => $url,
		'method'  => $args['method'],
		'headers' => $args['headers'],
		'body'    => $args['body'],
	];
	[ $status, $body ] = array_shift( $responses ) ?? [ 200, '' ];
	return [
		'headers'  => [],
		'body'     => $body,
		'response' => [
			'code'    => $status,
			'message' => '',
		],
		'cookies'  => [],
		'filename' => null,
	];
};
add_filter( 'pre_http_request', $intercept, 10, 3 );

$r2        = new Lifeboat\R2_Client( 'account', 'bucket', 'AKIDEXAMPLE', 'secret', 5 );
$responses = [ [ 200, '' ] ];
$r2->put( 'sites/x/snapshots/1/a.css', 'body{}', 'text/css', [ 'sha256' => 'abc', 'lifeboat-redirect' => 'https://x.example/łódź' ], 'public, max-age=60' );
$req = end( $sent );
$check( 'PUT' === $req['method'] && str_ends_with( $req['url'], '/bucket/sites/x/snapshots/1/a.css' ), 'R2 put targets the bucket key' );
$check( 'public, max-age=60' === ( $req['headers']['Cache-Control'] ?? '' ), 'R2 put sends the origin Cache-Control' );
$check( str_contains( $req['headers']['Authorization'], 'SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-lifeboat-redirect;x-amz-meta-sha256,' ), 'R2 signs Cache-Control and metadata' );
$check( 'https://x.example/%C5%82%C3%B3d%C5%BA' === $req['headers']['x-amz-meta-lifeboat-redirect'], 'R2 metadata is percent-encoded ASCII' );

$responses = [
	[ 200, '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><CommonPrefixes><Prefix>sites/x/snapshots/1/</Prefix></CommonPrefixes></ListBucketResult>' ],
	[ 200, '<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>sites/x/snapshots/2/</Prefix></CommonPrefixes></ListBucketResult>' ],
];
$check( [ 'sites/x/snapshots/1/', 'sites/x/snapshots/2/' ] === $r2->list_prefixes( 'sites/x/snapshots/' ), 'R2 list_prefixes follows continuation tokens' );
$check( str_contains( end( $sent )['url'], 'continuation-token=t2' ), 'R2 second listing page uses the token' );
$responses = [ [ 200, '<CopyObjectResult/>' ] ];
$r2->copy( 'sites/x/a b.css', 'sites/x/c.css' );
$check( '/bucket/sites/x/a%20b.css' === end( $sent )['headers']['x-amz-copy-source'], 'R2 copy names the encoded source key' );
$responses = [ [ 200, '<DeleteResult/>' ] ];
$r2->delete_many( [ 'sites/x/a&b' ] );
$check( str_contains( end( $sent )['body'], '<Key>sites/x/a&amp;b</Key>' ) && isset( end( $sent )['headers']['Content-MD5'] ), 'R2 delete_many sends escaped keys with Content-MD5' );
$responses = [ [ 200, 'not json' ] ];
$check( is_wp_error( $r2->get_json( 'k' ) ), 'get_json rejects a non-JSON object' );

$service   = new Lifeboat\Service_Client( 'https://ingest.example.net/', 'site.example', 'lbk_test-key-0123456789', 5 );
$responses = [ [ 200, '{"ok":true}' ] ];
$service->put( 'sites/site.example/a', '', 'text/plain', [ 'lifeboat-cache' => 'private' ] );
$req = end( $sent );
$check( 'https://ingest.example.net/v1/object?key=sites%2Fsite.example%2Fa' === $req['url'], 'service put targets the object endpoint' );
$check( 'Bearer lbk_test-key-0123456789' === $req['headers']['Authorization'] && 'site.example' === $req['headers']['X-Lifeboat-Site'], 'service requests carry the site and its key' );
$check( '0' === $req['headers']['Content-Length'] && '{"lifeboat-cache":"private"}' === $req['headers']['X-Lifeboat-Metadata'], 'an empty upload declares its length and metadata' );
$responses = [ [ 200, '{"ok":true}' ], [ 200, '{"ok":true}' ] ];
$service->delete_many( array_map( static fn( $i ) => "sites/site.example/k$i", range( 1, 1001 ) ) );
$check( 2 === count( array_filter( array_slice( $sent, -2 ), static fn( $r ) => str_ends_with( $r['url'], '/v1/delete' ) ) ), 'service delete_many sends batches of at most 1000 keys' );
$responses = [ [ 404, '{"error":"No such object."}' ] ];
$missing   = $service->get( 'sites/site.example/nope' );
$check( is_wp_error( $missing ) && 'not_found' === $missing->get_error_code(), 'a service 404 maps to not_found like R2' );
$responses = [ [ 200, '{"keys":[{"key":"sites/site.example/a","size":3,"etag":"e"}],"prefixes":[],"next":"c2"}' ] ];
$page      = $service->list( 'sites/site.example/' );
$check( ! is_wp_error( $page ) && 'c2' === $page['next'] && 3 === $page['keys'][0]['size'], 'service listings map to the R2 listing shape' );

remove_filter( 'pre_http_request', $intercept, 10 );

echo "Key mapping parity sample written for the Worker comparison\n";
$paths = [ '/', '/about/', '/about', '/feed/', '/o-nas/łódź/', '/wp-content/uploads/2026/08/a b.jpg', '/sitemap.xml', '/wp-includes/js/x.js', '/wp-content/plugins/p/endpoint.php', '/.well-known/security.txt', '/a.b/c', '/robots.txt', '/files/report.PDF' ];
$out   = [];
foreach ( $paths as $p ) {
	$out[] = [
		'path'  => $p,
		'key'   => Lifeboat\Keys::path_to_key( $p ),
		'asset' => Lifeboat\Keys::is_asset_path( $p ),
	];
}
file_put_contents( (string) ( $args[0] ?? 'php://stdout' ), wp_json_encode( $out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) );
echo "  wrote " . count( $out ) . " paths\n";

if ( $failures ) {
	WP_CLI::error( "$failures plugin check(s) failed." );
}
WP_CLI::success( 'Plugin checks passed.' );
