const DEFAULT_ORIGIN_TIMEOUT_MS = 7_000;
const BREAKER_TTL_MS = 30_000;
const MAX_POINTER_BYTES = 64 * 1024;
const DEFAULT_POINTER_TTL_MS = 5_000;
const DEFAULT_SITE_TTL_MS = 60_000;
const KV_CACHE_TTL_S = 60;
const MAX_MEMO_ENTRIES = 10_000;
const EDGE_CACHE_TTL_S = 7 * 24 * 60 * 60;
const DEFAULT_INGEST_MAX_BYTES = 100 * 1024 * 1024;
const MAX_INGEST_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 1024;
const MAX_LIST_ENTRIES = 50;

// Cloudflare may reuse an isolate for many requests. These intentionally remain
// local to the isolate: they are fast pressure-release valves, not durable state.
const breakerUntil = new Map();
const pointerCache = new WeakMap();
const siteCache = new WeakMap();

const MODES = new Set(["failover", "edge"]);
const AI_POLICIES = new Set(["origin", "edge", "edge-only", "block"]);

// User-agent tokens of AI crawlers and of AI agents fetching pages for a user.
// Matching can only narrow what a client reaches (the snapshot instead of the
// origin, or nothing), so a spoofed user agent gains nothing.
const AI_CRAWLER = /\b(?:GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|meta-externalagent|meta-externalfetcher|FacebookBot|Google-CloudVertexBot|cohere-ai|cohere-training-data-crawler|Diffbot|YouBot|AI2Bot|Ai2Bot-Dolma|DuckAssistBot|MistralAI-User|PanguBot|Timpibot|ImagesiftBot|omgilibot|Webzio-Extended|TikTokSpider|Kangaroo Bot|iaskspider|QualifiedBot|Novellum|FirecrawlAgent)\b/i;

// Campaign parameters never change what WordPress renders, so they must not
// turn an otherwise public page view into an origin request.
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|srsltid|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi|_ke|mkt_tok)$/i;

// Cookies meaning the visitor sees something a public snapshot cannot show: a
// session, a cart, a password-protected post, or their own pending comment.
const DYNAMIC_COOKIE_PREFIXES = [
  "wordpress_logged_in_",
  "wp-postpass_",
  "comment_author_",
  "woocommerce_items_in_cart",
  "woocommerce_cart_hash",
  "wp_woocommerce_session_",
  "edd_items_in_cart",
];

// Mirrors Lifeboat\Keys::ASSET_EXT. A query string on these (usually a ?ver=
// cache buster) addresses the same file, exactly as the origin's web server does.
const ASSET_EXTENSIONS = new Set([
  "css", "js", "mjs", "map", "json", "xml", "txt", "ico", "webmanifest", "wasm", "vtt",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "tif", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "m4a", "m4v", "webm", "ogg", "ogv", "wav",
  "pdf", "zip", "gz", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv",
]);

const FALLBACK_BANNER = `
<aside id="lifeboat-saved-copy" role="status" style="box-sizing:border-box;position:relative;z-index:2147483647;width:100%;padding:.75rem 1rem;background:#fff4cc;color:#332b00;border-bottom:1px solid #dcc468;font:600 14px/1.4 system-ui,sans-serif;text-align:center">
  The live site is temporarily unavailable. You are viewing a saved, read-only copy.
</aside>`;

