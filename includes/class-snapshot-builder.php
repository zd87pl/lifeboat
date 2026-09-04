<?php
namespace Lifeboat;

use WP_Error;

/**
 * Builds snapshots as resumable jobs. Job state lives in an option so the same code path runs
 * to completion under WP-CLI or in time-budgeted slices under WP-Cron, on any web node.
 *
 * Bucket layout (see README):
 *   <prefix>/current.json                       pointer → the promoted snapshot (written last, atomically)
 *   <prefix>/snapshots/<id>/manifest.json       every object with sha256/size/type
 *   <prefix>/snapshots/<id>/__404.html          the theme's 404 page
 *   <prefix>/snapshots/<id>/<key>               index.html, about/index.html, wp-content/… , feed/index.html …
 */
final class Snapshot_Builder {

	public const JOB_OPTION     = 'lifeboat_job';
	public const PREV_OPTION    = 'lifeboat_prev_manifest';
	public const LAST_OPTION    = 'lifeboat_last_snapshot';
	public const RESULT_OPTION  = 'lifeboat_last_result';
	public const PENDING_OPTION = 'lifeboat_pending';
	public const LOCK           = 'build';
	public const LOCK_TTL       = 900;

	private array $s;
	private ?R2_Client $r2;
	private Crawler $crawler;
	private string $host;
	private string $prefix;
	private array $exclude;
	private int $max_urls;
	private int $persist_every;
	private ?array $job = null;
	private ?array $prev = null;
	/** @var callable|null */
	private $log;

	public function __construct( ?callable $log = null, int $persist_every = 25 ) {
		$this->s             = Settings::all();
		$this->r2            = R2_Client::from_settings();
		$this->crawler       = new Crawler( $this->s );
		$this->host          = Settings::host();
		$this->prefix        = Settings::prefix();
		$this->exclude       = Settings::exclude_patterns();
		$this->max_urls      = max( 10, (int) $this->s['max_urls'] );
		$this->persist_every = max( 1, $persist_every );
		$this->log           = $log;
	}

	/* ---------------------------------------------------------------- state */

	public static function current_job(): ?array {
		$j = get_option( self::JOB_OPTION );
		return is_array( $j ) ? $j : null;
	}

	public static function last_snapshot(): ?array {
		$l = get_option( self::LAST_OPTION );
		return is_array( $l ) ? $l : null;
	}

	public static function last_result(): ?array {
		$r = get_option( self::RESULT_OPTION );
		return is_array( $r ) ? $r : null;
	}

	public static function cancel(): void {
		delete_option( self::JOB_OPTION );
		delete_option( self::PREV_OPTION );
		Lock::release( self::LOCK );
	}

	/* ---------------------------------------------------------------- starting jobs */

	public function start_full(): array|WP_Error {
		if ( ! $this->r2 ) {
			return new WP_Error( 'not_configured', 'Cloudflare R2 is not configured.' );
		}
		if ( self::current_job() ) {
			return new WP_Error( 'busy', 'A snapshot job is already in progress.' );
		}
		if ( ! get_option( 'permalink_structure' ) ) {
			return new WP_Error( 'permalinks', 'Pretty permalinks are required (Settings → Permalinks).' );
		}

		$seeds = ( new Url_Collector( $this->s, $this->exclude, $this->max_urls ) )->seeds();
		if ( ! $seeds ) {
			return new WP_Error( 'no_urls', 'No URLs to crawl.' );
		}

		$prev = $this->load_current_manifest();
		update_option( self::PREV_OPTION, $prev ?: [], false );

		$id = gmdate( 'Ymd-His' );
		while ( $id === ( $prev['id'] ?? null ) ) {
			sleep( 1 ); // never reuse the live prefix
			$id = gmdate( 'Ymd-His' );
		}
		$job = [
			'id'          => $id,
			'kind'        => 'full',
			'host'        => $this->host,
			'prefix'      => $this->prefix . '/snapshots/' . $id,
			'prev_prefix' => $prev['prefix'] ?? null,
			'started'     => time(),
			'queue'       => $seeds,
			'queued'      => array_fill_keys( $seeds, 1 ),
			'objects'     => [],
			'deletes'     => [],
			'stats'       => self::empty_stats(),
			'errors'      => [],
			'processed'   => 0,
		];
		update_option( self::JOB_OPTION, $job, false );
		$this->info( sprintf( 'Started full snapshot %s with %d seed URLs%s.', $id, count( $seeds ), $prev ? " (dedup against {$prev['id']})" : '' ) );
		return $job;
	}

