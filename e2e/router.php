<?php
/**
 * Router for PHP's built-in web server: static files are served as files, PHP entry points
 * (wp-login.php, wp-admin/…) run directly, and everything else goes to WordPress's index.php.
 */
// The built-in server logs only static files once a router is in use, so the
// e2e checks count origin traffic from this log instead.
$log = getenv( 'LIFEBOAT_E2E_REQUEST_LOG' );
if ( $log ) {
	file_put_contents( $log, $_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI'] . "\n", FILE_APPEND | LOCK_EX );
}

$path = (string) parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$root = rtrim( (string) $_SERVER['DOCUMENT_ROOT'], '/' );
$file = $root . $path;

if ( is_dir( $file ) && is_file( rtrim( $file, '/' ) . '/index.php' ) ) {
	$path = rtrim( $path, '/' ) . '/index.php';
	$file = $root . $path;
}
if ( is_file( $file ) && '.php' !== substr( $file, -4 ) ) {
	return false;
}
if ( ! is_file( $file ) ) {
	$path = '/index.php';
	$file = $root . $path;
}

$_SERVER['SCRIPT_NAME']     = $path;
$_SERVER['PHP_SELF']        = $path;
$_SERVER['SCRIPT_FILENAME'] = $file;
chdir( dirname( $file ) );
require $file;