const READ_ONLY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site temporarily unavailable</title><style>body{box-sizing:border-box;max-width:44rem;margin:12vh auto;padding:2rem;font:18px/1.55 system-ui,sans-serif;color:#202124}h1{line-height:1.2}p{color:#4b4f52}</style></head>
<body><main><h1>This site is temporarily read-only</h1><p>The live site and its saved copy are unavailable right now. Please try again shortly.</p></main></body></html>`;

/**
 * Cloudflare Workers module entry point.
 *
 * Bindings:
 * - SNAPSHOTS (required): R2 bucket containing Lifeboat snapshots.
 * - SITES (optional): KV records keyed by the exact lowercase incoming hostname.
 * - DEFAULT_HOST / DEFAULT_ORIGIN: single-site configuration, optionally with
 *   DEFAULT_MODE, DEFAULT_AI, DEFAULT_BYPASS_PATHS, DEFAULT_BYPASS_COOKIES,
 *   DEFAULT_INGEST_KEY_SHA256 and DEFAULT_EDGE_SECRET (see parseSiteRecord).
 * - CRAWL_SECRET (optional): exact secret required for crawler pass-through.
 * - INGEST_HOST (optional): dedicated hostname for the snapshot ingest API.
 * - METRICS (optional): Workers Analytics Engine dataset for per-site metering.
 */
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = undefined) {
  const outcome = await dispatch(request, env, ctx);
  meter(env, outcome);
  return outcome.response;
}

async function dispatch(request, env, ctx) {
  let url;
  let decodedPath;
  try {
    url = new URL(request.url);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return { response: badRequest(request.method) };
  }

  const incomingHost = url.hostname.toLowerCase();
  const ingestHost = configuredHostname(env.INGEST_HOST);
  if (ingestHost && incomingHost === ingestHost) {
    return { response: await handleIngest(request, env, url) };
  }

  let site;
  try {
    site = await resolveSite(incomingHost, env);
  } catch {
    return { response: readOnlyResponse(request.method) };
  }

  // An unconfigured hostname must never inherit another site's origin or R2
  // prefix. This is the central isolation rule for multi-site deployments.
  if (!site) {
    return { response: readOnlyResponse(request.method) };
  }

  if (site.redirectTo) {
    const location = redirectLocation(site.redirectTo, url);
    const response = location
      ? new Response(null, { status: 301, headers: { Location: location } })
      : readOnlyResponse(request.method);
    return { response, site, route: "redirect", ai: false };
  }

  if (!site.origin) {
    return { response: readOnlyResponse(request.method), site, route: "readonly", ai: false };
  }

  const { route, ai, policy } = routeRequest(request, url, decodedPath, site, env.CRAWL_SECRET);
  // Under an edge policy a crawler gets the plain copy: no outage banner, and
  // the anonymous version of pages the origin keeps private. Under "origin" it
  // is treated exactly like any other visitor.
  const crawler = ai && policy !== "origin";
  const state = { request, env, ctx, site, url, decodedPath, crawler };
  let result;
  if (route === "blocked") {
    result = { response: blockedResponse(request.method), route: "blocked" };
  } else if (route === "edge" || route === "edge-only") {
    result = await serveEdge(state, route === "edge-only");
  } else {
    result = await originFirst(state, route === "private");
  }
  return { ...result, site, ai };
}

/**
 * Decide how a request is answered:
 * - "private":   origin only, never a public snapshot (admin, APIs, mutations, sessions).
 * - "origin":    origin first; the snapshot only when the origin fails.
 * - "edge":      snapshot first; the origin for whatever the snapshot lacks or keeps private.
 * - "edge-only": snapshot only (AI crawlers under the "edge-only" policy).
 * - "blocked":   refused at the edge (AI crawlers under the "block" policy).
 *
 * @returns {{ route: string, ai: boolean, policy: string }}
 */
export function routeRequest(request, url, decodedPath, site, crawlSecret) {
  const ai = isAiCrawler(request.headers.get("User-Agent"));
  const policy = ai ? site.ai : "origin";
  const decide = (route) => ({ route, ai, policy });

  // RFC 9309 lets a crawler treat an unavailable robots.txt as "allow all", so
  // even blocked crawlers must be able to read it.
  if (policy === "block" && decodedPath !== "/robots.txt") return decide("blocked");

  const bypass = isBypassRequest(request, decodedPath, crawlSecret);

  // Crawlers under an edge policy never trigger dynamic work: API calls and
  // mutations are refused, and query variants (search, add-to-cart, sorting and
  // filter crawl traps) get the snapshot's 404 in serveEdge.
  if (policy === "edge" || policy === "edge-only") return decide(bypass ? "blocked" : policy);

  if (bypass) return decide("private");
  if (site.mode === "edge" && !needsOrigin(request, url, decodedPath, site)) return decide("edge");
  return decide("origin");
}

export function isAiCrawler(userAgent) {
  return typeof userAgent === "string" && AI_CRAWLER.test(userAgent);
}

export function isBypassRequest(request, decodedPath, crawlSecret) {
  if (request.method !== "GET" && request.method !== "HEAD") return true;
  if (
    decodedPath === "/wp-admin" || decodedPath.startsWith("/wp-admin/") ||
    decodedPath === "/wp-login.php" ||
    decodedPath === "/wp-json" || decodedPath.startsWith("/wp-json/") ||
    decodedPath === "/wp-cron.php"
  ) return true;

  // The REST API and WooCommerce AJAX also answer on any path through these
  // parameters; a page snapshot is never a valid response to an API call.
  const query = new URL(request.url).searchParams;
  if (query.has("rest_route") || query.has("wc-ajax")) return true;

  const cookie = request.headers.get("Cookie") || "";
  if (/(?:^|;\s*)wordpress_logged_in_[^=;\s]*=/.test(cookie)) return true;

  const suppliedSecret = request.headers.get("X-Lifeboat-Crawl");
  return typeof crawlSecret === "string" && crawlSecret !== "" && suppliedSecret === crawlSecret;
}

/** True when an edge-mode visitor must be answered by WordPress itself. */
function needsOrigin(request, url, decodedPath, site) {
  if (request.headers.has("Authorization")) return true;
  if (/\.php$/i.test(decodedPath)) return true;
  if (site.bypassPaths.some((prefix) => decodedPath.startsWith(prefix))) return true;
  const cookie = request.headers.get("Cookie");
  if (hasCookie(cookie, DYNAMIC_COOKIE_PREFIXES) || hasCookie(cookie, site.bypassCookies)) return true;
  return hasSignificantQuery(url, decodedPath);
}

export function hasSignificantQuery(url, decodedPath) {
  if (url.search === "") return false;
  if (isAssetPath(decodedPath)) return false;
  for (const name of url.searchParams.keys()) {
    if (!TRACKING_PARAM.test(name)) return true;
  }
  return false;
}

/** Mirrors Lifeboat\Keys::is_asset_path for an already percent-decoded path. */
export function isAssetPath(decodedPath) {
  if (/^\/wp-(?:content|includes)\//.test(decodedPath)) return !/\.php$/i.test(decodedPath);
  const last = decodedPath.slice(decodedPath.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 && ASSET_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

function hasCookie(header, prefixes) {
  if (!header || prefixes.length === 0) return false;
  return header.split(";").some((pair) => {
    const name = pair.split("=", 1)[0].trim();
    return name !== "" && prefixes.some((prefix) => name.startsWith(prefix));
  });
}

async function originFirst(state, isPrivate, current = null) {
  const { request, env, site } = state;
  const breakerKey = breakerKeyFor(site);
  const skipOrigin = site.forceFallback || isBreakerOpen(breakerKey);

  if (!skipOrigin) {
    try {
      const originResponse = await fetchOrigin(request, site, originTimeout(env));
      if (originResponse.status < 500) {
        breakerUntil.delete(breakerKey);
        return { response: originResponse, route: "origin" };
      }
      tripBreaker(breakerKey);
      try {
        await originResponse.body?.cancel();
      } catch {
        // The fallback response does not depend on draining the failed origin.
      }
    } catch {
      tripBreaker(breakerKey);
    }
  }

  // Administrative, authenticated, crawler, and mutating requests are never
  // answered from a public static snapshot.
  if (isPrivate) {
    return { response: readOnlyResponse(request.method), route: "readonly" };
  }

  const response = await serveSnapshot(state, current);
  return { response, route: response.headers.has("X-Lifeboat") ? "fallback" : "readonly" };
}

/**
 * Edge mode: answer from the promoted snapshot without contacting WordPress.
 * Misses, objects the origin marked private, and storage errors fall through to
 * the origin, so edge mode never makes a healthy site less available.
 */
async function serveEdge(state, only) {
  const { request, env, ctx, site, url, decodedPath, crawler } = state;
  const bucket = env.SNAPSHOTS;

  // Only crawlers reach this point with a query string (visitors are routed to
  // the origin first); for them a query variant is never in the snapshot.
  const key = hasSignificantQuery(url, decodedPath) ? null : pathToKey(decodedPath);

  let current = null;
  if (bucket && typeof bucket.get === "function") {
    try {
      current = await loadCurrent(bucket, site, env);
    } catch {
      current = null;
    }
  }
  if (!current) {
    // No promoted snapshot yet (or storage is unreachable): behave as a plain
    // origin-first proxy, so enabling edge mode before the first build is safe.
    return only || key === null
      ? { response: readOnlyResponse(request.method), route: "readonly" }
      : originFirst(state, false, null);
  }

  const banner = !crawler && (site.forceFallback || isBreakerOpen(breakerKeyFor(site)));

  const cache = key && request.method === "GET" && !banner ? edgeCache() : null;
  const cacheKey = cache ? edgeCacheKey(url, current, key) : null;
  if (cache) {
    let cached = null;
    try {
      cached = await cache.match(cacheKey);
    } catch {
      cached = null;
    }
    if (cached) return { response: fromEdgeCache(request, cached), route: "edge" };
  }

  let object = null;
  try {
    object = key ? await readObject(bucket, `${current.prefix}/${key}`, request.method) : null;
  } catch {
    return only
      ? { response: readOnlyResponse(request.method), route: "readonly" }
      : originFirst(state, false, null);
  }

  // The origin answered this page with no-store/private/Set-Cookie when it was
  // captured: real visitors get WordPress, crawlers get the anonymous copy.
  const isPrivate = object?.customMetadata?.["lifeboat-cache"] === "private";
  if (isPrivate && !crawler) {
    await cancelBody(object);
    return originFirst(state, false, current);
  }

  if (!object) {
    // A clean page URL the snapshot lacks may be new content: ask WordPress,
    // unless the crawler policy is edge-only or the URL is a query variant.
    if (!only && key !== null) return originFirst(state, false, current);
    try {
      const notFound = await readObject(bucket, `${current.prefix}/__404.html`, request.method);
      const response = notFound
        ? snapshotObjectResponse(request, notFound, 404, current.snapshotId, { route: "edge", banner: false })
        : readOnlyResponse(request.method);
      return { response, route: notFound ? "edge" : "readonly" };
    } catch {
      return { response: readOnlyResponse(request.method), route: "readonly" };
    }
  }

  const redirect = object.customMetadata?.["lifeboat-redirect"];
  if (typeof redirect === "string" && redirect !== "") {
    await cancelBody(object);
    return { response: redirectResponse(object, redirect, current.snapshotId, "edge"), route: "edge" };
  }

  const response = snapshotObjectResponse(request, object, 200, current.snapshotId, { route: "edge", banner });
  // The edge cache is shared by every visitor, so a crawler's copy of a private
  // page must never enter it.
  if (cache && !isPrivate && response.status === 200 && ctx && typeof ctx.waitUntil === "function") {
    try {
      ctx.waitUntil(cache.put(cacheKey, toEdgeCacheEntry(response.clone())).catch(() => {}));
    } catch {
      // Caching is an optimization; the response itself is already complete.
    }
  }
  return { response, route: "edge" };
}

async function resolveSite(incomingHost, env, { allowBootstrap = true } = {}) {
  if (env.SITES && typeof env.SITES.get === "function") {
    const value = await readSiteRecord(env.SITES, incomingHost, env);
    if (value !== null && value !== undefined) {
      const record = typeof value === "string" ? JSON.parse(value) : value;
      const site = parseSiteRecord(record, incomingHost);
      if (!site) throw new Error("Invalid site record");
      return site;
    }
  }

  const configuredHost = configuredHostname(env.DEFAULT_HOST);
  // The workers.dev-only inference makes the first demo deployment usable long
  // enough to discover its generated hostname. Production/custom domains must
  // always set DEFAULT_HOST or have an exact SITES record.
  const bootstrapHost = allowBootstrap && !configuredHost && incomingHost.endsWith(".workers.dev") ? incomingHost : null;
  const canonicalHost = configuredHost || bootstrapHost;
  if (!canonicalHost || canonicalHost !== incomingHost) return null;

  if (!configuredOrigin(env.DEFAULT_ORIGIN)) return null;
  const site = parseSiteRecord(defaultRecord(env), canonicalHost);
  if (!site) throw new Error("Invalid default site configuration");
  return site;
}

/**
 * A SITES lookup on every request makes KV part of every site's availability.
 * Records are memoized per isolate for SITE_TTL_MS (default 60 s, also cached
 * in the colo through cacheTtl), and when KV fails the last record this isolate
 * saw keeps serving, so a KV incident does not become an outage for every site.
 * The raw record is memoized; validation still runs on every request.
 */
async function readSiteRecord(kv, host, env) {
  const ttl = memoTtl(env.SITE_TTL_MS, DEFAULT_SITE_TTL_MS, 300_000);
  let entries = siteCache.get(kv);
  const hit = entries?.get(host);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value;
  try {
    value = await kv.get(host, { type: "json", cacheTtl: KV_CACHE_TTL_S });
  } catch (error) {
    if (hit) return hit.value;
    throw error;
  }
  if (ttl > 0) {
    if (!entries || entries.size >= MAX_MEMO_ENTRIES) {
      entries = new Map();
      siteCache.set(kv, entries);
    }
    entries.set(host, { value: value ?? null, expires: Date.now() + ttl });
  }
  return value;
}

/** The single-site configuration expressed as a SITES record, so both share one validator. */
function defaultRecord(env) {
  return {
    origin: env.DEFAULT_ORIGIN,
    mode: optionalVar(env.DEFAULT_MODE),
    ai: optionalVar(env.DEFAULT_AI),
    bypassPaths: listVar(env.DEFAULT_BYPASS_PATHS),
    bypassCookies: listVar(env.DEFAULT_BYPASS_COOKIES),
    ingestKeySha256: optionalVar(env.DEFAULT_INGEST_KEY_SHA256),
    edgeSecret: optionalVar(env.DEFAULT_EDGE_SECRET),
  };
}

function optionalVar(value) {
  return value === undefined || value === null || value === "" ? undefined : value;
}

function listVar(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * Validate one SITES record. Every field fails closed: a record with an invalid
 * value is rejected as a whole rather than partially applied.
 *
 * - origin / redirectTo / canonicalHost / prefix / force_fallback: see README.
 * - mode: "failover" (default, origin first) or "edge" (snapshot first).
 * - ai: "origin" (default), "edge", "edge-only" or "block" for AI crawlers.
 * - bypassPaths: decoded path prefixes always answered by the origin in edge mode.
 * - bypassCookies: cookie-name prefixes that make a visitor dynamic in edge mode.
 * - ingestKeySha256: hex SHA-256 of the site's ingest API key.
 * - edgeSecret: sent to the origin as X-Lifeboat-Edge so WordPress can trust
 *   this Worker's forwarded host, scheme and client IP.
 */
function parseSiteRecord(record, incomingHost) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const canonicalHost = record.canonicalHost === undefined
    ? incomingHost
    : configuredHostname(record.canonicalHost);
  if (!canonicalHost) return null;

  const prefix = record.prefix === undefined ? `sites/${canonicalHost}` : configuredPrefix(record.prefix);
  if (!prefix) return null;

  const hasRedirect = record.redirectTo !== undefined && record.redirectTo !== null && record.redirectTo !== "";
  const redirectTo = !hasRedirect
    ? null
    : configuredOrigin(record.redirectTo);
  if (hasRedirect && !redirectTo) return null;

  const hasOrigin = record.origin !== undefined && record.origin !== null && record.origin !== "";
  const origin = !hasOrigin
    ? null
    : configuredOrigin(record.origin);
  if (hasOrigin && !origin) return null;
  if (!origin && !redirectTo) return null;

  const mode = record.mode === undefined ? "failover" : record.mode;
  const ai = record.ai === undefined ? "origin" : record.ai;
  if (!MODES.has(mode) || !AI_POLICIES.has(ai)) return null;

  const bypassPaths = configuredList(record.bypassPaths, isPathPrefix);
  const bypassCookies = configuredList(record.bypassCookies, isCookiePrefix);
  if (!bypassPaths || !bypassCookies) return null;

  const ingestKeySha256 = record.ingestKeySha256 === undefined ? null : record.ingestKeySha256;
  if (ingestKeySha256 !== null && (typeof ingestKeySha256 !== "string" || !/^[0-9a-f]{64}$/.test(ingestKeySha256))) return null;

  const edgeSecret = record.edgeSecret === undefined ? null : record.edgeSecret;
  if (edgeSecret !== null && (typeof edgeSecret !== "string" || !/^[\x21-\x7e]{16,256}$/.test(edgeSecret))) return null;

  return {
    origin,
    canonicalHost,
    prefix,
    forceFallback: record.force_fallback === true,
    redirectTo,
    mode,
    ai,
    bypassPaths,
    bypassCookies,
    ingestKeySha256,
    edgeSecret,
  };
}

function configuredList(value, isValid) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) return null;
  return value.every(isValid) ? [...value] : null;
}

function isPathPrefix(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCookiePrefix(value) {
  return typeof value === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(value);
}

function configuredHostname(value) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function configuredOrigin(value) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredPrefix(value) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) return null;
  return isSafePrefix(value) ? value : null;
}

function isSafePrefix(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function redirectLocation(origin, requestUrl) {
  try {
    const target = new URL(origin);
    // Assigning fields (rather than resolving a `//...` relative reference)
    // guarantees that an unusual request path cannot replace the configured
    // redirect host.
    target.pathname = requestUrl.pathname;
    target.search = requestUrl.search;
    target.hash = "";
    return target.toString();
  } catch {
    return null;
  }
}

