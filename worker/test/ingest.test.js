import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";

import { handleRequest } from "../src/index.js";
import { FakeR2, kv } from "./fakes.js";

const INGEST = "ingest.example";
const HOST = "site.example";
const KEY = "lbk_0123456789abcdefghijklmnopqrstuv";
const KEY_SHA256 = createHash("sha256").update(KEY).digest("hex");
const SNAP = `sites/${HOST}/snapshots/20260901-140000`;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function serviceEnv(r2 = new FakeR2(), extra = {}) {
  return {
    INGEST_HOST: INGEST,
    SITES: kv({
      [HOST]: { origin: "https://origin.example", mode: "edge", ai: "edge", ingestKeySha256: KEY_SHA256 },
      "www.site.example": { canonicalHost: HOST, origin: "https://origin.example", ingestKeySha256: KEY_SHA256 },
      "nokey.example": { origin: "https://nokey-origin.example" },
      "other.example": { origin: "https://other-origin.example", ingestKeySha256: "f".repeat(64) },
    }),
    SNAPSHOTS: r2,
    ...extra,
  };
}

function ingest(path, { method = "GET", site = HOST, key = KEY, body, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (site !== null) allHeaders["X-Lifeboat-Site"] = site;
  if (key !== null) allHeaders.Authorization = `Bearer ${key}`;
  if (typeof body === "string" && !("Content-Length" in allHeaders)) {
    allHeaders["Content-Length"] = String(new TextEncoder().encode(body).byteLength);
  }
  return new Request(`https://${INGEST}${path}`, { method, headers: allHeaders, body });
}

function objectPath(key) {
  return `/v1/object?key=${encodeURIComponent(key)}`;
}

async function json(response) {
  return JSON.parse(await response.text());
}

test("ingest needs the site's own key and gives one answer for every rejection", async () => {
  const r2 = new FakeR2();
  const env = serviceEnv(r2);
  const rejected = [
    ingest("/v1/site", { key: null }),
    ingest("/v1/site", { site: null }),
    ingest("/v1/site", { key: "lbk_wrong-key-0123456789abcdef" }),
    ingest("/v1/site", { key: "short" }),
    ingest("/v1/site", { site: "www.site.example" }),
    ingest("/v1/site", { site: "nokey.example" }),
    ingest("/v1/site", { site: "other.example" }),
    ingest("/v1/site", { site: "unknown.example" }),
  ];

  const messages = new Set();
  for (const request of rejected) {
    const response = await handleRequest(request, env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    messages.add((await json(response)).error);
  }
  assert.equal(messages.size, 2, "missing credentials vs. everything else");
  assert.deepEqual(r2.ops, []);
});

test("whoami reports the prefix and policies the service holds for the site", async () => {
  const response = await handleRequest(ingest("/v1/site"), serviceEnv());

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { host: HOST, prefix: `sites/${HOST}`, mode: "edge", ai: "edge" });
});

test("objects round-trip with content type, cache control and metadata", async () => {
  const r2 = new FakeR2();
  const env = serviceEnv(r2);
  const key = `${SNAP}/wp-content/uploads/łódź photo.css`;

  const put = await handleRequest(ingest(objectPath(key), {
    method: "PUT",
    body: "body{color:red}",
    headers: {
      "Content-Type": "text/css",
      "Cache-Control": "public, max-age=600",
      "X-Lifeboat-Metadata": JSON.stringify({ sha256: "abc", "lifeboat-cache": "private" }),
    },
  }), env);
  assert.equal(put.status, 200);
  assert.deepEqual(r2.entries.get(key).httpMetadata, { contentType: "text/css", cacheControl: "public, max-age=600" });
  assert.deepEqual(r2.entries.get(key).customMetadata, { sha256: "abc", "lifeboat-cache": "private" });

  const got = await handleRequest(ingest(objectPath(key)), env);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), "body{color:red}");
  assert.equal(got.headers.get("Content-Type"), "text/css");

  assert.equal((await handleRequest(ingest(objectPath(key), { method: "HEAD" }), env)).status, 200);
  assert.equal((await handleRequest(ingest(objectPath(key), { method: "DELETE" }), env)).status, 200);
  assert.equal((await handleRequest(ingest(objectPath(key), { method: "HEAD" }), env)).status, 404);
  assert.equal((await handleRequest(ingest(objectPath(key)), env)).status, 404);
});

