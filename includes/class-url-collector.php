<?php
namespace Lifeboat;

/**
 * Enumerates the URLs a full snapshot starts from, using WordPress internals rather than a blind crawl.
 * Link discovery during the crawl fills in whatever this misses (pagination of archives, custom routes…).
 */
final class Url_Collector {

	private array $s;
	private array $exclude;
	private int $max;
	private string $host;

	public function __construct( array $s, array $exclude, int $max ) {
		$this->s       = $s;
		$this->exclude = $exclude;
		$this->max     = $max;
		$this->host    = Settings::host();
	}

	/** @return string[] decoded site paths, home first, unique, eligible. */
	public function seeds(): array {
		$urls = [
			home_url( '/' ),
			home_url( '/feed/' ),
			home_url( '/robots.txt' ),
			home_url( '/favicon.ico' ),
		];

		if ( function_exists( 'wp_sitemaps_get_server' ) && wp_sitemaps_get_server()->sitemaps_enabled() ) {
			$urls[] = home_url( '/wp-sitemap.xml' );
		}
		if ( defined( 'WPSEO_VERSION' ) || class_exists( 'RankMath' ) ) {
			$urls[] = home_url( '/sitemap_index.xml' );
		}

		foreach ( $this->post_types() as $type ) {
			$paged = 1;
			do {
				$q = new \WP_Query(
					[
						'post_type'              => $type,
						'post_status'            => 'publish',
						'has_password'           => false,
						'posts_per_page'         => 500,
						'paged'                  => $paged,
						'fields'                 => 'ids',
						'orderby'                => 'ID',
						'order'                  => 'ASC',
						'no_found_rows'          => true,
						'ignore_sticky_posts'    => true,
						'update_post_meta_cache' => false,
						'update_post_term_cache' => false,
					]
				);
				foreach ( $q->posts as $id ) {
					$u = get_permalink( $id );
					if ( $u ) {
						$urls[] = $u;
					}
				}
				$paged++;
			} while ( 500 === count( $q->posts ) && count( $urls ) < $this->max );

			$archive = get_post_type_archive_link( $type );
			if ( $archive ) {
				$urls[] = $archive;
			}
		}

		foreach ( get_taxonomies( [ 'public' => true ], 'names' ) as $tax ) {
			$terms = get_terms(
				[
					'taxonomy'   => $tax,
					'hide_empty' => true,
					'fields'     => 'ids',
				]
			);
			if ( is_wp_error( $terms ) ) {
				continue;
			}
			foreach ( $terms as $tid ) {
				$link = get_term_link( (int) $tid, $tax );
				if ( ! is_wp_error( $link ) ) {
					$urls[] = $link;
				}
			}
		}

		foreach ( get_users( [ 'has_published_posts' => true, 'fields' => 'ID' ] ) as $uid ) {
			$urls[] = get_author_posts_url( (int) $uid );
		}

		if ( 'posts' === get_option( 'show_on_front' ) ) {
			$per_page = max( 1, (int) get_option( 'posts_per_page' ) );
			$total    = (int) ( wp_count_posts( 'post' )->publish ?? 0 );
			$pages    = min( 500, (int) ceil( $total / $per_page ) );
			for ( $i = 2; $i <= $pages; $i++ ) {
				$urls[] = home_url( user_trailingslashit( "page/$i", 'paged' ) );
			}
		}

		foreach ( preg_split( '/\r\n|\r|\n/', (string) $this->s['extra_urls'] ) as $line ) {
			$line = trim( $line );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			$u = Keys::absolutize( $line, home_url( '/' ) );
			if ( $u ) {
				$urls[] = $u;
			}
		}

		$urls  = (array) apply_filters( 'lifeboat_seed_urls', $urls );
		$paths = [];
		foreach ( $urls as $u ) {
			if ( ! is_string( $u ) || Keys::has_query( $u ) ) {
				continue;
			}
			$p = Keys::to_site_path( $u, $this->host );
			if ( null === $p || isset( $paths[ $p ] ) || Keys::excluded( $p, $this->exclude ) ) {
				continue;
			}
			$paths[ $p ] = 1;
			if ( count( $paths ) >= $this->max ) {
				break;
			}
		}
		return array_keys( $paths );
	}

	/** @return string[] viewable post types, attachments excluded. */
	private function post_types(): array {
		$types = array_filter( get_post_types( [ 'public' => true ], 'names' ), 'is_post_type_viewable' );
		unset( $types['attachment'] );
		return (array) apply_filters( 'lifeboat_post_types', array_values( $types ) );
	}
}