async function fetchOrigin(request, site, timeoutMs) {
  const sourceUrl = new URL(request.url);
  const forwardedHost = sourceUrl.host;
  const forwardedProto = sourceUrl.protocol.slice(0, -1);
  const originUrl = new URL(site.origin);
  sourceUrl.protocol = originUrl.protocol;
  sourceUrl.host = originUrl.host;
  sourceUrl.hash = "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Origin timeout"), timeoutMs);
  try {
    const originRequest = new Request(sourceUrl.toString(), request);
    originRequest.headers.set("X-Forwarded-Host", forwardedHost);
    originRequest.headers.set("X-Forwarded-Proto", forwardedProto);
    // Only this Worker may vouch for the forwarded values; never relay a
    // client's own attempt to do so.
    originRequest.headers.delete("X-Lifeboat-Edge");
    originRequest.headers.delete("X-Lifeboat-Client-IP");
    if (site.edgeSecret) {
      originRequest.headers.set("X-Lifeboat-Edge", site.edgeSecret);
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (clientIp) originRequest.headers.set("X-Lifeboat-Client-IP", clientIp);
    }
    return await fetch(originRequest, { signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

function originTimeout(env) {
  const value = Number(env.ORIGIN_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 && value <= 30_000
    ? Math.floor(value)
    : DEFAULT_ORIGIN_TIMEOUT_MS;
}

function memoTtl(raw, fallback, max) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= max
    ? Math.floor(value)
    : fallback;
}

function breakerKeyFor(site) {
  return `${site.canonicalHost}\u0000${site.origin}`;
}

function isBreakerOpen(key) {
  const until = breakerUntil.get(key);
  if (!until) return false;
  if (until <= Date.now()) {
    breakerUntil.delete(key);
    return false;
  }
  return true;
}

function tripBreaker(key) {
  breakerUntil.set(key, Date.now() + BREAKER_TTL_MS);
}

async function serveSnapshot(state, preloaded) {
  const { request, env, site, decodedPath, crawler } = state;
  if (!env.SNAPSHOTS || typeof env.SNAPSHOTS.get !== "function") {
    return readOnlyResponse(request.method);
  }

  try {
    const current = preloaded ?? await loadCurrent(env.SNAPSHOTS, site, env);
    if (!current) return readOnlyResponse(request.method);

    const key = pathToKey(decodedPath);
    let object = await readObject(env.SNAPSHOTS, `${current.prefix}/${key}`, request.method);
    let status = 200;

    if (!object) {
      object = await readObject(env.SNAPSHOTS, `${current.prefix}/__404.html`, request.method);
      status = 404;
    }
    if (!object) return readOnlyResponse(request.method);

    const redirect = object.customMetadata?.["lifeboat-redirect"];
    if (status === 200 && typeof redirect === "string" && redirect !== "") {
      await cancelBody(object);
      return redirectResponse(object, redirect, current.snapshotId, "fallback");
    }

    // Crawlers get the copy itself: an outage notice is not site content.
    return snapshotObjectResponse(request, object, status, current.snapshotId, { route: "fallback", banner: !crawler });
  } catch {
    return readOnlyResponse(request.method);
  }
}

/** HEAD needs metadata only; R2 head() avoids transferring the body. */
async function readObject(bucket, key, method) {
  if (method === "HEAD" && typeof bucket.head === "function") return bucket.head(key);
  return bucket.get(key);
}

async function cancelBody(object) {
  try {
    if (typeof object.body?.cancel === "function") await object.body.cancel();
  } catch {
    // Nothing depends on draining an unused object body.
  }
}

/**
 * current.json, memoized per isolate for POINTER_TTL_MS (default 5 s) to save an
 * R2 read per request. If R2 fails, the last pointer this isolate saw is reused
 * so edge-cached objects of that version can still be served.
 */
async function loadCurrent(bucket, site, env) {
  const ttl = memoTtl(env.POINTER_TTL_MS, DEFAULT_POINTER_TTL_MS, 60_000);
  const cacheKey = `${site.prefix}\u0000${site.canonicalHost}`;
  let entries = pointerCache.get(bucket);
  const hit = ttl > 0 ? entries?.get(cacheKey) : undefined;
  if (hit && hit.expires > Date.now()) return hit.value;

  let value;
  try {
    value = await readCurrent(bucket, site, site.canonicalHost);
  } catch (error) {
    if (hit) return hit.value;
    throw error;
  }
  if (ttl > 0) {
    if (!entries || entries.size >= MAX_MEMO_ENTRIES) {
      entries = new Map();
      pointerCache.set(bucket, entries);
    }
    entries.set(cacheKey, { value, expires: Date.now() + ttl });
  }
  return value;
}

async function readCurrent(bucket, site, expectedHost) {
  const object = await bucket.get(`${site.prefix}/current.json`);
  if (!object || (typeof object.size === "number" && object.size > MAX_POINTER_BYTES)) return null;

  const text = typeof object.text === "function"
    ? await object.text()
    : await new Response(object.body).text();
  if (text.length > MAX_POINTER_BYTES) return null;

  let pointer;
  try {
    pointer = JSON.parse(text);
  } catch {
    return null;
  }

  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return null;
  if (typeof pointer.host !== "string" || configuredHostname(pointer.host) !== expectedHost) return null;
  if (!safeSnapshotId(pointer.snapshot_id) || typeof pointer.prefix !== "string" || !isSafePrefix(pointer.prefix)) return null;

  // The plugin always promotes <site prefix>/snapshots/<snapshot id>. Requiring
  // that exact relationship prevents a corrupt pointer crossing site scopes.
  const expectedPrefix = `${site.prefix}/snapshots/${pointer.snapshot_id}`;
  if (pointer.prefix !== expectedPrefix) return null;

  // Incremental updates rewrite objects in place and bump updated_at, so the
  // pair identifies one exact state of the snapshot for edge-cache keys.
  const updatedAt = typeof pointer.updated_at === "string" && pointer.updated_at.length <= 64 ? pointer.updated_at : "";
  return {
    snapshotId: pointer.snapshot_id,
    prefix: pointer.prefix,
    version: updatedAt ? `${pointer.snapshot_id}@${updatedAt}` : pointer.snapshot_id,
  };
}

function safeSnapshotId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== "." && value !== "..";
}

/** Map an already percent-decoded request path exactly like Lifeboat's PHP Keys class. */
export function pathToKey(decodedPath) {
  const path = `/${String(decodedPath).replace(/^\/+/, "")}`;
  if (path === "/") return "index.html";
  if (path.endsWith("/")) return `${path.slice(1)}index.html`;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".") ? path.slice(1) : `${path.slice(1)}/index.html`;
}

function objectHeaders(object) {
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  } else if (object.httpMetadata) {
    const metadata = object.httpMetadata;
    if (metadata.contentType) headers.set("Content-Type", metadata.contentType);
    if (metadata.contentLanguage) headers.set("Content-Language", metadata.contentLanguage);
    if (metadata.contentDisposition) headers.set("Content-Disposition", metadata.contentDisposition);
    if (metadata.contentEncoding) headers.set("Content-Encoding", metadata.contentEncoding);
    if (metadata.cacheControl) headers.set("Cache-Control", metadata.cacheControl);
    if (metadata.expires) headers.set("Expires", new Date(metadata.expires).toUTCString());
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
  return headers;
}

function redirectResponse(object, location, snapshotId, route) {
  const headers = objectHeaders(object);
  headers.delete("Content-Length");
  headers.set("Location", location);
  headers.set("X-Lifeboat", snapshotId);
  headers.set("X-Lifeboat-Route", route);
  return new Response(null, { status: 301, headers });
}

/**
 * @param {{ route: "edge" | "fallback", banner: boolean }} options
 *   banner: the origin is known to be failing, so HTML gets the saved-copy
 *   notice and disabled forms, and must not be cached by the browser.
 */
function snapshotObjectResponse(request, object, status, snapshotId, { route, banner }) {
  const method = request.method;
  const headers = objectHeaders(object);
  headers.set("X-Lifeboat", snapshotId);
  headers.set("X-Lifeboat-Route", route);
  const contentType = headers.get("Content-Type") || "";
  const outagePage = banner && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType);

  if (outagePage) {
    headers.set("Cache-Control", "no-store");
    if (method === "GET" && typeof globalThis.HTMLRewriter === "function") {
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      const response = new Response(object.body, { status, headers });
      try {
        let rewriter = new globalThis.HTMLRewriter()
          .on("body", { element(element) { element.prepend(FALLBACK_BANNER, { html: true }); } })
          .on("form", { element(element) {
            element.setAttribute("aria-disabled", "true");
            element.setAttribute("data-lifeboat-disabled", "true");
            element.setAttribute("inert", "");
            element.setAttribute("onsubmit", "return false");
          } });
        for (const selector of ["form input", "form button", "form select", "form textarea"]) {
          rewriter = rewriter.on(selector, { element(element) { element.setAttribute("disabled", "disabled"); } });
        }
        return rewriter.transform(response);
      } catch {
        // If rewriting is unavailable for a particular body, serving the immutable
        // snapshot is still safer than replacing it with an outage page.
        return response;
      }
    }
  } else if (typeof object.httpEtag === "string" && object.httpEtag !== "") {
    headers.set("ETag", object.httpEtag);
    if (status === 200 && etagMatches(request.headers.get("If-None-Match"), object.httpEtag)) {
      cancelBody(object);
      return new Response(null, { status: 304, headers: notModifiedHeaders(headers) });
    }
  }
  return new Response(method === "HEAD" ? null : object.body, { status, headers });
}

