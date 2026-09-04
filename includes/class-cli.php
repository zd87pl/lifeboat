<?php
namespace Lifeboat;

use WP_CLI;

/**
 * Builds and inspects static failover snapshots.
 */
final class Cli {

	/**
	 * Builds a full snapshot, uploads it to R2 and promotes it (resumes an in-progress job).
	 *
	 * ## OPTIONS
	 *
	 * [--budget=<seconds>]
	 * : Seconds of work between state checkpoints. Default 300.
	 *
	 * [--fresh]
	 * : Discard any in-progress job and start over.
	 *
	 * ## EXAMPLES
	 *
	 *     wp lifeboat build
	 *     wp lifeboat build --fresh --budget=600
	 */
	public function build( array $args, array $assoc ): void {
		$budget = max( 5, (int) ( $assoc['budget'] ?? 300 ) );
		if ( ! empty( $assoc['fresh'] ) ) {
			Snapshot_Builder::cancel();
		}
		$builder = $this->builder();
		if ( Snapshot_Builder::current_job() ) {
			WP_CLI::log( 'Resuming the in-progress job.' );
		} else {
			$job = $builder->start_full();
			if ( is_wp_error( $job ) ) {
				WP_CLI::error( $job->get_error_message() );
			}
		}
		$this->drive( $builder, $budget );
	}

	/**
	 * Applies pending publish/unpublish changes to the live snapshot.
	 *
	 * ## OPTIONS
	 *
	 * [--path=<path>]
	 * : Refresh this site path (repeatable, comma-separated) instead of the pending queue.
	 *
	 * ## EXAMPLES
	 *
	 *     wp lifeboat incremental
	 *     wp lifeboat incremental --path=/,/blog/hello-world/
	 */
	public function incremental( array $args, array $assoc ): void {
		$builder = $this->builder();
		if ( Snapshot_Builder::current_job() ) {
			WP_CLI::log( 'Resuming the in-progress job.' );
		} else {
			if ( ! empty( $assoc['path'] ) ) {
				$paths   = array_map( 'trim', explode( ',', (string) $assoc['path'] ) );
				$deletes = [];
			} else {
				$pending = get_option( Snapshot_Builder::PENDING_OPTION, [] );
				$paths   = (array) ( $pending['paths'] ?? [] );
				$deletes = (array) ( $pending['deletes'] ?? [] );
				if ( ! $paths && ! $deletes ) {
					WP_CLI::success( 'Nothing pending.' );
					return;
				}
			}
			$job = $builder->start_incremental( $paths, $deletes );
			if ( is_wp_error( $job ) ) {
				WP_CLI::error( $job->get_error_message() );
			}
			if ( empty( $assoc['path'] ) ) {
				delete_option( Snapshot_Builder::PENDING_OPTION );
			}
		}
		$this->drive( $builder, max( 5, (int) ( $assoc['budget'] ?? 300 ) ) );
	}

	/**
	 * Shows the promoted snapshot, the current job and the last result.
	 */
	public function status(): void {
		$last = Snapshot_Builder::last_snapshot();
		$job  = Snapshot_Builder::current_job();
		$res  = Snapshot_Builder::last_result();

		WP_CLI::log( 'Bucket prefix:  ' . Settings::prefix() );
		WP_CLI::log( 'R2 configured:  ' . ( Settings::r2_ready() ? 'yes' : 'NO' ) );
		WP_CLI::log( 'Origin URL:     ' . ( Settings::get( 'origin_url' ) ?: '(public URL — set LIFEBOAT_ORIGIN_URL)' ) );
		if ( $last ) {
			WP_CLI::log( sprintf( 'Live snapshot:  %s, promoted %s ago, refreshed %s ago (%d pages, %d assets, %s)', $last['id'], human_time_diff( (int) $last['promoted_at'] ), human_time_diff( (int) $last['updated_at'] ), $last['counts']['pages'], $last['counts']['assets'], size_format( $last['counts']['bytes'] ) ) );
		} else {
			WP_CLI::log( 'Live snapshot:  none' );
		}
		if ( $job ) {
			WP_CLI::log( sprintf( 'Current job:    %s %s — %d processed, %d queued, %d uploaded, %d copied, %d failed', $job['kind'], $job['id'], $job['processed'], count( $job['queue'] ), $job['stats']['uploaded'], $job['stats']['copied'], $job['stats']['failed'] ) );
		} else {
			WP_CLI::log( 'Current job:    none' );
		}
		if ( $res ) {
			WP_CLI::log( sprintf( 'Last result:    %s (%s ago, %ds): %s', $res['ok'] ? 'OK' : 'FAILED', human_time_diff( (int) $res['finished'] ), $res['duration'], $res['message'] ) );
			foreach ( $res['errors'] as $e ) {
				WP_CLI::log( '   ' . $e );
			}
		}
		$pending = get_option( Snapshot_Builder::PENDING_OPTION, [] );
		WP_CLI::log( sprintf( 'Pending incr.:  %d paths, %d deletions', count( (array) ( $pending['paths'] ?? [] ) ), count( (array) ( $pending['deletes'] ?? [] ) ) ) );
		$next = wp_next_scheduled( 'lifeboat_scheduled_build' );
		WP_CLI::log( 'Next WP-Cron build: ' . ( $next ? gmdate( 'c', $next ) : 'not scheduled' ) );
	}

