import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import worker, { __testing, handleRequest, isBypassRequest, pathToKey } from "../src/index.js";

const originalFetch = globalThis.fetch;
const originalRewriter = globalThis.HTMLRewriter;

beforeEach(() => {
  __testing.resetBreakers();
  delete globalThis.HTMLRewriter;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRewriter === undefined) delete globalThis.HTMLRewriter;
  else globalThis.HTMLRewriter = originalRewriter;
});

function r2Object(body, { contentType = "text/html; charset=UTF-8", customMetadata = {} } = {}) {
  const encoded = new TextEncoder().encode(body);
  return {
    body: encoded,
    size: encoded.byteLength,
    httpMetadata: { contentType },
    customMetadata,
    async text() { return body; },
    writeHttpMetadata(headers) { headers.set("Content-Type", contentType); },
  };
}

class FakeR2 {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.calls = [];
  }

  async get(key) {
    this.calls.push(key);
    return this.entries.get(key) ?? null;
  }
}

function pointer(host = "site.example", id = "20260901-140000", prefix = `sites/${host}/snapshots/${id}`) {
  return r2Object(JSON.stringify({ snapshot_id: id, prefix, host }), { contentType: "application/json" });
}

function defaultEnv(r2, extra = {}) {
  return {
    DEFAULT_HOST: "site.example",
    DEFAULT_ORIGIN: "https://origin.example",
    SNAPSHOTS: r2,
    ...extra,
  };
}

function fallbackBucket({ body = "<html><body><form><input></form><h1>Saved</h1></body></html>", type, path = "index.html", metadata } = {}) {
  return new FakeR2({
    "sites/site.example/current.json": pointer(),
    [`sites/site.example/snapshots/20260901-140000/${path}`]: r2Object(body, { contentType: type, customMetadata: metadata }),
  });
}

test("pathToKey mirrors the README mapping", () => {
  assert.equal(pathToKey("/"), "index.html");
  assert.equal(pathToKey("/about/"), "about/index.html");
  assert.equal(pathToKey("/about"), "about/index.html");
  assert.equal(pathToKey("/feed/"), "feed/index.html");
  assert.equal(pathToKey("/wp-content/uploads/łódź photo.jpg"), "wp-content/uploads/łódź photo.jpg");
  assert.equal(pathToKey("//nested"), "nested/index.html");
});

test("module entry point delegates to the request handler", async () => {
  globalThis.fetch = async () => new Response("origin", { status: 200 });
  const response = await worker.fetch(new Request("https://site.example/"), defaultEnv(new FakeR2()));
  assert.equal(await response.text(), "origin");
});

test("an unconfigured hostname cannot use the default origin or bucket prefix", async () => {
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("wrong site"); };
  const r2 = fallbackBucket();

  const response = await handleRequest(new Request("https://other.example/"), defaultEnv(r2));

  assert.equal(response.status, 503);
  assert.equal(fetches, 0);
  assert.deepEqual(r2.calls, []);
});

test("an empty optional SITES binding still falls through to the exact demo defaults", async () => {
  let lookedUp;
  globalThis.fetch = async () => new Response("demo origin", { status: 200 });
  const env = defaultEnv(new FakeR2(), {
    SITES: { async get(key) { lookedUp = key; return null; } },
  });

  const response = await handleRequest(new Request("https://site.example/"), env);

  assert.equal(lookedUp, "site.example");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "demo origin");
});

test("workers.dev bootstrap remains host-scoped when DEFAULT_HOST is omitted", async () => {
  let target;
  let forwardedHost;
  let forwardedProto;
  globalThis.fetch = async (request) => {
    target = request.url;
    forwardedHost = request.headers.get("X-Forwarded-Host");
    forwardedProto = request.headers.get("X-Forwarded-Proto");
    return new Response("origin");
  };
  const env = { DEFAULT_ORIGIN: "https://origin.example", SNAPSHOTS: new FakeR2() };

  const response = await handleRequest(new Request("https://lifeboat-demo.account.workers.dev/hello?q=1"), env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin");
  assert.equal(target, "https://origin.example/hello?q=1");
  assert.equal(forwardedHost, "lifeboat-demo.account.workers.dev");
  assert.equal(forwardedProto, "https");

  const rejected = await handleRequest(new Request("https://custom.example/"), env);
  assert.equal(rejected.status, 503);
});

test("origin responses below 500 pass through, including a real 404", async () => {
  const r2 = fallbackBucket();
  globalThis.fetch = async () => new Response("origin 404", { status: 404, headers: { "X-Origin": "yes" } });

  const response = await handleRequest(new Request("https://site.example/missing"), defaultEnv(r2));

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "origin 404");
  assert.equal(response.headers.get("X-Origin"), "yes");
  assert.deepEqual(r2.calls, []);
});

