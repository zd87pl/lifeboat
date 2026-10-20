import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { __testing, handleRequest, hasSignificantQuery, isAiCrawler, isAssetPath, phpParamName } from "../src/index.js";
import { FakeCache, FakeR2, kv, pointer, r2Object, waitUntilCollector } from "./fakes.js";

const HOST = "site.example";
const ID = "20260901-140000";
const PREFIX = `sites/${HOST}/snapshots/${ID}`;
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";

const originalFetch = globalThis.fetch;
const originalRewriter = globalThis.HTMLRewriter;
const originalCaches = globalThis.caches;

beforeEach(() => {
  __testing.resetBreakers();
  delete globalThis.HTMLRewriter;
  delete globalThis.caches;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRewriter === undefined) delete globalThis.HTMLRewriter;
  else globalThis.HTMLRewriter = originalRewriter;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
});

function snapshotBucket(extra = {}) {
  return new FakeR2({
    [`sites/${HOST}/current.json`]: pointer(),
    [`${PREFIX}/index.html`]: r2Object("<html><body><form><input></form><h1>Saved home</h1></body></html>", { etag: "home-v1" }),
    [`${PREFIX}/about/index.html`]: r2Object("saved about"),
    [`${PREFIX}/robots.txt`]: r2Object("User-agent: *", { contentType: "text/plain" }),
    [`${PREFIX}/wp-content/themes/t/style.css`]: r2Object("body{}", { contentType: "text/css", cacheControl: "public, max-age=31536000" }),
    [`${PREFIX}/__404.html`]: r2Object("saved not found"),
    [`${PREFIX}/cart/index.html`]: r2Object("anonymous cart", { customMetadata: { "lifeboat-cache": "private" } }),
    [`${PREFIX}/old/index.html`]: r2Object("moved", { customMetadata: { "lifeboat-redirect": `https://${HOST}/new/` } }),
    ...extra,
  });
}

function siteEnv(r2, record = {}, extra = {}) {
  return {
    SITES: kv({ [HOST]: { origin: "https://origin.example", mode: "edge", ...record } }),
    SNAPSHOTS: r2,
    ...extra,
  };
}

/** Replace fetch with a recording origin; `respond` may be a Response factory or "down". */
function origin(respond = () => new Response("from origin", { status: 200 })) {
  const seen = [];
  globalThis.fetch = async (request) => {
    seen.push(request);
    if (respond === "down") throw new Error("origin unreachable");
    return respond(request);
  };
  return seen;
}

function get(path, headers = {}, init = {}) {
  return new Request(`https://${HOST}${path}`, { headers: { "User-Agent": BROWSER, ...headers }, ...init });
}

function recordingRewriter() {
  const selectors = [];
  globalThis.HTMLRewriter = class {
    constructor() { this.handlers = []; }
    on(selector, handler) { this.handlers.push([selector, handler]); selectors.push(selector); return this; }
    transform(response) { return new Response("rewritten", { status: response.status, headers: response.headers }); }
  };
  return selectors;
}

test("edge mode answers anonymous page views from the snapshot without contacting WordPress", async () => {
  const seen = origin();
  const rewrites = recordingRewriter();

  const response = await handleRequest(get("/"), siteEnv(snapshotBucket()));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Saved home/);
  assert.equal(response.headers.get("X-Lifeboat"), ID);
  assert.equal(response.headers.get("X-Lifeboat-Route"), "edge");
  assert.equal(response.headers.get("ETag"), '"home-v1"');
  assert.equal(response.headers.get("Cache-Control"), null);
  assert.equal(seen.length, 0);
  assert.deepEqual(rewrites, [], "a healthy edge page must not get the outage banner");
});