test("an empty upload is stored as an empty object", async () => {
  const r2 = new FakeR2();
  const key = `${SNAP}/empty.txt`;

  const response = await handleRequest(ingest(objectPath(key), { method: "PUT", body: "", headers: { "Content-Type": "text/plain" } }), serviceEnv(r2));

  assert.equal(response.status, 200);
  assert.equal(r2.text(key), "");
});

test("keys outside the site's own prefix are refused", async () => {
  const r2 = new FakeR2({ "sites/other.example/current.json": { bytes: new Uint8Array(), size: 0 } });
  const env = serviceEnv(r2);

  for (const key of [
    "sites/other.example/current.json",
    `sites/${HOST}`,
    `sites/${HOST}/`,
    `sites/${HOST}evil/current.json`,
    `sites/${HOST}/../other.example/current.json`,
    `sites/${HOST}/./current.json`,
    `sites/${HOST}//current.json`,
    `sites/${HOST}/a\u0000b`,
    `sites/${HOST}/${"x".repeat(1100)}`,
  ]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await handleRequest(ingest(objectPath(key), { method, body: method === "PUT" ? "x" : undefined }), env);
      assert.equal(response.status, 403, `${method} ${key.slice(0, 60)}`);
    }
  }
  assert.ok(!r2.ops.some(([op]) => op !== "get"), "nothing was written or deleted");
  assert.ok(r2.entries.has("sites/other.example/current.json"));
});

test("uploads need a declared length within the service limit", async () => {
  const env = serviceEnv(new FakeR2(), { INGEST_MAX_BYTES: "4" });
  const key = `${SNAP}/index.html`;

  const tooLarge = await handleRequest(ingest(objectPath(key), { method: "PUT", body: "12345" }), env);
  const unknownLength = await handleRequest(new Request(`https://${INGEST}${objectPath(key)}`, {
    method: "PUT",
    headers: { "X-Lifeboat-Site": HOST, Authorization: `Bearer ${KEY}` },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x")); controller.close(); } }),
    duplex: "half",
  }), env);

  assert.equal(tooLarge.status, 413);
  assert.equal(unknownLength.status, 411);
});

test("object metadata must be a JSON object of short ASCII strings", async () => {
  const env = serviceEnv();
  const key = `${SNAP}/index.html`;
  for (const metadata of ["not json", "[]", '{"Upper":"x"}', '{"n":1}', `{"n":"${"x".repeat(2049)}"}`, '{"n":"café"}']) {
    const response = await handleRequest(ingest(objectPath(key), {
      method: "PUT",
      body: "<html></html>",
      headers: { "X-Lifeboat-Metadata": metadata },
    }), env);
    assert.equal(response.status, 400, metadata.slice(0, 40));
  }
});

test("copy duplicates body and metadata inside the prefix only", async () => {
  const r2 = new FakeR2();
  const env = serviceEnv(r2);
  const from = `${SNAP}/a.css`;
  const to = `sites/${HOST}/snapshots/20260902-000000/a.css`;
  await handleRequest(ingest(objectPath(from), {
    method: "PUT",
    body: "a{}",
    headers: { "Content-Type": "text/css", "X-Lifeboat-Metadata": '{"sha256":"aa"}' },
  }), env);

  const copy = (payload) => handleRequest(ingest("/v1/copy", { method: "POST", body: JSON.stringify(payload) }), env);
  assert.equal((await copy({ from, to })).status, 200);
  assert.equal(r2.text(to), "a{}");
  assert.equal(r2.entries.get(to).httpMetadata.contentType, "text/css");
  assert.deepEqual(r2.entries.get(to).customMetadata, { sha256: "aa" });

  assert.equal((await copy({ from, to: "sites/other.example/stolen.css" })).status, 403);
  assert.equal((await copy({ from: "sites/other.example/x.css", to })).status, 403);
  assert.equal((await copy({ from: `${SNAP}/missing.css`, to })).status, 404);
  const malformed = await handleRequest(ingest("/v1/copy", { method: "POST", body: "{" }), env);
  assert.equal(malformed.status, 400);
});