test("an origin 5xx falls back and opens the isolate-local breaker", async () => {
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("failed", { status: 530 }); };
  const r2 = fallbackBucket();

  const first = await handleRequest(new Request("https://site.example/"), defaultEnv(r2));
  const second = await handleRequest(new Request("https://site.example/"), defaultEnv(r2));

  assert.equal(first.status, 200);
  assert.equal(first.headers.get("X-Lifeboat"), "20260901-140000");
  assert.match(await first.text(), /Saved/);
  assert.equal(second.status, 200);
  assert.equal(fetches, 1);
});

test("network errors fall back to the percent-decoded R2 key and ignore the query", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const id = "20260901-140000";
  const r2 = new FakeR2({
    "sites/site.example/current.json": pointer(),
    [`sites/site.example/snapshots/${id}/café/index.html`]: r2Object("saved café"),
  });

  const response = await handleRequest(new Request("https://site.example/caf%C3%A9/?preview=1"), defaultEnv(r2));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "saved café");
  assert.ok(r2.calls.includes(`sites/site.example/snapshots/${id}/café/index.html`));
});

test("a malformed percent-encoded path returns 400 before origin or R2 access", async () => {
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("origin"); };
  const r2 = fallbackBucket();

  const response = await handleRequest(new Request("https://site.example/bad%ZZ"), defaultEnv(r2));

  assert.equal(response.status, 400);
  assert.equal(fetches, 0);
  assert.deepEqual(r2.calls, []);
});

test("only an exact configured crawler secret causes crawler bypass", async () => {
  const r2 = fallbackBucket();
  globalThis.fetch = async () => { throw new Error("offline"); };

  const wrong = await handleRequest(new Request("https://site.example/", {
    headers: { "X-Lifeboat-Crawl": "wrong" },
  }), defaultEnv(r2, { CRAWL_SECRET: "right" }));
  assert.equal(wrong.status, 200);
  assert.equal(wrong.headers.get("X-Lifeboat"), "20260901-140000");

  __testing.resetBreakers();
  const exact = await handleRequest(new Request("https://site.example/", {
    headers: { "X-Lifeboat-Crawl": "right" },
  }), defaultEnv(r2, { CRAWL_SECRET: "right" }));
  assert.equal(exact.status, 503);
  assert.equal(exact.headers.get("X-Lifeboat"), null);

  assert.equal(isBypassRequest(new Request("https://site.example/", {
    headers: { "X-Lifeboat-Crawl": "anything" },
  }), "/", undefined), false);
});

test("admin and logged-in requests never receive a public snapshot", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const r2 = fallbackBucket();

  const admin = await handleRequest(new Request("https://site.example/wp-admin/edit.php"), defaultEnv(r2));
  __testing.resetBreakers();
  const loggedIn = await handleRequest(new Request("https://site.example/", {
    headers: { Cookie: "foo=1; wordpress_logged_in_abcd=user; bar=2" },
  }), defaultEnv(r2));

  assert.equal(admin.status, 503);
  assert.equal(loggedIn.status, 503);
  assert.equal(admin.headers.get("Retry-After"), "30");
  assert.equal(r2.calls.length, 0);
});

test("mutating requests pass through to the origin but never fall back", async () => {
  const r2 = fallbackBucket();
  let seenMethod;
  let seenBody;
  globalThis.fetch = async (request) => {
    seenMethod = request.method;
    seenBody = await request.text();
    return new Response("updated", { status: 201 });
  };

  const success = await handleRequest(new Request("https://site.example/wp-comments-post.php", {
    method: "POST",
    body: "comment=hello",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }), defaultEnv(r2));
  assert.equal(success.status, 201);
  assert.equal(await success.text(), "updated");
  assert.equal(seenMethod, "POST");
  assert.equal(seenBody, "comment=hello");

  __testing.resetBreakers();
  globalThis.fetch = async () => new Response("origin failure", { status: 502 });
  const failure = await handleRequest(new Request("https://site.example/wp-comments-post.php", {
    method: "POST",
    body: "comment=hello",
  }), defaultEnv(r2));
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("X-Lifeboat"), null);
  assert.equal(r2.calls.length, 0);
});

test("force_fallback in an exact KV record skips the origin", async () => {
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("origin"); };
  const host = "canonical.example";
  const id = "snap-1";
  const r2 = new FakeR2({
    [`sites/${host}/current.json`]: pointer(host, id),
    [`sites/${host}/snapshots/${id}/index.html`]: r2Object("canonical saved"),
  });
  const env = {
    SITES: { async get(key) {
      assert.equal(key, "alias.example");
      return { origin: "https://origin.example", canonicalHost: host, force_fallback: true };
    } },
    SNAPSHOTS: r2,
  };

  const response = await handleRequest(new Request("https://alias.example/"), env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "canonical saved");
  assert.equal(fetches, 0);
  assert.deepEqual(r2.calls, [
    "sites/canonical.example/current.json",
    "sites/canonical.example/snapshots/snap-1/index.html",
  ]);
});