test("edge mode sends every dynamic request to WordPress", async () => {
  const cases = [
    ["POST comment", get("/wp-comments-post.php", {}, { method: "POST", body: "comment=hi" })],
    ["admin", get("/wp-admin/")],
    ["admin-ajax", get("/wp-admin/admin-ajax.php?action=x")],
    ["REST", get("/wp-json/wp/v2/posts")],
    ["REST by query", get("/?rest_route=/wp/v2/posts")],
    ["WooCommerce AJAX", get("/?wc-ajax=get_refreshed_fragments")],
    ["logged in", get("/", { Cookie: "wordpress_logged_in_abc=user" })],
    ["cart", get("/", { Cookie: "a=1; woocommerce_items_in_cart=1" })],
    ["Woo session", get("/about/", { Cookie: "wp_woocommerce_session_abc=s" })],
    ["commenter", get("/about/", { Cookie: "comment_author_abc=Ann" })],
    ["post password", get("/about/", { Cookie: "wp-postpass_abc=x" })],
    ["search", get("/?s=hello")],
    ["query post", get("/?p=12")],
    ["campaign plus real parameter", get("/?utm_source=news&page_id=4")],
    ["authorization", get("/about/", { Authorization: "Basic dTpw" })],
    ["PHP endpoint", get("/xmlrpc.php")],
    ["configured path", get("/members/area/")],
    ["configured cookie", get("/about/", { Cookie: "my_session=1" })],
  ];

  for (const [label, request] of cases) {
    const r2 = snapshotBucket();
    const seen = origin();
    const response = await handleRequest(request, siteEnv(r2, { bypassPaths: ["/members/"], bypassCookies: ["my_session"] }));
    assert.equal(response.status, 200, label);
    assert.equal(await response.text(), "from origin", label);
    assert.equal(response.headers.get("X-Lifeboat"), null, label);
    assert.equal(seen.length, 1, label);
    assert.equal(r2.ops.filter(([op, key]) => op === "get" && !key.endsWith("current.json")).length, 0, label);
  }
});

test("API calls addressed by query string never receive a page snapshot during an outage", async () => {
  for (const mode of ["failover", "edge"]) {
    for (const path of ["/?rest_route=/wp/v2/posts", "/shop/?wc-ajax=get_refreshed_fragments"]) {
      const r2 = snapshotBucket();
      origin("down");
      const response = await handleRequest(get(path), siteEnv(r2, { mode }));
      assert.equal(response.status, 503, `${mode} ${path}`);
      assert.equal(response.headers.get("X-Lifeboat"), null, `${mode} ${path}`);
      assert.deepEqual(r2.calls, [], `${mode} ${path}`);
      __testing.resetBreakers();
    }
  }
});

test("campaign parameters and asset cache busters stay on the edge", async () => {
  const seen = origin();
  const env = siteEnv(snapshotBucket());

  const campaign = await handleRequest(get("/about/?utm_source=x&utm_medium=y&fbclid=z&gclid=q"), env);
  const stylesheet = await handleRequest(get("/wp-content/themes/t/style.css?ver=6.6.2"), env);

  assert.equal(await campaign.text(), "saved about");
  assert.equal(campaign.headers.get("X-Lifeboat-Route"), "edge");
  assert.equal(await stylesheet.text(), "body{}");
  assert.equal(stylesheet.headers.get("Content-Type"), "text/css");
  assert.equal(stylesheet.headers.get("Cache-Control"), "public, max-age=31536000");
  assert.equal(seen.length, 0);
});

test("snapshot misses go to WordPress and fall back to the captured 404 when it fails", async () => {
  const env = siteEnv(snapshotBucket());
  const seen = origin(() => new Response("brand new post", { status: 200 }));

  const fresh = await handleRequest(get("/published-a-minute-ago/"), env);
  assert.equal(await fresh.text(), "brand new post");
  assert.equal(seen.length, 1);

  origin("down");
  const missing = await handleRequest(get("/never-published/"), env);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "saved not found");
  assert.equal(missing.headers.get("X-Lifeboat-Route"), "fallback");
});