	/**
	 * Refresh a set of paths inside the currently promoted snapshot (no link discovery).
	 * @param string[] $paths decoded site paths to re-crawl
	 * @param string[] $deletes decoded site paths to remove
	 */
	public function start_incremental( array $paths, array $deletes = [] ): array|WP_Error {
		if ( ! $this->r2 ) {
			return new WP_Error( 'not_configured', 'Cloudflare R2 is not configured.' );
		}
		if ( self::current_job() ) {
			return new WP_Error( 'busy', 'A snapshot job is already in progress.' );
		}
		$prev = $this->load_current_manifest();
		if ( ! $prev ) {
			return new WP_Error( 'no_snapshot', 'No promoted snapshot yet; run a full build first.' );
		}
		$paths   = array_values( array_unique( array_filter( $paths, fn( $p ) => is_string( $p ) && ! Keys::excluded( $p, $this->exclude ) ) ) );
		$deletes = array_values( array_unique( array_filter( $deletes, 'is_string' ) ) );
		if ( ! $paths && ! $deletes ) {
			return new WP_Error( 'nothing', 'Nothing to update.' );
		}
		update_option( self::PREV_OPTION, $prev, false );

		$job = [
			'id'          => $prev['id'],
			'kind'        => 'incremental',
			'host'        => $this->host,
			'prefix'      => $prev['prefix'],
			'prev_prefix' => $prev['prefix'],
			'started'     => time(),
			'queue'       => $paths,
			'queued'      => array_fill_keys( $paths, 1 ),
			'objects'     => [],
			'deletes'     => $deletes,
			'stats'       => self::empty_stats(),
			'errors'      => [],
			'processed'   => 0,
		];
		update_option( self::JOB_OPTION, $job, false );
		$this->info( sprintf( 'Started incremental update of %s: %d paths, %d deletions.', $prev['id'], count( $paths ), count( $deletes ) ) );
		return $job;
	}

	/* ---------------------------------------------------------------- running */

	/**
	 * Work on the current job until the queue is empty or $budget seconds have elapsed.
	 * @return array{state:string, ok?:bool, message?:string, processed?:int, remaining?:int, stats?:array}|WP_Error
	 */
	public function run( int $budget = 20 ): array|WP_Error {
		if ( ! $this->r2 ) {
			return new WP_Error( 'not_configured', 'Cloudflare R2 is not configured.' );
		}
		if ( ! Lock::acquire( self::LOCK, self::LOCK_TTL ) ) {
			return new WP_Error( 'locked', 'Another process is working on the snapshot.' );
		}
		try {
			$this->job = self::current_job();
			if ( ! $this->job ) {
				return [ 'state' => 'idle' ];
			}
			$prev       = get_option( self::PREV_OPTION );
			$this->prev = is_array( $prev ) && ! empty( $prev['objects'] ) ? $prev : null;

			$deadline = time() + max( 1, $budget );
			$n        = 0;
			while ( $this->job['queue'] && time() < $deadline && empty( $this->job['aborted'] ) ) {
				$path = array_shift( $this->job['queue'] );
				try {
					$this->process_page( $path );
				} catch ( \Throwable $e ) {
					$this->error( "$path: " . $e->getMessage() );
				}
				$this->job['processed']++;
				if ( 0 === ++$n % $this->persist_every ) {
					$this->persist();
					Lock::refresh( self::LOCK, self::LOCK_TTL );
				}
			}

			if ( ! $this->job['queue'] || ! empty( $this->job['aborted'] ) ) {
				return $this->finalize();
			}
			$this->persist();
			return [
				'state'     => 'running',
				'processed' => $this->job['processed'],
				'remaining' => count( $this->job['queue'] ),
				'stats'     => $this->job['stats'],
			];
		} finally {
			Lock::release( self::LOCK );
		}
	}

