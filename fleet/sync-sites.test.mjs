import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { generateSiteCredentials } from "./site-key.mjs";
import { compileInventory, redactRecords } from "./sync-sites.mjs";
import { handleRequest } from "../worker/src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const exampleInventory = JSON.parse(readFileSync(join(here, "sites.example.json"), "utf8"));
const EDGE_SECRET = "edge-secret-for-tests-0123456789";

function inventory(site) {
  return { version: 1, sites: [{ canonicalHost: "example.com", origin: "https://wp-origin.example.net", ...site }] };
}

function recordsByKey(records) {
  return Object.fromEntries(records.map(({ key, value }) => [key, value]));
}

test("inventories without the new fields compile exactly as before", () => {
  const { records } = compileInventory(exampleInventory);
  assert.deepEqual(recordsByKey(records), {
    "example.com": { origin: "https://wp-origin.example.net", prefix: "sites/example.com", force_fallback: false },
    "news.example.com": { origin: "https://news-origin.example.net", prefix: "sites/news.example.com", force_fallback: false },
    "www.example.com": { canonicalHost: "example.com", origin: "https://wp-origin.example.net", prefix: "sites/example.com", force_fallback: false },
  });
});

test("routing fields reach canonical and alias records; the ingest hash only the canonical one", () => {
  const hash = "a".repeat(64);
  const { records } = compileInventory(inventory({
    aliases: ["www.example.com"],
    mode: "edge",
    ai: "edge-only",
    bypassPaths: ["/cart/", "/checkout/"],
    bypassCookies: ["my_session"],
    ingestKeySha256: hash,
  }));
  const byKey = recordsByKey(records);

  for (const host of ["example.com", "www.example.com"]) {
    assert.equal(byKey[host].mode, "edge");
    assert.equal(byKey[host].ai, "edge-only");
    assert.deepEqual(byKey[host].bypassPaths, ["/cart/", "/checkout/"]);
    assert.deepEqual(byKey[host].bypassCookies, ["my_session"]);
  }
  assert.equal(byKey["example.com"].ingestKeySha256, hash);
  assert.equal(byKey["www.example.com"].ingestKeySha256, undefined);
});

test("invalid routing fields are rejected with the field path", () => {
  for (const [site, message] of [
    [{ mode: "fast" }, /sites\[0\]\.mode/],
    [{ ai: "allow" }, /sites\[0\]\.ai/],
    [{ bypassPaths: "/cart/" }, /sites\[0\]\.bypassPaths/],
    [{ bypassPaths: ["cart/"] }, /sites\[0\]\.bypassPaths\[0\]/],
    [{ bypassCookies: ["two words"] }, /sites\[0\]\.bypassCookies\[0\]/],
    [{ ingestKeySha256: "F".repeat(64) }, /ingestKeySha256/],
    [{ edgeSecret: EDGE_SECRET }, /unknown field "edgeSecret"/],
  ]) {
    assert.throws(() => compileInventory(inventory(site)), message, JSON.stringify(site));
  }
});

test("edge secrets come only from the secrets file and are redacted for display", () => {
  const { records } = compileInventory(inventory({ aliases: ["www.example.com"] }), {
    secrets: { "example.com": { edgeSecret: EDGE_SECRET } },
  });
  assert.equal(recordsByKey(records)["example.com"].edgeSecret, EDGE_SECRET);
  assert.equal(recordsByKey(records)["www.example.com"].edgeSecret, EDGE_SECRET);
  assert.ok(!JSON.stringify(redactRecords(records)).includes(EDGE_SECRET));
  assert.equal(recordsByKey(redactRecords(records))["example.com"].edgeSecret, "[redacted]");

  for (const [secrets, message] of [
    [{ "unknown.example": { edgeSecret: EDGE_SECRET } }, /not a canonical site/],
    [{ "www.example.com": { edgeSecret: EDGE_SECRET } }, /not a canonical site/],
    [{ "example.com": { edgeSecret: "short" } }, /16 to 256/],
    [{ "example.com": { edgeSecret: EDGE_SECRET, origin: "x" } }, /unknown field/],
    [[], /JSON object/],
  ]) {
    assert.throws(() => compileInventory(inventory({ aliases: ["www.example.com"] }), { secrets }), message);
  }
});

test("compiled records and generated keys are accepted by the Worker", async () => {
  const credentials = generateSiteCredentials();
  assert.match(credentials.siteKey, /^lbk_[A-Za-z0-9_-]{43}$/);
  assert.match(credentials.siteKeySha256, /^[0-9a-f]{64}$/);

  const { records } = compileInventory(inventory({
    aliases: ["www.example.com"],
    mode: "edge",
    ai: "edge",
    bypassPaths: ["/cart/"],
    ingestKeySha256: credentials.siteKeySha256,
  }), { secrets: { "example.com": { edgeSecret: credentials.edgeSecret } } });
  const byKey = recordsByKey(records);
  const env = {
    INGEST_HOST: "ingest.example.net",
    SITES: { async get(key) { return byKey[key] ?? null; } },
    SNAPSHOTS: { async get() { return null; } },
  };

  const whoami = await handleRequest(new Request("https://ingest.example.net/v1/site", {
    headers: { "X-Lifeboat-Site": "example.com", Authorization: `Bearer ${credentials.siteKey}` },
  }), env);
  assert.equal(whoami.status, 200);
  assert.deepEqual(await whoami.json(), { host: "example.com", prefix: "sites/example.com", mode: "edge", ai: "edge" });

  const originalFetch = globalThis.fetch;
  try {
    let forwarded;
    globalThis.fetch = async (request) => { forwarded = request; return new Response("origin"); };
    const page = await handleRequest(new Request("https://www.example.com/cart/"), env);
    assert.equal(await page.text(), "origin");
    assert.equal(forwarded.headers.get("X-Lifeboat-Edge"), credentials.edgeSecret);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a dry run never prints edge secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "lifeboat-fleet-test-"));
  try {
    const inventoryPath = join(directory, "sites.json");
    const secretsPath = join(directory, "secrets.json");
    writeFileSync(inventoryPath, JSON.stringify(inventory({ mode: "edge" })));
    writeFileSync(secretsPath, JSON.stringify({ "example.com": { edgeSecret: EDGE_SECRET } }));

    const result = spawnSync(process.execPath, [join(here, "sync-sites.mjs"), "--inventory", inventoryPath, "--secrets", secretsPath], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(EDGE_SECRET));
    assert.ok(!result.stderr.includes(EDGE_SECRET));
    assert.equal(JSON.parse(result.stdout).records[0].value.edgeSecret, "[redacted]");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