test("pages the origin marked private are fetched live and served from the snapshot only during an outage", async () => {
  const env = siteEnv(snapshotBucket());
  const seen = origin(() => new Response("your cart", { status: 200 }));

  const live = await handleRequest(get("/cart/"), env);
  assert.equal(await live.text(), "your cart");
  assert.equal(seen.length, 1);

  origin(() => new Response("bad gateway", { status: 502 }));
  const outage = await handleRequest(get("/cart/"), env);
  assert.equal(outage.status, 200);
  assert.equal(await outage.text(), "anonymous cart");
  assert.equal(outage.headers.get("X-Lifeboat-Route"), "fallback");
  assert.equal(outage.headers.get("Cache-Control"), "no-store");
});

test("an origin failure seen on a dynamic request puts the outage banner on edge pages", async () => {
  const env = siteEnv(snapshotBucket());
  origin(() => new Response("bad gateway", { status: 502 }));
  const failedPost = await handleRequest(get("/wp-comments-post.php", {}, { method: "POST", body: "x" }), env);
  assert.equal(failedPost.status, 503);

  const seen = origin();
  const rewrites = recordingRewriter();
  const page = await handleRequest(get("/"), env);

  assert.equal(await page.text(), "rewritten");
  assert.equal(page.headers.get("X-Lifeboat-Route"), "edge");
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  assert.equal(page.headers.get("ETag"), null);
  assert.deepEqual(rewrites.slice(0, 2), ["body", "form"]);
  assert.equal(seen.length, 0);
});

test("a force_fallback drill also marks edge pages as a saved copy", async () => {
  const seen = origin();
  const rewrites = recordingRewriter();

  const page = await handleRequest(get("/"), siteEnv(snapshotBucket(), { force_fallback: true }));

  assert.equal(await page.text(), "rewritten");
  assert.ok(rewrites.includes("body"));
  assert.equal(seen.length, 0);
});

test("edge mode without a promoted snapshot is a plain pass-through proxy", async () => {
  const seen = origin();

  const response = await handleRequest(get("/"), siteEnv(new FakeR2()));

  assert.equal(await response.text(), "from origin");
  assert.equal(seen.length, 1);
});

test("unreachable storage in edge mode falls through to the origin", async () => {
  const seen = origin();
  const r2 = snapshotBucket();
  const realGet = r2.get.bind(r2);
  r2.get = async (key) => {
    if (key.endsWith("/about/index.html")) throw new Error("R2 unavailable");
    return realGet(key);
  };

  const response = await handleRequest(get("/about/"), siteEnv(r2));

  assert.equal(await response.text(), "from origin");
  assert.equal(seen.length, 1);
});

test("edge objects revalidate with If-None-Match", async () => {
  origin();
  const env = siteEnv(snapshotBucket());

  const strong = await handleRequest(get("/", { "If-None-Match": '"home-v1"' }), env);
  const weak = await handleRequest(get("/", { "If-None-Match": 'W/"other", W/"home-v1"' }), env);
  const changed = await handleRequest(get("/", { "If-None-Match": '"home-v0"' }), env);

  assert.equal(strong.status, 304);
  assert.equal(await strong.text(), "");
  assert.equal(strong.headers.get("ETag"), '"home-v1"');
  assert.equal(strong.headers.get("X-Lifeboat"), ID);
  assert.equal(weak.status, 304);
  assert.equal(changed.status, 200);
});

test("crawler-captured redirects become 301s on the edge", async () => {
  const seen = origin();

  const response = await handleRequest(get("/old/"), siteEnv(snapshotBucket()));

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), `https://${HOST}/new/`);
  assert.equal(response.headers.get("X-Lifeboat-Route"), "edge");
  assert.equal(seen.length, 0);
});

test("HEAD on the edge reads object metadata only", async () => {
  origin();
  const r2 = snapshotBucket();

  const response = await handleRequest(get("/about/", {}, { method: "HEAD" }), siteEnv(r2));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.ok(r2.ops.some(([op, key]) => op === "head" && key === `${PREFIX}/about/index.html`));
  assert.ok(!r2.ops.some(([op, key]) => op === "get" && key === `${PREFIX}/about/index.html`));
});

