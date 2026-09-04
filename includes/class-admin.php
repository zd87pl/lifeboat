<?php
namespace Lifeboat;

/**
 * Settings → Lifeboat: configuration, status and manual actions.
 */
final class Admin {

	private const PAGE = 'lifeboat';

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'menu' ] );
		add_action( 'admin_init', [ $this, 'settings' ] );
		add_action( 'admin_post_lifeboat_action', [ $this, 'handle_action' ] );
		add_action( 'admin_notices', [ $this, 'notices' ] );
	}

	public function menu(): void {
		add_options_page( 'Lifeboat', 'Lifeboat', 'manage_options', self::PAGE, [ $this, 'render' ] );
	}

	public function settings(): void {
		register_setting( self::PAGE, Settings::OPTION, [ 'sanitize_callback' => [ $this, 'sanitize' ] ] );

		add_settings_section( 'r2', 'Cloudflare R2', static function (): void {
			echo '<p>Create an R2 API token with <em>Object Read &amp; Write</em> scoped to one bucket. Values defined as constants in wp-config.php (LIFEBOAT_R2_ACCOUNT_ID, LIFEBOAT_R2_BUCKET, LIFEBOAT_R2_ACCESS_KEY_ID, LIFEBOAT_R2_SECRET_ACCESS_KEY, LIFEBOAT_ORIGIN_URL, LIFEBOAT_PREFIX) override the fields below.</p>';
		}, self::PAGE );
		$this->field( 'r2_account_id', 'Account ID', 'r2', 'text' );
		$this->field( 'r2_bucket', 'Bucket', 'r2', 'text' );
		$this->field( 'r2_access_key_id', 'Access key ID', 'r2', 'text' );
		$this->field( 'r2_secret_access_key', 'Secret access key', 'r2', 'secret', 'Leave blank to keep the stored value.' );
		$this->field( 'prefix', 'Bucket prefix', 'r2', 'text', 'Defaults to sites/' . Settings::host() . '. One bucket can hold many sites.' );

		add_settings_section( 'crawl', 'Crawling', static function (): void {
			echo '<p>The crawler fetches pages as an anonymous visitor. Point it at the origin directly (loopback) so it never goes through Cloudflare — otherwise it could snapshot the fallback itself.</p>';
		}, self::PAGE );
		$this->field( 'origin_url', 'Origin URL (loopback)', 'crawl', 'text', 'e.g. https://127.0.0.1 or https://origin.internal — the Host header is set to ' . Settings::host() . '. Blank = fetch the public URL.' );
		$this->field( 'origin_ssl_verify', 'Verify origin TLS certificate', 'crawl', 'checkbox', 'Usually off for 127.0.0.1 loopback.' );
		$this->field( 'max_urls', 'Max URLs per snapshot', 'crawl', 'number' );
		$this->field( 'max_asset_mb', 'Max object size (MB)', 'crawl', 'number', 'Larger files are skipped.' );
		$this->field( 'extra_urls', 'Extra URLs', 'crawl', 'textarea', 'One per line (absolute or path). Use for routes WordPress cannot enumerate, e.g. /sitemap_index.xml.' );
		$this->field( 'exclude', 'Exclude patterns', 'crawl', 'textarea', 'One regex per line, matched against the decoded path (e.g. ^/members/ ). wp-admin, wp-json, feeds other than /feed/ and *.php are always excluded.' );

		add_settings_section( 'sched', 'Scheduling &amp; promotion', static function (): void {
			echo '<p>Recommended: run <code>wp lifeboat build</code> from system cron and keep WP-Cron only for incremental updates (see README). WP-Cron builds work in slices of the time budget below.</p>';
		}, self::PAGE );
		$this->field( 'schedule_hours', 'Full snapshot every (hours)', 'sched', 'number', '0 disables the WP-Cron schedule.' );
		$this->field( 'use_wp_cron', 'Schedule full builds with WP-Cron', 'sched', 'checkbox', 'Untick if system cron runs wp lifeboat build.' );
		$this->field( 'time_budget', 'WP-Cron time budget (seconds)', 'sched', 'number', '20 for HTTP-triggered wp-cron.php; 300+ when wp cron event run --due-now is used.' );
		$this->field( 'incremental', 'Update on publish', 'sched', 'checkbox', 'Re-snapshot the changed post, home, feed, term and author pages shortly after publishing.' );
		$this->field( 'debounce', 'Publish debounce (seconds)', 'sched', 'number' );
		$this->field( 'keep_snapshots', 'Snapshots to keep', 'sched', 'number' );
		$this->field( 'max_error_pct', 'Max failed uploads (%)', 'sched', 'number', 'A build with more failures, or any failed page, is not promoted; the previous snapshot stays live.' );
	}

	private function field( string $key, string $label, string $section, string $type, string $help = '' ): void {
		add_settings_field(
			$key,
			$label,
			function () use ( $key, $type, $help ): void {
				$this->input( $key, $type, $help );
			},
			self::PAGE,
			$section
		);
	}

	private function input( string $key, string $type, string $help ): void {
		$value    = Settings::get( $key );
		$name     = Settings::OPTION . '[' . $key . ']';
		$constant = Settings::is_constant( $key );
		$disabled = $constant ? ' disabled' : '';
		if ( $constant ) {
			$help = 'Defined in wp-config.php. ' . $help;
		}
		switch ( $type ) {
			case 'checkbox':
				printf( '<label><input type="checkbox" name="%s" value="1"%s%s> %s</label>', esc_attr( $name ), checked( (int) $value, 1, false ), $disabled, esc_html( $help ) );
				return;
			case 'textarea':
				printf( '<textarea name="%s" rows="4" class="large-text code"%s>%s</textarea>', esc_attr( $name ), $disabled, esc_textarea( (string) $value ) );
				break;
			case 'secret':
				printf( '<input type="password" name="%s" value="" class="regular-text" autocomplete="new-password" placeholder="%s"%s>', esc_attr( $name ), '' !== (string) $value ? '••••••••••••' : '', $disabled );
				break;
			case 'number':
				printf( '<input type="number" name="%s" value="%s" class="small-text"%s>', esc_attr( $name ), esc_attr( (string) $value ), $disabled );
				break;
			default:
				printf( '<input type="text" name="%s" value="%s" class="regular-text code"%s>', esc_attr( $name ), esc_attr( (string) $value ), $disabled );
		}
		if ( '' !== $help ) {
			printf( '<p class="description">%s</p>', esc_html( $help ) );
		}
	}

	public function sanitize( $input ): array {
		$stored = get_option( Settings::OPTION, [] );
		$out    = array_merge( Settings::defaults(), is_array( $stored ) ? $stored : [] );
		$input  = is_array( $input ) ? $input : [];

		foreach ( Settings::defaults() as $key => $default ) {
			if ( Settings::is_constant( $key ) ) {
				continue;
			}
			if ( in_array( $key, Settings::CHECKBOXES, true ) ) {
				$out[ $key ] = empty( $input[ $key ] ) ? 0 : 1;
				continue;
			}
			if ( ! array_key_exists( $key, $input ) ) {
				continue;
			}
			$value = $input[ $key ];
			if ( 'r2_secret_access_key' === $key ) {
				if ( '' !== trim( (string) $value ) ) {
					$out[ $key ] = trim( (string) $value );
				}
				continue;
			}
			$out[ $key ] = is_int( $default ) ? (int) $value : trim( (string) $value );
		}

		$out['schedule_hours'] = max( 0, min( 168, (int) $out['schedule_hours'] ) );
		$out['time_budget']    = max( 5, min( 3600, (int) $out['time_budget'] ) );
		$out['max_urls']       = max( 10, (int) $out['max_urls'] );
		$out['max_asset_mb']   = max( 1, (int) $out['max_asset_mb'] );
		$out['keep_snapshots'] = max( 1, (int) $out['keep_snapshots'] );
		$out['max_error_pct']  = max( 0, min( 100, (int) $out['max_error_pct'] ) );
		$out['debounce']       = max( 10, (int) $out['debounce'] );
		$out['prefix']         = trim( (string) $out['prefix'], "/ \t" );
		$out['origin_url']     = rtrim( (string) $out['origin_url'], '/' );
		if ( '' !== $out['origin_url'] && ! preg_match( '#^https?://#i', $out['origin_url'] ) ) {
			add_settings_error( self::PAGE, 'origin_url', 'Origin URL must start with http:// or https://.' );
			$out['origin_url'] = '';
		}
		if ( '' === (string) $out['crawl_secret'] ) {
			$out['crawl_secret'] = wp_generate_password( 32, false );
		}
		return $out;
	}

	/* ---------------------------------------------------------------- actions */

	public function handle_action(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Insufficient permissions.' );
		}
		check_admin_referer( 'lifeboat_action' );
		$what = sanitize_key( $_POST['what'] ?? '' );
		$type = 'success';

		switch ( $what ) {
			case 'build':
				$job = ( new Snapshot_Builder() )->start_full();
				if ( is_wp_error( $job ) ) {
					$type = 'error';
					$msg  = $job->get_error_message();
				} else {
					Plugin::instance()->kick_job();
					spawn_cron();
					$msg = sprintf( 'Full snapshot %s started with %d seed URLs. It runs in WP-Cron slices; run "wp lifeboat build" to finish it faster.', $job['id'], count( $job['queue'] ) );
				}
				break;
			case 'incremental':
				$pending = get_option( Snapshot_Builder::PENDING_OPTION, [] );
				$n       = count( (array) ( $pending['paths'] ?? [] ) ) + count( (array) ( $pending['deletes'] ?? [] ) );
				Plugin::instance()->cron_incremental();
				$msg = $n ? "Processing $n pending change(s)." : 'Nothing pending.';
				break;
			case 'cancel':
				Snapshot_Builder::cancel();
				$msg = 'Job cancelled. The promoted snapshot is untouched.';
				break;
			case 'prune':
				( new Snapshot_Builder() )->prune();
				$msg = 'Old snapshots pruned.';
				break;
			case 'test':
				$r2 = R2_Client::from_settings();
				if ( ! $r2 ) {
					$type = 'error';
					$msg  = 'R2 is not configured.';
					break;
				}
				$key = Settings::prefix() . '/__lifeboat-probe.txt';
				$r   = $r2->put( $key, 'ok ' . gmdate( 'c' ), 'text/plain' );
				if ( ! is_wp_error( $r ) ) {
					$r = $r2->get( $key );
					$r2->delete( $key );
				}
				if ( is_wp_error( $r ) ) {
					$type = 'error';
					$msg  = 'R2 test failed: ' . $r->get_error_message();
				} else {
					$msg = 'R2 write/read/delete succeeded.';
				}
				break;
			case 'probe':
				$path = '/';
				$res  = ( new Crawler( Settings::all() ) )->fetch( $path );
				if ( is_wp_error( $res ) ) {
					$type = 'error';
					$msg  = 'Origin fetch failed: ' . $res->get_error_message();
				} elseif ( $res['status'] >= 300 && $res['status'] < 400 ) {
					$type = 'warning';
					$msg  = sprintf( 'Origin answered %d → %s for %s. Redirect loops usually mean forced-HTTPS rules or a wrong origin URL.', $res['status'], $res['location'], $path );
				} else {
					$msg = sprintf( 'Origin answered %d (%s, %s) for %s.', $res['status'], $res['type'], size_format( strlen( $res['body'] ) ), $path );
				}
				break;
			default:
				$type = 'error';
				$msg  = 'Unknown action.';
		}

		set_transient( 'lifeboat_notice_' . get_current_user_id(), [ 'type' => $type, 'msg' => $msg ], MINUTE_IN_SECONDS );
		wp_safe_redirect( admin_url( 'options-general.php?page=' . self::PAGE ) );
		exit;
	}

	/* ---------------------------------------------------------------- output */

	public function notices(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$screen = get_current_screen();
		$here   = $screen && 'settings_page_' . self::PAGE === $screen->id;

		if ( $here ) {
			$n = get_transient( 'lifeboat_notice_' . get_current_user_id() );
			if ( is_array( $n ) ) {
				delete_transient( 'lifeboat_notice_' . get_current_user_id() );
				printf( '<div class="notice notice-%s is-dismissible"><p>%s</p></div>', esc_attr( $n['type'] ), esc_html( $n['msg'] ) );
			}
		}
		if ( ! $here && ( ! $screen || 'dashboard' !== $screen->id ) ) {
			return;
		}

		$link = '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">Lifeboat</a>';
		$last = Snapshot_Builder::last_snapshot();
		$res  = Snapshot_Builder::last_result();
		$h    = (int) Settings::get( 'schedule_hours' );
		if ( $last && $h > 0 && time() - (int) $last['updated_at'] > 2 * $h * HOUR_IN_SECONDS ) {
			printf( '<div class="notice notice-warning"><p>%s: the failover snapshot is stale (last refreshed %s ago; the schedule is every %d h).</p></div>', $link, esc_html( human_time_diff( (int) $last['updated_at'] ) ), $h );
		}
		if ( $res && empty( $res['ok'] ) ) {
			printf( '<div class="notice notice-error"><p>%s: the last %s job failed — %s</p></div>', $link, esc_html( $res['kind'] ), esc_html( $res['message'] ) );
		}
		if ( ! $last && ! Snapshot_Builder::current_job() && Settings::r2_ready() ) {
			printf( '<div class="notice notice-info"><p>%s: no failover snapshot exists yet. Run <code>wp lifeboat build</code> or click “Build snapshot now”.</p></div>', $link );
		}
	}

	public function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$last    = Snapshot_Builder::last_snapshot();
		$job     = Snapshot_Builder::current_job();
		$res     = Snapshot_Builder::last_result();
		$pending = get_option( Snapshot_Builder::PENDING_OPTION, [] );
		$next    = wp_next_scheduled( 'lifeboat_scheduled_build' );
		$rows    = [];

		$rows['R2']            = Settings::r2_ready() ? 'configured — prefix <code>' . esc_html( Settings::prefix() ) . '</code>' : '<strong>not configured</strong>';
		$rows['Permalinks']    = get_option( 'permalink_structure' ) ? 'pretty permalinks on' : '<strong>pretty permalinks are required</strong>';
		$rows['WP-Cron']       = ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) ? 'disabled in wp-config (system cron must run <code>wp cron event run --due-now</code>)' : 'triggered by page loads';
		$rows['Live snapshot'] = $last
			? sprintf( '<code>%s</code> — promoted %s ago, refreshed %s ago; %d pages, %d assets, %d redirects, %s', esc_html( $last['id'] ), esc_html( human_time_diff( (int) $last['promoted_at'] ) ), esc_html( human_time_diff( (int) $last['updated_at'] ) ), (int) $last['counts']['pages'], (int) $last['counts']['assets'], (int) $last['counts']['redirects'], esc_html( size_format( (int) $last['counts']['bytes'] ) ) )
			: 'none yet';
		$rows['Current job']   = $job
			? sprintf( '%s <code>%s</code> — %d processed, %d queued, %d uploaded, %d copied, %d failed (started %s ago)', esc_html( $job['kind'] ), esc_html( $job['id'] ), (int) $job['processed'], count( $job['queue'] ), (int) $job['stats']['uploaded'], (int) $job['stats']['copied'], (int) $job['stats']['failed'], esc_html( human_time_diff( (int) $job['started'] ) ) )
			: 'none';
		$rows['Last result']   = $res
			? sprintf( '<strong>%s</strong> — %s (%s ago, %ds)', $res['ok'] ? 'OK' : 'FAILED', esc_html( $res['message'] ), esc_html( human_time_diff( (int) $res['finished'] ) ), (int) $res['duration'] )
			: '—';
		$rows['Pending']       = sprintf( '%d paths, %d deletions waiting for the next incremental run', count( (array) ( $pending['paths'] ?? [] ) ), count( (array) ( $pending['deletes'] ?? [] ) ) );
		$rows['Next build']    = $next ? esc_html( wp_date( 'Y-m-d H:i', $next ) ) . ' (WP-Cron)' : 'not scheduled by WP-Cron';
		$rows['Health URL']    = '<code>' . esc_html( rest_url( 'lifeboat/v1/health' ) ) . '</code>';

		echo '<div class="wrap"><h1>Lifeboat</h1>';
		echo '<h2>Status</h2><table class="widefat striped" style="max-width:1000px"><tbody>';
		foreach ( $rows as $label => $html ) {
			printf( '<tr><th style="width:160px">%s</th><td>%s</td></tr>', esc_html( $label ), $html ); // phpcs:ignore -- escaped above
		}
		echo '</tbody></table>';

		if ( $res && ! empty( $res['errors'] ) ) {
			echo '<details style="max-width:1000px;margin-top:8px"><summary>Last job warnings (' . count( $res['errors'] ) . ')</summary><pre style="white-space:pre-wrap">' . esc_html( implode( "\n", $res['errors'] ) ) . '</pre></details>';
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin:12px 0 24px">';
		echo '<input type="hidden" name="action" value="lifeboat_action">';
		wp_nonce_field( 'lifeboat_action' );
		$buttons = [
			'build'       => [ 'Build snapshot now', 'primary' ],
			'incremental' => [ 'Run pending incremental', 'secondary' ],
			'test'        => [ 'Test R2 connection', 'secondary' ],
			'probe'       => [ 'Test origin fetch', 'secondary' ],
			'prune'       => [ 'Prune old snapshots', 'secondary' ],
			'cancel'      => [ 'Cancel current job', 'secondary' ],
		];
		foreach ( $buttons as $what => [ $label, $style ] ) {
			printf( '<button type="submit" name="what" value="%s" class="button button-%s" style="margin-right:6px">%s</button>', esc_attr( $what ), esc_attr( $style ), esc_html( $label ) );
		}
		echo '</form>';

		echo '<form method="post" action="options.php">';
		settings_fields( self::PAGE );
		do_settings_sections( self::PAGE );
		submit_button();
		echo '</form></div>';
	}
}
