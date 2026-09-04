<?php
namespace Lifeboat;

final class Plugin {

	private static ?Plugin $instance = null;

	public static function instance(): self {
		return self::$instance ??= new self();
	}

	public function boot(): void {
		add_filter( 'cron_schedules', [ $this, 'cron_schedules' ] );
		add_action( 'lifeboat_scheduled_build', [ $this, 'cron_scheduled_build' ] );
		add_action( 'lifeboat_full_rebuild', [ $this, 'cron_scheduled_build' ] );
		add_action( 'lifeboat_run_job', [ $this, 'cron_run_job' ] );
		add_action( 'lifeboat_incremental', [ $this, 'cron_incremental' ] );
		add_action( 'rest_api_init', [ Health::class, 'register' ] );
		add_action( 'update_option_' . Settings::OPTION, [ $this, 'reschedule' ] );

		if ( Settings::get( 'incremental' ) ) {
			add_action( 'transition_post_status', [ $this, 'on_transition' ], 10, 3 );
			add_action( 'wp_trash_post', [ $this, 'on_remove' ] );
			add_action( 'before_delete_post', [ $this, 'on_remove' ] );
			add_action( 'customize_save_after', [ $this, 'request_full_rebuild' ] );
			add_action( 'switch_theme', [ $this, 'request_full_rebuild' ] );
			add_action( 'wp_update_nav_menu', [ $this, 'request_full_rebuild' ] );
		}

		if ( is_admin() ) {
			( new Admin() )->register();
		}
		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			\WP_CLI::add_command( 'lifeboat', Cli::class );
		}
	}

	public static function activate(): void {
		$opt = get_option( Settings::OPTION, [] );
		$opt = is_array( $opt ) ? $opt : [];
		if ( empty( $opt['crawl_secret'] ) ) {
			$opt['crawl_secret'] = wp_generate_password( 32, false );
			update_option( Settings::OPTION, $opt );
		}
		self::instance()->reschedule();
	}

	public static function deactivate(): void {
		foreach ( [ 'lifeboat_scheduled_build', 'lifeboat_full_rebuild', 'lifeboat_run_job', 'lifeboat_incremental' ] as $hook ) {
			wp_clear_scheduled_hook( $hook );
		}
		Lock::release( Snapshot_Builder::LOCK );
	}

	/* ---------------------------------------------------------------- scheduling */

	public function cron_schedules( array $schedules ): array {
		$hours                          = max( 1, (int) Settings::get( 'schedule_hours' ) );
		$schedules['lifeboat_interval'] = [
			'interval' => $hours * HOUR_IN_SECONDS,
			'display'  => sprintf( 'Every %d hours (Lifeboat)', $hours ),
		];
		return $schedules;
	}

	/** (Re)create the recurring full-build event according to the settings. */
	public function reschedule(): void {
		wp_clear_scheduled_hook( 'lifeboat_scheduled_build' );
		if ( (int) Settings::get( 'schedule_hours' ) > 0 && Settings::get( 'use_wp_cron' ) ) {
			wp_schedule_event( time() + 5 * MINUTE_IN_SECONDS, 'lifeboat_interval', 'lifeboat_scheduled_build' );
		}
	}

	/** Schedule the next work slice for the current job. */
	public function kick_job( int $delay = 0 ): void {
		if ( ! wp_next_scheduled( 'lifeboat_run_job' ) ) {
			wp_schedule_single_event( time() + $delay, 'lifeboat_run_job' );
		}
	}

	public function cron_scheduled_build(): void {
		if ( Snapshot_Builder::current_job() ) {
			return;
		}
		$job = ( new Snapshot_Builder() )->start_full();
		if ( is_wp_error( $job ) ) {
			if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
				error_log( '[lifeboat] ' . $job->get_error_message() );
			}
			return;
		}
		$this->cron_run_job();
	}

	public function cron_run_job(): void {
		$result = ( new Snapshot_Builder( null, 25 ) )->run( max( 5, (int) Settings::get( 'time_budget' ) ) );
		if ( is_wp_error( $result ) ) {
			if ( 'locked' === $result->get_error_code() ) {
				$this->kick_job( 60 );
			}
			return;
		}
		if ( 'running' === $result['state'] ) {
			$this->kick_job( 5 );
		}
	}

	public function cron_incremental(): void {
		if ( Snapshot_Builder::current_job() ) {
			wp_schedule_single_event( time() + MINUTE_IN_SECONDS, 'lifeboat_incremental' );
			return;
		}
		$pending = get_option( Snapshot_Builder::PENDING_OPTION, [] );
		$paths   = (array) ( $pending['paths'] ?? [] );
		$deletes = (array) ( $pending['deletes'] ?? [] );
		if ( ! $paths && ! $deletes ) {
			return;
		}
		$job = ( new Snapshot_Builder() )->start_incremental( $paths, $deletes );
		if ( is_wp_error( $job ) ) {
			if ( 'busy' !== $job->get_error_code() ) {
				delete_option( Snapshot_Builder::PENDING_OPTION ); // e.g. no snapshot yet: the next full build covers it
			}
			return;
		}
		delete_option( Snapshot_Builder::PENDING_OPTION );
		$this->cron_run_job();
	}

	/* ---------------------------------------------------------------- content change triggers */

	public function on_transition( string $new_status, string $old_status, \WP_Post $post ): void {
		if ( 'publish' !== $new_status && 'publish' !== $old_status ) {
			return;
		}
		if ( 'trash' === $new_status || wp_is_post_revision( $post ) || wp_is_post_autosave( $post ) ) {
			return; // trash is handled by on_remove() before the slug changes
		}
		if ( ! is_post_type_viewable( $post->post_type ) ) {
			return;
		}
		$self  = $this->permalink_path( $post );
		$paths = $this->affected_paths( $post );
		if ( 'publish' === $new_status ) {
			$this->queue_incremental( $paths, [] );
		} else {
			$this->queue_incremental( array_values( array_diff( $paths, [ $self ] ) ), $self ? [ $self ] : [] );
		}
	}

	/** wp_trash_post / before_delete_post: fires before the post changes, so the permalink is still correct. */
	public function on_remove( int $post_id ): void {
		$post = get_post( $post_id );
		if ( ! $post || 'publish' !== $post->post_status || ! is_post_type_viewable( $post->post_type ) ) {
			return;
		}
		$self = $this->permalink_path( $post );
		$this->queue_incremental( array_values( array_diff( $this->affected_paths( $post ), [ $self ] ) ), $self ? [ $self ] : [] );
	}

	/** Theme, customizer or menu changes touch every page: schedule a debounced full rebuild. */
	public function request_full_rebuild(): void {
		if ( ! wp_next_scheduled( 'lifeboat_full_rebuild' ) ) {
			wp_schedule_single_event( time() + 5 * max( 10, (int) Settings::get( 'debounce' ) ), 'lifeboat_full_rebuild' );
		}
	}

	/**
	 * Add paths to the pending incremental queue and (re)arm the debounced event.
	 * @param string[] $paths decoded site paths to refresh
	 * @param string[] $deletes decoded site paths to remove
	 */
	public function queue_incremental( array $paths, array $deletes ): void {
		$pending = get_option( Snapshot_Builder::PENDING_OPTION, [] );
		$pending = is_array( $pending ) ? $pending : [];

		$all_paths   = array_unique( array_merge( (array) ( $pending['paths'] ?? [] ), $paths ) );
		$all_deletes = array_unique( array_merge( array_diff( (array) ( $pending['deletes'] ?? [] ), $paths ), $deletes ) );
		$all_paths   = array_diff( $all_paths, $deletes );

		update_option(
			Snapshot_Builder::PENDING_OPTION,
			[
				'paths'   => array_values( $all_paths ),
				'deletes' => array_values( $all_deletes ),
			],
			false
		);
		if ( ! wp_next_scheduled( 'lifeboat_incremental' ) ) {
			wp_schedule_single_event( time() + max( 10, (int) Settings::get( 'debounce' ) ), 'lifeboat_incremental' );
		}
	}

	private function permalink_path( \WP_Post $post ): ?string {
		$copy              = clone $post;
		$copy->post_status = 'publish'; // draft/pending posts would otherwise yield ?p= links
		$url               = get_permalink( $copy );
		return $url ? Keys::to_site_path( $url, Settings::host() ) : null;
	}

	/** @return string[] decoded site paths whose rendered output includes this post. */
	private function affected_paths( \WP_Post $post ): array {
		$host = Settings::host();
		$urls = [ home_url( '/' ), home_url( '/feed/' ) ];

		$archive = get_post_type_archive_link( $post->post_type );
		if ( $archive ) {
			$urls[] = $archive;
		}
		if ( $post->post_author && post_type_supports( $post->post_type, 'author' ) ) {
			$urls[] = get_author_posts_url( (int) $post->post_author );
		}
		foreach ( get_object_taxonomies( $post->post_type, 'objects' ) as $tax ) {
			if ( empty( $tax->public ) ) {
				continue;
			}
			$terms = get_the_terms( $post, $tax->name );
			if ( is_array( $terms ) ) {
				foreach ( $terms as $term ) {
					$link = get_term_link( $term );
					if ( ! is_wp_error( $link ) ) {
						$urls[] = $link;
					}
				}
			}
		}
		if ( $post->post_parent ) {
			$parent = get_permalink( $post->post_parent );
			if ( $parent ) {
				$urls[] = $parent;
			}
		}

		$paths = [];
		foreach ( (array) apply_filters( 'lifeboat_affected_urls', $urls, $post ) as $u ) {
			if ( ! is_string( $u ) || Keys::has_query( $u ) ) {
				continue;
			}
			$p = Keys::to_site_path( $u, $host );
			if ( null !== $p ) {
				$paths[] = $p;
			}
		}
		$self = $this->permalink_path( $post );
		if ( $self ) {
			$paths[] = $self;
		}
		return array_values( array_unique( $paths ) );
	}
}