	/**
	 * Lists the seed URLs a full build would start from.
	 */
	public function urls(): void {
		$s     = Settings::all();
		$seeds = ( new Url_Collector( $s, Settings::exclude_patterns(), (int) $s['max_urls'] ) )->seeds();
		foreach ( $seeds as $p ) {
			WP_CLI::line( $p );
		}
		WP_CLI::log( count( $seeds ) . ' seed URLs' );
	}

	/**
	 * Reads current.json from R2 and reports what the Worker would serve.
	 */
	public function verify(): void {
		$r2 = R2_Client::from_settings();
		if ( ! $r2 ) {
			WP_CLI::error( 'R2 is not configured.' );
		}
		$cur = $r2->get_json( Settings::prefix() . '/current.json' );
		if ( is_wp_error( $cur ) ) {
			WP_CLI::error( $cur->get_error_message() );
		}
		WP_CLI::log( 'current.json → snapshot ' . $cur['snapshot_id'] . ' (updated ' . $cur['updated_at'] . ')' );
		foreach ( [ 'index.html', '__404.html', 'manifest.json' ] as $k ) {
			WP_CLI::log( sprintf( '  %-14s %s', $k, $r2->exists( $cur['prefix'] . '/' . $k ) ? 'present' : 'MISSING' ) );
		}
		WP_CLI::success( sprintf( '%d pages, %d assets, %d redirects, %s', $cur['counts']['pages'], $cur['counts']['assets'], $cur['counts']['redirects'], size_format( $cur['counts']['bytes'] ) ) );
	}

	/**
	 * Writes, reads and deletes a probe object to verify the R2 credentials.
	 */
	public function test_r2(): void {
		$r2 = R2_Client::from_settings();
		if ( ! $r2 ) {
			WP_CLI::error( 'R2 is not configured (account id, bucket, access key id, secret).' );
		}
		$key = Settings::prefix() . '/__lifeboat-probe.txt';
		$r   = $r2->put( $key, 'ok ' . gmdate( 'c' ), 'text/plain' );
		if ( is_wp_error( $r ) ) {
			WP_CLI::error( 'PUT failed: ' . $r->get_error_message() );
		}
		$b = $r2->get( $key );
		if ( is_wp_error( $b ) ) {
			WP_CLI::error( 'GET failed: ' . $b->get_error_message() );
		}
		$r2->delete( $key );
		WP_CLI::success( 'R2 write/read/delete OK on bucket ' . $r2->bucket() . '.' );
	}

	/**
	 * Deletes old snapshots beyond the configured retention.
	 *
	 * ## OPTIONS
	 *
	 * [--keep=<n>]
	 * : Snapshots to keep (defaults to the setting).
	 */
	public function prune( array $args, array $assoc ): void {
		if ( isset( $assoc['keep'] ) ) {
			add_filter( 'option_' . Settings::OPTION, static fn( $o ) => array_merge( (array) $o, [ 'keep_snapshots' => (int) $assoc['keep'] ] ) );
		}
		$this->builder()->prune();
		WP_CLI::success( 'Prune finished.' );
	}

	/**
	 * Discards the in-progress job (the promoted snapshot is untouched).
	 */
	public function cancel(): void {
		Snapshot_Builder::cancel();
		WP_CLI::success( 'Job cancelled.' );
	}

	private function builder(): Snapshot_Builder {
		return new Snapshot_Builder( static fn( string $m ) => WP_CLI::log( $m ), 200 );
	}

	private function drive( Snapshot_Builder $builder, int $budget ): void {
		while ( true ) {
			$r = $builder->run( $budget );
			if ( is_wp_error( $r ) ) {
				if ( 'locked' === $r->get_error_code() ) {
					WP_CLI::log( 'Another process holds the build lock; retrying in 15s.' );
					sleep( 15 );
					continue;
				}
				WP_CLI::error( $r->get_error_message() );
			}
			if ( 'idle' === $r['state'] ) {
				WP_CLI::log( 'No job in progress.' );
				return;
			}
			if ( 'done' === $r['state'] ) {
				if ( $r['ok'] ) {
					WP_CLI::success( $r['message'] );
					return;
				}
				WP_CLI::error( $r['message'] );
			}
			WP_CLI::log( sprintf( '… %d processed, %d queued, %d uploaded, %d copied, %d failed', $r['processed'], $r['remaining'], $r['stats']['uploaded'], $r['stats']['copied'], $r['stats']['failed'] ) );
		}
	}
}