/** If-None-Match uses weak comparison (RFC 9110 13.1.2). */
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === bare;
  });
}

function notModifiedHeaders(headers) {
  const out = new Headers(headers);
  for (const name of ["Content-Length", "Content-Type", "Content-Encoding", "Content-Language", "Content-Disposition"]) {
    out.delete(name);
  }
  return out;
}

function edgeCache() {
  try {
    const cache = globalThis.caches?.default;
    return cache && typeof cache.match === "function" && typeof cache.put === "function" ? cache : null;
  } catch {
    return null;
  }
}

/**
 * Edge-cache entries are keyed by the snapshot version, so a promotion or an
 * incremental update is visible as soon as the pointer is re-read, without a purge.
 */
function edgeCacheKey(url, current, key) {
  const encodedKey = key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new Request(`${url.protocol}//${url.host}/__lifeboat-edge/${encodeURIComponent(current.version)}/${encodedKey}`);
}

function toEdgeCacheEntry(response) {
  const headers = new Headers(response.headers);
  const clientCacheControl = headers.get("Cache-Control");
  if (clientCacheControl) headers.set("X-Lifeboat-Client-Cache-Control", clientCacheControl);
  headers.set("Cache-Control", `public, max-age=${EDGE_CACHE_TTL_S}`);
  return new Response(response.body, { status: 200, headers });
}