	private function process_page( string $path ): void {
		$key = Keys::path_to_key( $path );
		if ( isset( $this->job['objects'][ $key ] ) && 'redirect' !== $this->job['objects'][ $key ]['kind'] ) {
			return; // e.g. /about and /about/ both queued
		}

		$res = $this->crawler->fetch( $path );
		if ( is_wp_error( $res ) ) {
			if ( 'lifeboat_fallback' === $res->get_error_code() ) {
				$this->job['aborted'] = $res->get_error_message();
				return;
			}
			$this->error( "fetch $path: " . $res->get_error_message() );
			$this->job['stats']['failed']++;
			return;
		}
		$this->job['stats']['fetched']++;
		$base   = $this->crawler->site_base() . Keys::encode_path( $path );
		$status = $res['status'];

		if ( $status >= 300 && $status < 400 && $res['location'] ) {
			$target = Keys::absolutize( $res['location'], $base );
			$tpath  = $target ? Keys::to_site_path( $target, $this->host ) : null;
			if ( null !== $tpath && $tpath === $path ) {
				$this->error( "$path redirects to itself (scheme or trailing-slash loop); set LIFEBOAT_ORIGIN_URL to the origin's https address or fix forced-HTTPS rules for loopback requests" );
				return;
			}
			if ( null !== $tpath && ! Keys::has_query( $target ) && $this->eligible( $tpath ) && 'full' === $this->job['kind'] ) {
				$this->enqueue( $tpath );
			}
			if ( $target && ( null === $tpath || Keys::path_to_key( $tpath ) !== $key ) ) {
				$this->store( $key, self::redirect_html( $target ), 'text/html; charset=UTF-8', 'redirect', $path, [ 'lifeboat-redirect' => $target ] );
			}
			return;
		}

		if ( 200 !== $status ) {
			$this->error( "$path returned HTTP $status; skipped" );
			if ( $status >= 500 ) {
				$this->job['stats']['failed']++;
			}
			return;
		}
		if ( $res['truncated'] ) {
			$this->error( "$path exceeds the size limit; skipped" );
			return;
		}

		$type = '' !== $res['type'] ? $res['type'] : Crawler::guess_type( $path );
		$body = $res['body'];

		if ( Crawler::is_html( $type ) ) {
			$found = $this->crawler->extract_from_html( $body, $base );
			foreach ( $found['assets'] as $url ) {
				$this->process_asset( $url, 0 );
			}
			if ( 'full' === $this->job['kind'] ) {
				foreach ( $found['links'] as $url ) {
					if ( Keys::has_query( $url ) ) {
						continue;
					}
					$p = Keys::to_site_path( $url, $this->host );
					if ( null === $p || ! $this->eligible( $p ) ) {
						continue;
					}
					if ( Keys::is_asset_path( $p ) ) {
						$this->process_asset( $url, 0 );
					} else {
						$this->enqueue( $p );
					}
				}
			}
			$this->store( $key, $body, $type, 'page', $path );
			return;
		}

		if ( Crawler::is_xml( $type ) && 'full' === $this->job['kind'] ) {
			// Sitemap index / sitemap: child sitemaps and content URLs are both queued as pages,
			// so nested sitemaps get parsed in turn.
			foreach ( Crawler::extract_sitemap_locs( $body ) as $url ) {
				$p = Keys::to_site_path( $url, $this->host );
				if ( null !== $p && ! Keys::has_query( $url ) && $this->eligible( $p ) ) {
					$this->enqueue( $p );
				}
			}
			if ( preg_match( '#<\?xml-stylesheet[^>]*\bhref\s*=\s*["\']([^"\']+)["\']#i', $body, $xm ) ) {
				$xsl = Keys::absolutize( $xm[1], $base );
				if ( $xsl ) {
					$this->process_asset( $xsl, 1 );
				}
			}
		}
		if ( Crawler::is_css( $type ) ) {
			foreach ( $this->crawler->extract_from_css( $body ) as $ref ) {
				$abs = Keys::absolutize( $ref, $base );
				if ( $abs ) {
					$this->process_asset( $abs, 1 );
				}
			}
		}
		$this->store( $key, $body, $type, 'asset', $path );
	}