test("the promoted pointer is memoized per isolate for POINTER_TTL_MS", async () => {
  origin();
  const memoized = snapshotBucket();
  await handleRequest(get("/"), siteEnv(memoized));
  await handleRequest(get("/about/"), siteEnv(memoized));
  assert.equal(memoized.calls.filter((key) => key.endsWith("current.json")).length, 1);

  const uncached = snapshotBucket();
  await handleRequest(get("/"), siteEnv(uncached, {}, { POINTER_TTL_MS: "0" }));
  await handleRequest(get("/about/"), siteEnv(uncached, {}, { POINTER_TTL_MS: "0" }));
  assert.equal(uncached.calls.filter((key) => key.endsWith("current.json")).length, 2);
});

test("edge objects are cached per snapshot version and private pages never enter the cache", async () => {
  origin();
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  const ctx = waitUntilCollector();
  const r2 = snapshotBucket();
  const env = siteEnv(r2, { ai: "edge" }, { POINTER_TTL_MS: "0" });

  await (await handleRequest(get("/wp-content/themes/t/style.css"), env, ctx)).text();
  await ctx.settle();
  assert.equal(cache.puts.length, 1);
  assert.match(cache.puts[0], new RegExp(`/__lifeboat-edge/${ID}/[0-9a-f]{64}$`));

  const reads = r2.calls.length;
  const cached = await handleRequest(get("/wp-content/themes/t/style.css"), env, ctx);
  assert.equal(await cached.text(), "body{}");
  assert.equal(cached.headers.get("Cache-Control"), "public, max-age=31536000");
  assert.equal(cached.headers.get("X-Lifeboat-Route"), "edge");
  assert.equal(cached.headers.get("X-Lifeboat-Cache"), "hit");
  assert.equal(cached.headers.get("X-Lifeboat"), ID);
  assert.deepEqual(r2.calls.slice(reads), [`sites/${HOST}/current.json`], "only the pointer is read on a cache hit");

  const revalidated = await handleRequest(get("/wp-content/themes/t/style.css", { "If-None-Match": cached.headers.get("ETag") }), env, ctx);
  assert.equal(revalidated.status, 304);

  const crawlerCart = await handleRequest(get("/cart/", { "User-Agent": GPTBOT }), env, ctx);
  assert.equal(await crawlerCart.text(), "anonymous cart");
  await ctx.settle();
  assert.equal(cache.puts.length, 1, "a crawler's copy of a private page is not shared");

  r2.entries.set(`sites/${HOST}/current.json`, pointer(HOST, ID, PREFIX, "2026-09-01T15:00:00+00:00"));
  await (await handleRequest(get("/wp-content/themes/t/style.css"), env, ctx)).text();
  await ctx.settle();
  assert.equal(cache.puts.length, 2);
  assert.match(cache.puts[1], /\/__lifeboat-edge\/20260901-140000%402026-09-01T15%3A00%3A00%2B00%3A00\/[0-9a-f]{64}$/);
});

test("a KV incident keeps serving the last site record this isolate saw", async () => {
  const seen = origin();
  const sites = kv({ [HOST]: { origin: "https://origin.example", mode: "edge" } });
  const env = { SITES: sites, SNAPSHOTS: snapshotBucket(), SITE_TTL_MS: "1" };

  assert.equal(await (await handleRequest(get("/about/"), env)).text(), "saved about");
  sites.get = async () => { throw new Error("KV unavailable"); };
  await new Promise((resolve) => setTimeout(resolve, 5));

  const duringIncident = await handleRequest(get("/about/"), env);
  assert.equal(duringIncident.status, 200);
  assert.equal(await duringIncident.text(), "saved about");

  const neverSeen = await handleRequest(new Request("https://new.example/"), env);
  assert.equal(neverSeen.status, 503, "a host never resolved before still fails closed");
  assert.equal(seen.length, 0);
});

test("site records are memoized per isolate and read with a KV cacheTtl", async () => {
  origin();
  const options = [];
  const sites = {
    async get(key, opts) {
      options.push(opts);
      return key === HOST ? { origin: "https://origin.example", mode: "edge" } : null;
    },
  };
  const env = { SITES: sites, SNAPSHOTS: snapshotBucket() };

  await handleRequest(get("/"), env);
  await handleRequest(get("/about/"), env);

  assert.equal(options.length, 1);
  assert.deepEqual(options[0], { type: "json", cacheTtl: 60 });
});