function fromEdgeCache(request, cached) {
  const headers = new Headers(cached.headers);
  const clientCacheControl = headers.get("X-Lifeboat-Client-Cache-Control");
  headers.delete("X-Lifeboat-Client-Cache-Control");
  if (clientCacheControl) headers.set("Cache-Control", clientCacheControl);
  else headers.delete("Cache-Control");
  headers.set("X-Lifeboat-Route", "edge");

  const etag = headers.get("ETag");
  if (etag && etagMatches(request.headers.get("If-None-Match"), etag)) {
    cancelBody(cached);
    return new Response(null, { status: 304, headers: notModifiedHeaders(headers) });
  }
  return new Response(cached.body, { status: 200, headers });
}

/* -------------------------------------------------------------- ingest API */

/**
 * Snapshot ingest for hosted ("service") deployments, served only on INGEST_HOST.
 * A WordPress site authenticates with its own key and can only touch objects
 * under its own prefix, so no site ever holds bucket-wide R2 credentials.
 *
 *   GET    /v1/site                    → { host, prefix, mode, ai }
 *   GET    /v1/object?key=…            → object body (HEAD: existence only)
 *   PUT    /v1/object?key=…            ← body; Content-Type, Cache-Control, X-Lifeboat-Metadata (JSON)
 *   DELETE /v1/object?key=…
 *   POST   /v1/copy    { from, to }    server-side copy, metadata included
 *   GET    /v1/list?prefix=…[&delimiter=/][&cursor=…][&limit=…]
 *   POST   /v1/delete  { keys: [...] } at most 1000 keys
 *
 * Requests carry X-Lifeboat-Site: <canonical host> and Authorization: Bearer <key>.
 */