	private function process_asset( string $url, int $depth ): void {
		$path = Keys::to_site_path( $url, $this->host );
		if ( null === $path || $depth > 3 || ! $this->eligible( $path ) ) {
			return;
		}
		$key = Keys::path_to_key( $path );
		if ( isset( $this->job['objects'][ $key ] ) ) {
			return;
		}
		if ( 'incremental' === $this->job['kind'] && isset( $this->prev['objects'][ $key ] ) ) {
			return; // theme/plugin assets are refreshed by full builds; only new assets are fetched here
		}

		$res = $this->crawler->fetch( $path );
		if ( is_wp_error( $res ) ) {
			if ( 'lifeboat_fallback' === $res->get_error_code() ) {
				$this->job['aborted'] = $res->get_error_message();
				return;
			}
			$this->error( "asset $path: " . $res->get_error_message() );
			$this->job['stats']['failed']++;
			return;
		}
		$this->job['stats']['fetched']++;
		$base = $this->crawler->site_base() . Keys::encode_path( $path );

		if ( $res['status'] >= 300 && $res['status'] < 400 && $res['location'] ) {
			$target = Keys::absolutize( $res['location'], $base );
			$tpath  = $target ? Keys::to_site_path( $target, $this->host ) : null;
			if ( null !== $tpath && $tpath !== $path ) {
				$this->process_asset( $target, $depth + 1 );
			}
			return;
		}
		if ( 200 !== $res['status'] ) {
			$this->error( "asset $path: HTTP {$res['status']}" );
			return;
		}
		if ( $res['truncated'] ) {
			$this->error( "asset $path exceeds the size limit; skipped" );
			return;
		}

		$type = '' !== $res['type'] ? $res['type'] : Crawler::guess_type( $path );
		$this->store( $key, $res['body'], $type, 'asset', $path );

		if ( Crawler::is_css( $type ) ) {
			foreach ( $this->crawler->extract_from_css( $res['body'] ) as $ref ) {
				$abs = Keys::absolutize( $ref, $base );
				if ( $abs ) {
					$this->process_asset( $abs, $depth + 1 );
				}
			}
		}
	}

	/**
	 * Upload an object into the job's prefix, or server-side copy it from the previous snapshot
	 * when the content hash is unchanged.
	 */
	private function store( string $key, string $body, string $type, string $kind, string $src, array $meta = [] ): void {
		$sha   = hash( 'sha256', $body );
		$entry = [
			'sha256' => $sha,
			'size'   => strlen( $body ),
			'type'   => $type,
			'kind'   => $kind,
			'src'    => $src,
		];
		if ( $meta ) {
			$entry['meta'] = $meta;
		}

		$old  = $this->prev['objects'][ $key ] ?? null;
		$same = $old && ( $old['sha256'] ?? '' ) === $sha && ( $old['type'] ?? '' ) === $type && ( $old['meta'] ?? [] ) === $meta;

		if ( $same && 'incremental' === $this->job['kind'] ) {
			$this->job['objects'][ $key ] = $entry;
			$this->job['stats']['skipped']++;
			return;
		}

		$dst = $this->job['prefix'] . '/' . $key;
		if ( $same && $this->job['prev_prefix'] ) {
			$r = $this->r2->copy( $this->job['prev_prefix'] . '/' . $key, $dst );
			if ( ! is_wp_error( $r ) ) {
				$this->job['objects'][ $key ] = $entry;
				$this->job['stats']['copied']++;
				return;
			}
			// fall through to a normal upload
		}

		$r = $this->r2->put( $dst, $body, $type, $meta + [ 'sha256' => $sha ] );
		if ( is_wp_error( $r ) ) {
			$this->error( "upload $key: " . $r->get_error_message() );
			$this->job['stats']['failed']++;
			if ( 'page' === $kind ) {
				$this->job['stats']['failed_pages']++;
			}
			return;
		}
		$this->job['objects'][ $key ] = $entry;
		$this->job['stats']['uploaded']++;
		$this->job['stats']['bytes'] += $entry['size'];
	}