test("an R2 incident reuses the last pointer so edge-cached pages survive an origin outage too", async () => {
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  const ctx = waitUntilCollector();
  const r2 = snapshotBucket();
  const env = siteEnv(r2, {}, { POINTER_TTL_MS: "1" });
  origin();

  await (await handleRequest(get("/about/"), env, ctx)).text();
  await ctx.settle();
  assert.equal(cache.puts.length, 1);

  r2.get = async () => { throw new Error("R2 unavailable"); };
  origin("down");
  await new Promise((resolve) => setTimeout(resolve, 5));

  const response = await handleRequest(get("/about/"), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "saved about");
  assert.equal(response.headers.get("X-Lifeboat-Route"), "edge");
});

test("an AI crawler policy offloads crawlers even for a failover-mode site", async () => {
  const env = siteEnv(snapshotBucket(), { mode: "failover", ai: "edge" });
  const seen = origin();
  const rewrites = recordingRewriter();

  const crawler = await handleRequest(get("/", { "User-Agent": GPTBOT }), env);
  assert.match(await crawler.text(), /Saved home/);
  assert.equal(crawler.headers.get("X-Lifeboat-Route"), "edge");
  assert.deepEqual(rewrites, []);
  assert.equal(seen.length, 0);

  const visitor = await handleRequest(get("/"), env);
  assert.equal(await visitor.text(), "from origin");
  assert.equal(seen.length, 1);
});

test("crawlers under the edge policy reach WordPress only for clean page URLs the snapshot lacks", async () => {
  const env = siteEnv(snapshotBucket(), { mode: "failover", ai: "edge" });
  const seen = origin();
  const crawler = { "User-Agent": GPTBOT };

  const miss = await handleRequest(get("/published-after-the-snapshot/", crawler), env);
  assert.equal(await miss.text(), "from origin");
  assert.equal(seen.length, 1);

  const addToCart = await handleRequest(get("/shop/?add-to-cart=42", crawler), env);
  const sortTrap = await handleRequest(get("/about/?orderby=price&filter_color=red", crawler), env);
  const api = await handleRequest(get("/wp-json/wp/v2/posts", crawler), env);
  const ajax = await handleRequest(get("/?wc-ajax=add_to_cart", crawler), env);
  const post = await handleRequest(get("/wp-comments-post.php", crawler, { method: "POST", body: "x" }), env);

  assert.equal(addToCart.status, 404);
  assert.equal(await addToCart.text(), "saved not found");
  assert.equal(sortTrap.status, 404);
  assert.equal(api.status, 403);
  assert.equal(ajax.status, 403);
  assert.equal(post.status, 403);
  assert.equal(seen.length, 1, "no dynamic work reached the origin");
});

test("edge-only crawlers never reach WordPress", async () => {
  const env = siteEnv(snapshotBucket(), { mode: "failover", ai: "edge-only" });
  const seen = origin();
  const claude = { "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" };

  const hit = await handleRequest(get("/about/", claude), env);
  const miss = await handleRequest(get("/not-in-snapshot/", claude), env);
  const query = await handleRequest(get("/?s=crawl+me", claude), env);
  const api = await handleRequest(get("/wp-json/wp/v2/users", claude), env);
  const post = await handleRequest(get("/wp-comments-post.php", claude, { method: "POST", body: "x" }), env);

  assert.equal(await hit.text(), "saved about");
  assert.equal(miss.status, 404);
  assert.equal(await miss.text(), "saved not found");
  assert.equal(query.status, 404);
  assert.equal(api.status, 403);
  assert.equal(post.status, 403);
  assert.equal(seen.length, 0);
});

test("blocked crawlers are refused at the edge except for robots.txt", async () => {
  const env = siteEnv(snapshotBucket(), { ai: "block" });
  const seen = origin();
  const bytespider = { "User-Agent": "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)" };

  const page = await handleRequest(get("/", bytespider), env);
  const robots = await handleRequest(get("/robots.txt", bytespider), env);
  const visitor = await handleRequest(get("/"), env);

  assert.equal(page.status, 403);
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *");
  assert.equal(visitor.status, 200);
  assert.equal(seen.length, 0);
});