async function handleIngest(request, env, url) {
  const bucket = env.SNAPSHOTS;
  if (!bucket || typeof bucket.get !== "function") return ingestError(503, "Snapshot storage is not configured.");

  const host = configuredHostname(request.headers.get("X-Lifeboat-Site") || "");
  const token = bearerToken(request.headers.get("Authorization"));
  if (!host || !token) return ingestError(401, "Send X-Lifeboat-Site and Authorization: Bearer <site key>.");

  let site = null;
  try {
    site = await resolveSite(host, env, { allowBootstrap: false });
  } catch {
    site = null;
  }
  // One answer for unknown sites, alias records, sites without ingest and
  // wrong keys, so the endpoint does not reveal which hostnames exist.
  if (!site || site.canonicalHost !== host || !site.ingestKeySha256 || !(await keyMatches(token, site.ingestKeySha256))) {
    return ingestError(401, "Unknown site or invalid site key.");
  }

  try {
    switch (url.pathname) {
      case "/v1/site":
        if (request.method !== "GET") return ingestError(405, "Use GET.");
        return ingestJson(200, { host: site.canonicalHost, prefix: site.prefix, mode: site.mode, ai: site.ai });
      case "/v1/object":
        return await ingestObject(request, env, bucket, site, url.searchParams.get("key"));
      case "/v1/copy":
        return await ingestCopy(request, bucket, site);
      case "/v1/list":
        return await ingestList(request, bucket, site, url.searchParams);
      case "/v1/delete":
        return await ingestDelete(request, bucket, site);
      default:
        return ingestError(404, "Unknown ingest endpoint.");
    }
  } catch {
    return ingestError(500, "Storage operation failed.");
  }
}