	/* ---------------------------------------------------------------- finishing */

	private function finalize(): array {
		$job = $this->job;
		$st  = $job['stats'];

		if ( ! empty( $job['aborted'] ) ) {
			return $this->end_job( false, 'Aborted: ' . $job['aborted'] );
		}

		if ( 'full' === $job['kind'] ) {
			$this->store_404();
			$job      = $this->job;
			$st       = $job['stats'];
			$counts   = self::counts( $job['objects'] );
			$attempts = $st['uploaded'] + $st['copied'] + $st['failed'];
			$err_pct  = $attempts > 0 ? $st['failed'] * 100 / $attempts : 100.0;
			$home_ok  = isset( $job['objects']['index.html'] ) && 'page' === $job['objects']['index.html']['kind'];
			$ok       = $home_ok && 0 === $st['failed_pages'] && $err_pct <= (float) $this->s['max_error_pct'];
			$why      = '';
			if ( ! $home_ok ) {
				$why = 'the home page is missing from the snapshot';
			} elseif ( $st['failed_pages'] > 0 ) {
				$why = "{$st['failed_pages']} page upload(s) failed";
			} elseif ( ! $ok ) {
				$why = sprintf( 'error rate %.1f%% exceeds the %s%% limit', $err_pct, $this->s['max_error_pct'] );
			}

			$r = $this->r2->put( $job['prefix'] . '/manifest.json', self::json( $this->manifest( $job['objects'], $counts, $job['started'], $ok ) ), 'application/json' );
			if ( is_wp_error( $r ) ) {
				$ok  = false;
				$why = 'manifest upload failed: ' . $r->get_error_message();
			}
			if ( $ok ) {
				$r = $this->write_pointer( $counts );
				if ( is_wp_error( $r ) ) {
					$ok  = false;
					$why = 'pointer write failed: ' . $r->get_error_message();
				}
			}
			if ( $ok ) {
				update_option(
					self::LAST_OPTION,
					[
						'id'          => $job['id'],
						'prefix'      => $job['prefix'],
						'promoted_at' => time(),
						'updated_at'  => time(),
						'counts'      => $counts,
					],
					false
				);
				$this->prune();
				return $this->end_job(
					true,
					sprintf(
						'Snapshot %s promoted: %d pages, %d assets, %d redirects, %s (%d uploaded, %d copied, %d failed).',
						$job['id'],
						$counts['pages'],
						$counts['assets'],
						$counts['redirects'],
						size_format( $counts['bytes'] ),
						$st['uploaded'],
						$st['copied'],
						$st['failed']
					)
				);
			}
			return $this->end_job( false, sprintf( 'Snapshot %s was built but NOT promoted: %s. The previous snapshot stays live.', $job['id'], $why ) );
		}

		// Incremental: merge into the live manifest, apply deletions, refresh the pointer's timestamp.
		$objects = $job['objects'] + ( $this->prev['objects'] ?? [] );
		foreach ( $job['deletes'] as $path ) {
			$key = Keys::path_to_key( $path );
			$r   = $this->r2->delete( $job['prefix'] . '/' . $key );
			if ( is_wp_error( $r ) ) {
				$this->error( "delete $key: " . $r->get_error_message() );
			}
			unset( $objects[ $key ] );
		}
		$counts = self::counts( $objects );
		$r      = $this->r2->put( $job['prefix'] . '/manifest.json', self::json( $this->manifest( $objects, $counts, (int) ( $this->prev['created'] ?? $job['started'] ), true ) ), 'application/json' );
		$ok     = ! is_wp_error( $r ) && 0 === $st['failed_pages'];
		if ( is_wp_error( $r ) ) {
			$this->error( 'manifest update failed: ' . $r->get_error_message() );
		} else {
			$this->write_pointer( $counts );
			$last = self::last_snapshot();
			if ( $last ) {
				$last['updated_at'] = time();
				$last['counts']     = $counts;
				update_option( self::LAST_OPTION, $last, false );
			}
		}
		return $this->end_job(
			$ok,
			sprintf(
				'Incremental update of %s: %d refreshed, %d unchanged, %d deleted, %d failed.',
				$job['id'],
				$st['uploaded'],
				$st['skipped'],
				count( $job['deletes'] ),
				$st['failed']
			)
		);
	}