test("custom prefixes work but unsafe configured and crossed promoted prefixes fail closed", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const custom = new FakeR2({
    "archives/brand/current.json": pointer("site.example", "snap", "archives/brand/snapshots/snap"),
    "archives/brand/snapshots/snap/index.html": r2Object("custom prefix"),
  });
  const customEnv = {
    SITES: { async get() { return { origin: "https://origin.example", prefix: "archives/brand", force_fallback: true }; } },
    SNAPSHOTS: custom,
  };
  const customResponse = await handleRequest(new Request("https://site.example/"), customEnv);
  assert.equal(customResponse.status, 200);
  assert.equal(await customResponse.text(), "custom prefix");

  __testing.resetBreakers();
  const r2 = fallbackBucket();
  const badConfig = {
    SITES: { async get() { return { origin: "https://origin.example", prefix: "/sites/site.example/../another" }; } },
    SNAPSHOTS: r2,
  };
  const configResponse = await handleRequest(new Request("https://site.example/"), badConfig);
  assert.equal(configResponse.status, 503);
  assert.deepEqual(r2.calls, []);

  __testing.resetBreakers();
  const crossed = new FakeR2({
    "sites/site.example/current.json": pointer("site.example", "snap", "sites/another.example/snapshots/snap"),
    "sites/another.example/snapshots/snap/index.html": r2Object("leaked"),
  });
  const pointerResponse = await handleRequest(new Request("https://site.example/"), defaultEnv(crossed));
  assert.equal(pointerResponse.status, 503);
  assert.doesNotMatch(await pointerResponse.text(), /leaked/);
});

test("redirectTo is opt-in, safe, and preserves path and query", async () => {
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("origin"); };
  const env = {
    SITES: { async get() { return { redirectTo: "https://canonical.example", canonicalHost: "canonical.example" }; } },
    SNAPSHOTS: new FakeR2(),
  };

  const response = await handleRequest(new Request("https://alias.example/a%20b/?q=one"), env);

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "https://canonical.example/a%20b/?q=one");
  assert.equal(fetches, 0);

  const networkPath = await handleRequest(new Request("https://alias.example//attacker.example/path?q=two"), env);
  assert.equal(networkPath.headers.get("Location"), "https://canonical.example//attacker.example/path?q=two");
});

test("R2 redirect metadata becomes a 301 with the snapshot header", async () => {
  globalThis.fetch = async () => new Response("failed", { status: 500 });
  const r2 = fallbackBucket({ metadata: { "lifeboat-redirect": "https://site.example/new/" } });

  const response = await handleRequest(new Request("https://site.example/"), defaultEnv(r2));

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "https://site.example/new/");
  assert.equal(response.headers.get("X-Lifeboat"), "20260901-140000");
  assert.equal(await response.text(), "");
});

test("an object miss serves the stored 404 object with status 404", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const id = "20260901-140000";
  const r2 = new FakeR2({
    "sites/site.example/current.json": pointer(),
    [`sites/site.example/snapshots/${id}/__404.html`]: r2Object("custom not found", { contentType: "text/html; charset=UTF-8" }),
  });

  const response = await handleRequest(new Request("https://site.example/nope/"), defaultEnv(r2));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=UTF-8");
  assert.equal(response.headers.get("X-Lifeboat"), id);
  assert.equal(await response.text(), "custom not found");
});

test("HEAD fallback has the stored metadata and no body", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const r2 = fallbackBucket({ body: "body must be omitted", type: "application/rss+xml", path: "feed/index.html" });

  const response = await handleRequest(new Request("https://site.example/feed/", { method: "HEAD" }), defaultEnv(r2));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/rss+xml");
  assert.equal(response.headers.get("X-Lifeboat"), "20260901-140000");
  assert.equal(await response.text(), "");
});

test("HTMLRewriter injects the banner and disables every form control", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const events = [];

  globalThis.HTMLRewriter = class {
    constructor() { this.handlers = []; }
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) {
        const changes = [];
        handler.element({
          prepend(value, options) { changes.push(["prepend", value, options]); },
          setAttribute(name, value) { changes.push([name, value]); },
        });
        events.push([selector, changes]);
      }
      return new Response("rewritten snapshot", { status: response.status, headers: response.headers });
    }
  };

  const response = await handleRequest(new Request("https://site.example/"), defaultEnv(fallbackBucket()));

  assert.equal(await response.text(), "rewritten snapshot");
  assert.deepEqual(events.map(([selector]) => selector), [
    "body", "form", "form input", "form button", "form select", "form textarea",
  ]);
  assert.match(events[0][1][0][1], /saved, read-only copy/);
  assert.ok(events[1][1].some(([name]) => name === "inert"));
  for (const [, changes] of events.slice(2)) {
    assert.deepEqual(changes, [["disabled", "disabled"]]);
  }
});

test("missing snapshot state returns the built-in read-only 503", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };

  const response = await handleRequest(new Request("https://site.example/"), defaultEnv(new FakeR2()));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.match(await response.text(), /temporarily read-only/);
});