async function ingestObject(request, env, bucket, site, rawKey) {
  const key = confinedKey(site, rawKey);
  if (!key) return ingestError(403, `Keys must be under ${site.prefix}/ without empty, "." or ".." segments.`);

  switch (request.method) {
    case "GET": {
      const object = await bucket.get(key);
      if (!object) return ingestError(404, "No such object.");
      const headers = objectHeaders(object);
      headers.set("Cache-Control", "no-store");
      return new Response(object.body, { status: 200, headers });
    }
    case "HEAD": {
      const object = typeof bucket.head === "function" ? await bucket.head(key) : await bucket.get(key);
      if (object) await cancelBody(object);
      return new Response(null, { status: object ? 200 : 404, headers: { "Cache-Control": "no-store" } });
    }
    case "PUT": {
      const length = Number(request.headers.get("Content-Length"));
      if (!request.headers.has("Content-Length") || !Number.isSafeInteger(length) || length < 0) {
        return ingestError(411, "Content-Length is required.");
      }
      if (length > ingestMaxBytes(env)) return ingestError(413, "Object is larger than this service accepts.");

      const metadata = parseMetadataHeader(request.headers.get("X-Lifeboat-Metadata"));
      if (!metadata) return ingestError(400, "X-Lifeboat-Metadata must be a JSON object of short ASCII strings.");
      const httpMetadata = { contentType: request.headers.get("Content-Type") || "application/octet-stream" };
      const cacheControl = request.headers.get("Cache-Control");
      if (cacheControl && /^[\x20-\x7e]{1,256}$/.test(cacheControl)) httpMetadata.cacheControl = cacheControl;

      await bucket.put(key, length === 0 ? "" : request.body, { httpMetadata, customMetadata: metadata });
      return ingestJson(200, { ok: true });
    }
    case "DELETE":
      await bucket.delete(key);
      return ingestJson(200, { ok: true });
    default:
      return ingestError(405, "Use GET, HEAD, PUT or DELETE.");
  }
}