	private function store_404(): void {
		$probe = '/lifeboat-404-' . strtolower( wp_generate_password( 10, false ) ) . '/';
		$res   = $this->crawler->fetch( $probe );
		if ( is_wp_error( $res ) || 404 !== $res['status'] || ! Crawler::is_html( $res['type'] ) ) {
			$this->error( 'the 404 template could not be captured (__404.html)' );
			return;
		}
		$this->store( '__404.html', $res['body'], $res['type'], 'system', $probe );
	}

	private function write_pointer( array $counts ): true|WP_Error {
		$pointer = [
			'snapshot_id' => $this->job['id'],
			'prefix'      => $this->job['prefix'],
			'manifest'    => $this->job['prefix'] . '/manifest.json',
			'host'        => $this->host,
			'updated_at'  => gmdate( 'c' ),
			'counts'      => $counts,
			'generator'   => 'lifeboat/' . LIFEBOAT_VERSION,
		];
		return $this->r2->put( $this->prefix . '/current.json', self::json( $pointer ), 'application/json' );
	}

	private function manifest( array $objects, array $counts, int $created, bool $promoted ): array {
		return [
			'version'     => 1,
			'snapshot_id' => $this->job['id'],
			'host'        => $this->host,
			'prefix'      => $this->job['prefix'],
			'created_at'  => gmdate( 'c', $created ),
			'updated_at'  => gmdate( 'c' ),
			'generator'   => 'lifeboat/' . LIFEBOAT_VERSION,
			'promoted'    => $promoted,
			'counts'      => $counts,
			'objects'     => $objects,
		];
	}

	/** Delete snapshot prefixes beyond keep_snapshots, never the one just promoted. */
	public function prune(): void {
		if ( ! $this->r2 ) {
			return;
		}
		$keep = max( 1, (int) $this->s['keep_snapshots'] );
		$list = $this->r2->list_prefixes( $this->prefix . '/snapshots/' );
		if ( is_wp_error( $list ) ) {
			$this->error( 'prune: ' . $list->get_error_message() );
			return;
		}
		rsort( $list, SORT_STRING );
		$last    = self::last_snapshot();
		$current = $last ? $last['prefix'] . '/' : null;
		foreach ( array_slice( $list, $keep ) as $victim ) {
			if ( $victim === $current ) {
				continue;
			}
			$keys = $this->r2->list_all_keys( $victim );
			if ( is_wp_error( $keys ) ) {
				$this->error( 'prune: ' . $keys->get_error_message() );
				continue;
			}
			$r = $keys ? $this->r2->delete_many( $keys ) : true;
			if ( is_wp_error( $r ) ) {
				$this->error( 'prune: ' . $r->get_error_message() );
			} else {
				$this->info( sprintf( 'Pruned %s (%d objects).', $victim, count( $keys ) ) );
			}
		}
	}