test("without an AI policy crawlers are ordinary visitors", async () => {
  const failover = siteEnv(snapshotBucket(), { mode: "failover" });
  const seen = origin();
  const crawlerOnFailover = await handleRequest(get("/", { "User-Agent": GPTBOT }), failover);
  assert.equal(await crawlerOnFailover.text(), "from origin");
  assert.equal(seen.length, 1);

  const edge = siteEnv(snapshotBucket());
  const crawlerCart = await handleRequest(get("/cart/", { "User-Agent": GPTBOT }), edge);
  assert.equal(await crawlerCart.text(), "from origin", "private pages stay live for unprivileged crawlers");
  assert.equal(seen.length, 2);
});

test("crawlers get the plain copy, without the outage banner, while the origin is down", async () => {
  const env = siteEnv(snapshotBucket(), { mode: "failover", ai: "edge" });
  origin("down");
  const rewrites = recordingRewriter();

  const miss = await handleRequest(get("/not-in-snapshot/", { "User-Agent": GPTBOT }), env);

  assert.equal(miss.status, 404);
  assert.equal(await miss.text(), "saved not found");
  assert.equal(miss.headers.get("X-Lifeboat-Route"), "fallback");
  assert.deepEqual(rewrites, []);
});

test("isAiCrawler recognizes AI crawlers and agents but not browsers or search engines", () => {
  for (const userAgent of [
    GPTBOT,
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Claude-User/1.0",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "CCBot/2.0 (https://commoncrawl.org/faq/)",
    "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)",
    "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
  ]) {
    assert.equal(isAiCrawler(userAgent), true, userAgent);
  }
  for (const userAgent of [
    BROWSER,
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)",
    "",
    null,
  ]) {
    assert.equal(isAiCrawler(userAgent), false, String(userAgent));
  }
});

test("query and asset classification matches the plugin's key rules", () => {
  const significant = (path) => {
    const url = new URL(`https://${HOST}${path}`);
    return hasSignificantQuery(url, decodeURIComponent(url.pathname));
  };
  assert.equal(significant("/about/"), false);
  assert.equal(significant("/about/?"), false);
  assert.equal(significant("/about/?utm_campaign=x&_ga=1&mc_eid=2"), false);
  assert.equal(significant("/about/?replytocom=5"), true);
  assert.equal(significant("/about/?ref=partner"), true);
  assert.equal(significant("/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"), false);
  assert.equal(significant("/files/report.pdf?download=1"), false);

  assert.equal(isAssetPath("/wp-content/uploads/2026/08/a.jpg"), true);
  assert.equal(isAssetPath("/wp-content/plugins/x/endpoint.php"), false);
  assert.equal(isAssetPath("/feed/"), false);
  assert.equal(isAssetPath("/sitemap.xml"), true);
  assert.equal(isAssetPath("/.well-known"), false);
});

test("invalid edge and AI settings fail closed", async () => {
  for (const record of [
    { mode: "fast" },
    { ai: "allow" },
    { ai: ["edge"] },
    { bypassPaths: "/members/" },
    { bypassPaths: ["members/"] },
    { bypassCookies: ["bad cookie"] },
    { bypassCookies: Array.from({ length: 51 }, (_, index) => `c${index}`) },
    { ingestKeySha256: "abc" },
    { ingestKeySha256: "A".repeat(64) },
    { edgeSecret: "too-short" },
    { edgeSecret: "has a space but is long enough" },
  ]) {
    const r2 = snapshotBucket();
    const seen = origin();
    const response = await handleRequest(get("/"), siteEnv(r2, record));
    assert.equal(response.status, 503, JSON.stringify(record));
    assert.equal(seen.length, 0, JSON.stringify(record));
    assert.deepEqual(r2.calls, [], JSON.stringify(record));
  }
});