async function ingestCopy(request, bucket, site) {
  if (request.method !== "POST") return ingestError(405, "Use POST.");
  const body = await readJsonBody(request);
  const from = confinedKey(site, body?.from);
  const to = confinedKey(site, body?.to);
  if (body && (!from || !to)) return ingestError(403, `Keys must be under ${site.prefix}/.`);

  if (!body) return ingestError(400, "Send a JSON body { from, to }.");
  const source = await bucket.get(from);
  if (!source) return ingestError(404, "No such source object.");
  await bucket.put(to, knownLengthBody(source), {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  return ingestJson(200, { ok: true });
}

async function ingestList(request, bucket, site, params) {
  if (request.method !== "GET") return ingestError(405, "Use GET.");
  const prefix = params.get("prefix") || "";
  if (!confinedListPrefix(site, prefix)) return ingestError(403, `Prefixes must be under ${site.prefix}/.`);

  const delimiter = params.get("delimiter") === "/" ? "/" : undefined;
  const limit = Math.min(1000, Math.max(1, Number.parseInt(params.get("limit") || "1000", 10) || 1000));
  const cursor = params.get("cursor") || undefined;
  const listed = await bucket.list({ prefix, delimiter, cursor, limit });
  return ingestJson(200, {
    keys: (listed.objects || []).map((object) => ({ key: object.key, size: object.size, etag: object.etag })),
    prefixes: listed.delimitedPrefixes || [],
    next: listed.truncated && listed.cursor ? listed.cursor : null,
  });
}

async function ingestDelete(request, bucket, site) {
  if (request.method !== "POST") return ingestError(405, "Use POST.");
  const body = await readJsonBody(request);
  const keys = Array.isArray(body?.keys) ? body.keys : null;
  if (!keys || keys.length === 0 || keys.length > 1000) return ingestError(400, "Send { keys: [...] } with 1 to 1000 keys.");
  const confined = keys.map((key) => confinedKey(site, key));
  if (confined.some((key) => !key)) return ingestError(403, `Keys must be under ${site.prefix}/.`);
  await bucket.delete(confined);
  return ingestJson(200, { ok: true, deleted: confined.length });
}

/** A key inside the site's prefix. R2 keys are flat, but odd segments are refused to keep the namespace clean. */
function confinedKey(site, key) {
  if (typeof key !== "string" || !key.startsWith(`${site.prefix}/`)) return null;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES || /[\u0000-\u001f\u007f]/.test(key)) return null;
  const segments = key.slice(site.prefix.length + 1).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") ? key : null;
}

function confinedListPrefix(site, prefix) {
  if (prefix === `${site.prefix}/`) return true;
  if (!prefix.endsWith("/")) return confinedKey(site, prefix) !== null;
  return confinedKey(site, prefix.slice(0, -1)) !== null;
}

function parseMetadataHeader(value) {
  if (value === null || value === "") return {};
  if (value.length > 8 * 1024) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const metadata = {};
  for (const [name, item] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]{1,64}$/.test(name) || typeof item !== "string" || !/^[\x20-\x7e]{0,2048}$/.test(item)) return null;
    metadata[name] = item;
  }
  return metadata;
}

async function readJsonBody(request) {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (!Number.isSafeInteger(length) || length > MAX_INGEST_CONTROL_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_INGEST_CONTROL_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** R2 put() needs a stream of known length; a copied object's size is known up front. */
function knownLengthBody(object) {
  if (typeof globalThis.FixedLengthStream === "function" && typeof object.body?.pipeTo === "function" && typeof object.size === "number") {
    const { readable, writable } = new globalThis.FixedLengthStream(object.size);
    object.body.pipeTo(writable).catch(() => {});
    return readable;
  }
  return object.body;
}

function bearerToken(header) {
  const match = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header || "");
  return match ? match[1] : null;
}

async function keyMatches(token, expectedHex) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let difference = 0;
  for (let index = 0; index < digest.length; index += 1) {
    difference |= digest[index] ^ Number.parseInt(expectedHex.slice(index * 2, index * 2 + 2), 16);
  }
  return difference === 0;
}

function ingestMaxBytes(env) {
  const value = Number(env.INGEST_MAX_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_INGEST_MAX_BYTES;
}

function ingestJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function ingestError(status, message) {
  return ingestJson(status, { error: message });
}

/* -------------------------------------------------------------- responses */

/**
 * One Analytics Engine data point per site request: host, route (edge, origin,
 * fallback, readonly, blocked, redirect), visitor class and status. This is the
 * basis for usage billing and for "origin requests avoided" reporting.
 */
function meter(env, outcome) {
  const dataset = env.METRICS;
  if (!outcome.site || !dataset || typeof dataset.writeDataPoint !== "function") return;
  try {
    dataset.writeDataPoint({
      indexes: [outcome.site.canonicalHost],
      blobs: [outcome.site.canonicalHost, outcome.route || "unknown", outcome.ai ? "ai" : "visitor", String(outcome.response.status)],
      doubles: [1],
    });
  } catch {
    // Metering must never change the response.
  }
}

function badRequest(method) {
  const body = method === "HEAD" ? null : "Malformed request path";
  return new Response(body, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function blockedResponse(method) {
  return new Response(method === "HEAD" ? null : "Automated AI access to this site is not permitted.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function readOnlyResponse(method) {
  return new Response(method === "HEAD" ? null : READ_ONLY_HTML, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "Retry-After": "30",
    },
  });
}

export const __testing = {
  resetBreakers() {
    breakerUntil.clear();
  },
};