	private function end_job( bool $ok, string $message ): array {
		$job    = $this->job;
		$result = [
			'ok'       => $ok,
			'kind'     => $job['kind'],
			'id'       => $job['id'],
			'finished' => time(),
			'duration' => time() - (int) $job['started'],
			'message'  => $message,
			'stats'    => $job['stats'],
			'errors'   => array_slice( $job['errors'], -20 ),
		];
		update_option( self::RESULT_OPTION, $result, false );
		delete_option( self::JOB_OPTION );
		delete_option( self::PREV_OPTION );
		$this->job = null;
		$this->info( $message );
		do_action( 'lifeboat_job_finished', $result );
		return [
			'state'   => 'done',
			'ok'      => $ok,
			'message' => $message,
			'stats'   => $result['stats'],
			'errors'  => $result['errors'],
		];
	}

	/* ---------------------------------------------------------------- helpers */

	/** @return array{id:string,prefix:string,objects:array,created:int}|null */
	private function load_current_manifest(): ?array {
		$cur = $this->r2->get_json( $this->prefix . '/current.json' );
		if ( is_wp_error( $cur ) || empty( $cur['snapshot_id'] ) ) {
			return null;
		}
		$prefix = $this->prefix . '/snapshots/' . $cur['snapshot_id'];
		$m      = $this->r2->get_json( $cur['manifest'] ?? $prefix . '/manifest.json' );
		return [
			'id'      => (string) $cur['snapshot_id'],
			'prefix'  => $prefix,
			'objects' => is_wp_error( $m ) ? [] : (array) ( $m['objects'] ?? [] ),
			'created' => is_wp_error( $m ) ? time() : (int) strtotime( (string) ( $m['created_at'] ?? 'now' ) ),
		];
	}

	private function eligible( string $path ): bool {
		return ! Keys::excluded( $path, $this->exclude );
	}

	private function enqueue( string $path ): void {
		if ( isset( $this->job['queued'][ $path ] ) ) {
			return;
		}
		if ( count( $this->job['queued'] ) >= $this->max_urls ) {
			$this->job['stats']['dropped']++;
			return;
		}
		$this->job['queued'][ $path ] = 1;
		$this->job['queue'][]         = $path;
	}

	private function persist(): void {
		update_option( self::JOB_OPTION, $this->job, false );
	}

	private function error( string $msg ): void {
		$this->job['errors'][] = gmdate( 'H:i:s' ) . ' ' . $msg;
		if ( count( $this->job['errors'] ) > 100 ) {
			array_shift( $this->job['errors'] );
		}
		$this->info( 'WARN ' . $msg );
	}

	private function info( string $msg ): void {
		if ( $this->log ) {
			( $this->log )( $msg );
		} elseif ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
			error_log( '[lifeboat] ' . $msg );
		}
	}

	private static function counts( array $objects ): array {
		$c = [
			'pages'     => 0,
			'assets'    => 0,
			'redirects' => 0,
			'bytes'     => 0,
		];
		foreach ( $objects as $o ) {
			$c['bytes'] += (int) ( $o['size'] ?? 0 );
			switch ( $o['kind'] ?? '' ) {
				case 'page':
					$c['pages']++;
					break;
				case 'redirect':
					$c['redirects']++;
					break;
				case 'asset':
					$c['assets']++;
					break;
			}
		}
		return $c;
	}

	private static function empty_stats(): array {
		return [
			'fetched'      => 0,
			'uploaded'     => 0,
			'copied'       => 0,
			'skipped'      => 0,
			'failed'       => 0,
			'failed_pages' => 0,
			'dropped'      => 0,
			'bytes'        => 0,
		];
	}

	private static function json( array $data ): string {
		return (string) wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	}

	private static function redirect_html( string $target ): string {
		$t = esc_attr( $target );
		return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url=$t\"><title>Redirecting</title></head><body><a href=\"$t\">Redirecting…</a></body></html>";
	}
}