test("single-site DEFAULT_* variables configure edge mode", async () => {
  const seen = origin();
  const env = {
    DEFAULT_HOST: HOST,
    DEFAULT_ORIGIN: "https://origin.example",
    DEFAULT_MODE: "edge",
    DEFAULT_BYPASS_PATHS: "/members/, /shop/",
    DEFAULT_BYPASS_COOKIES: "my_session",
    SNAPSHOTS: snapshotBucket(),
  };

  const page = await handleRequest(get("/about/"), env);
  const members = await handleRequest(get("/shop/basket/"), env);
  const session = await handleRequest(get("/about/", { Cookie: "my_session=1" }), env);

  assert.equal(await page.text(), "saved about");
  assert.equal(await members.text(), "from origin");
  assert.equal(await session.text(), "from origin");
  assert.equal(seen.length, 2);

  const invalid = await handleRequest(get("/about/"), { ...env, DEFAULT_MODE: "turbo" });
  assert.equal(invalid.status, 503);
});

test("only this Worker vouches for the forwarded host and client IP", async () => {
  const seen = origin();
  const secret = "edge-secret-0123456789";
  const spoofed = { "X-Lifeboat-Edge": "guess", "X-Lifeboat-Client-IP": "6.6.6.6", "CF-Connecting-IP": "203.0.113.9" };

  await handleRequest(get("/?s=x", spoofed), siteEnv(snapshotBucket(), { edgeSecret: secret }));
  await handleRequest(get("/?s=x", spoofed), siteEnv(snapshotBucket()));

  assert.equal(seen[0].headers.get("X-Lifeboat-Edge"), secret);
  assert.equal(seen[0].headers.get("X-Lifeboat-Client-IP"), "203.0.113.9");
  assert.equal(seen[0].headers.get("X-Forwarded-Host"), HOST);
  assert.equal(seen[1].headers.get("X-Lifeboat-Edge"), null);
  assert.equal(seen[1].headers.get("X-Lifeboat-Client-IP"), null);
});

test("metering records one Analytics Engine data point per site request", async () => {
  const points = [];
  const metrics = { writeDataPoint(point) { points.push(point); } };
  origin();
  const env = siteEnv(snapshotBucket(), { ai: "edge" }, { METRICS: metrics });

  await handleRequest(get("/"), env);
  await handleRequest(get("/?s=x"), env);
  await handleRequest(get("/about/", { "User-Agent": GPTBOT }), env);
  await handleRequest(new Request("https://unknown.example/"), env);

  assert.deepEqual(points.map((point) => point.blobs), [
    [HOST, "edge", "visitor", "200"],
    [HOST, "origin", "visitor", "200"],
    [HOST, "edge", "ai", "200"],
  ]);
  assert.deepEqual(points[0].indexes, [HOST]);

  const throwing = siteEnv(snapshotBucket(), {}, { METRICS: { writeDataPoint() { throw new Error("quota"); } } });
  assert.equal((await handleRequest(get("/"), throwing)).status, 200, "metering never changes the response");
});

test("encoded dot segments cannot steer the edge cache to another version's entries", async () => {
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  const ctx = waitUntilCollector();
  const r2 = snapshotBucket({ [`${PREFIX}/secret/index.html`]: r2Object("unpublished secret") });
  const env = siteEnv(r2, {}, { POINTER_TTL_MS: "0" });
  origin();

  assert.equal(await (await handleRequest(get("/secret/"), env, ctx)).text(), "unpublished secret");
  await ctx.settle();

  // Unpublish: the object goes and the pointer moves to a new version.
  r2.entries.delete(`${PREFIX}/secret/index.html`);
  r2.entries.set(`sites/${HOST}/current.json`, pointer(HOST, ID, PREFIX, "2026-09-01T15:00:00+00:00"));

  for (const path of ["/secret/", `/..%2F${ID}%2Fsecret%2F`, `/..%2F..%2F__lifeboat-edge%2F${ID}%2Fsecret%2F`]) {
    const response = await handleRequest(get(path), env, ctx);
    assert.notEqual(await response.text(), "unpublished secret", path);
  }
});