test("list pages through keys and delimited snapshot prefixes", async () => {
  const r2 = new FakeR2();
  const env = serviceEnv(r2);
  for (const key of [`${SNAP}/index.html`, `${SNAP}/about/index.html`, `sites/${HOST}/snapshots/20260902-000000/index.html`, `sites/${HOST}/current.json`]) {
    await handleRequest(ingest(objectPath(key), { method: "PUT", body: "x" }), env);
  }

  const snapshots = await json(await handleRequest(ingest(`/v1/list?prefix=${encodeURIComponent(`sites/${HOST}/snapshots/`)}&delimiter=/`), env));
  assert.deepEqual(snapshots.prefixes, [`${SNAP}/`, `sites/${HOST}/snapshots/20260902-000000/`]);
  assert.deepEqual(snapshots.keys, []);

  const first = await json(await handleRequest(ingest(`/v1/list?prefix=${encodeURIComponent(`${SNAP}/`)}&limit=1`), env));
  assert.equal(first.keys.length, 1);
  assert.ok(first.next);
  const second = await json(await handleRequest(ingest(`/v1/list?prefix=${encodeURIComponent(`${SNAP}/`)}&limit=1&cursor=${encodeURIComponent(first.next)}`), env));
  assert.equal(second.keys.length, 1);
  assert.equal(second.next, null);
  assert.notEqual(first.keys[0].key, second.keys[0].key);

  const outside = await handleRequest(ingest(`/v1/list?prefix=${encodeURIComponent("sites/")}`), env);
  assert.equal(outside.status, 403);
});

test("bulk delete is all-or-nothing on confinement", async () => {
  const r2 = new FakeR2();
  const env = serviceEnv(r2);
  const keys = [`${SNAP}/a.html`, `${SNAP}/b.html`];
  for (const key of keys) await handleRequest(ingest(objectPath(key), { method: "PUT", body: "x" }), env);

  const mixed = await handleRequest(ingest("/v1/delete", { method: "POST", body: JSON.stringify({ keys: [...keys, "sites/other.example/current.json"] }) }), env);
  assert.equal(mixed.status, 403);
  assert.ok(keys.every((key) => r2.entries.has(key)));

  const ok = await handleRequest(ingest("/v1/delete", { method: "POST", body: JSON.stringify({ keys }) }), env);
  assert.deepEqual(await json(ok), { ok: true, deleted: 2 });
  assert.ok(keys.every((key) => !r2.entries.has(key)));

  const empty = await handleRequest(ingest("/v1/delete", { method: "POST", body: JSON.stringify({ keys: [] }) }), env);
  assert.equal(empty.status, 400);
});

test("wrong methods and unknown endpoints are rejected", async () => {
  const env = serviceEnv();
  assert.equal((await handleRequest(ingest("/v1/site", { method: "POST", body: "" }), env)).status, 405);
  assert.equal((await handleRequest(ingest("/v1/copy"), env)).status, 405);
  assert.equal((await handleRequest(ingest(objectPath(`${SNAP}/x`), { method: "PATCH", body: "" }), env)).status, 405);
  assert.equal((await handleRequest(ingest("/v2/anything"), env)).status, 404);
});

test("the ingest API exists only on INGEST_HOST", async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return new Response("site origin"); };

  const onSite = await handleRequest(new Request(`https://${HOST}/v1/site`, {
    headers: { "X-Lifeboat-Site": HOST, Authorization: `Bearer ${KEY}` },
  }), serviceEnv());
  assert.equal(await onSite.text(), "site origin");
  assert.equal(fetched, 1);

  const unconfigured = await handleRequest(ingest("/v1/site"), { ...serviceEnv(), INGEST_HOST: undefined });
  assert.equal(unconfigured.status, 503);
});

test("single-site ingest uses DEFAULT_INGEST_KEY_SHA256 but never the workers.dev bootstrap", async () => {
  const exact = {
    INGEST_HOST: INGEST,
    DEFAULT_HOST: HOST,
    DEFAULT_ORIGIN: "https://origin.example",
    DEFAULT_INGEST_KEY_SHA256: KEY_SHA256,
    SNAPSHOTS: new FakeR2(),
  };
  assert.equal((await handleRequest(ingest("/v1/site"), exact)).status, 200);

  const bootstrap = { ...exact, DEFAULT_HOST: undefined };
  const response = await handleRequest(ingest("/v1/site", { site: "lifeboat-demo.account.workers.dev" }), bootstrap);
  assert.equal(response.status, 401);
});