test("every spelling of the forwarding headers is replaced by the Worker's own", async () => {
  const seen = origin();
  const secret = "edge-secret-0123456789";

  await handleRequest(get("/?s=x", {
    "CF-Connecting-IP": "203.0.113.9",
    X_Lifeboat_Client_IP: "6.6.6.6",
    X_Lifeboat_Edge: "guess",
    X_Forwarded_Host: "attacker.example",
    x_forwarded_proto: "http",
  }), siteEnv(snapshotBucket(), { edgeSecret: secret }));

  const names = [...seen[0].headers.keys()];
  assert.deepEqual(names.filter((name) => name.includes("_")), []);
  assert.equal(seen[0].headers.get("X-Lifeboat-Client-IP"), "203.0.113.9");
  assert.equal(seen[0].headers.get("X-Lifeboat-Edge"), secret);
  assert.equal(seen[0].headers.get("X-Forwarded-Host"), HOST);
  assert.equal(seen[0].headers.get("X-Forwarded-Proto"), "https");
});

test("Lifeboat's own manifest and 404 objects are never served for request paths", async () => {
  const r2 = snapshotBucket({ [`${PREFIX}/manifest.json`]: r2Object('{"objects":{"cart/index.html":{}}}', { contentType: "application/json" }) });

  const seen = origin(() => new Response("site manifest", { status: 200 }));
  const visitor = await handleRequest(get("/manifest.json"), siteEnv(r2));
  const notFoundPage = await handleRequest(get("/__404.html"), siteEnv(r2));
  assert.equal(await visitor.text(), "site manifest");
  assert.equal(await notFoundPage.text(), "site manifest");
  assert.equal(seen.length, 2);

  const crawler = await handleRequest(get("/manifest.json", { "User-Agent": GPTBOT }), siteEnv(r2, { ai: "edge-only" }));
  assert.equal(crawler.status, 404);
  assert.equal(await crawler.text(), "saved not found");

  origin("down");
  __testing.resetBreakers();
  const outage = await handleRequest(get("/manifest.json"), siteEnv(r2, { mode: "failover" }));
  assert.equal(outage.status, 404);
  assert.equal(await outage.text(), "saved not found");
});

test("API parameters are recognized under PHP's name mangling", async () => {
  for (const [name, expected] of [
    ["rest_route", "rest_route"],
    ["rest.route", "rest_route"],
    ["rest route", "rest_route"],
    ["  rest_route", "rest_route"],
    ["rest[route", "rest_route"],
    ["rest_route[]", "rest_route"],
    ["rest_route[x]", "rest_route"],
    ["a.b[c.d", "a_b_c_d"],
    ["wc-ajax", "wc-ajax"],
  ]) {
    assert.equal(phpParamName(name), expected, name);
  }

  for (const path of ["/?rest.route=/wp/v2/users", "/?rest+route=/wp/v2/users", "/?rest%5Broute=/wp/v2/users"]) {
    origin("down");
    __testing.resetBreakers();
    const outage = await handleRequest(get(path), siteEnv(snapshotBucket(), { mode: "failover" }));
    assert.equal(outage.status, 503, path);
  }

  const seen = origin();
  const crawler = await handleRequest(get("/wp-content/x.css?rest.route=/wp/v2/users", { "User-Agent": GPTBOT }), siteEnv(snapshotBucket(), { ai: "edge" }));
  assert.equal(crawler.status, 403);
  assert.equal(seen.length, 0);
});

test("crawlers reach WordPress only with the bare page URL", async () => {
  const seen = origin();
  const env = siteEnv(snapshotBucket(), { mode: "failover", ai: "edge" });

  await handleRequest(get("/missing.css?add-to-cart=42", { "User-Agent": GPTBOT }), env);
  await handleRequest(get("/new-post/?utm_source=x", { "User-Agent": GPTBOT }), env);

  assert.deepEqual(seen.map((request) => request.url), [
    "https://origin.example/missing.css",
    "https://origin.example/new-post/",
  ]);
});
