#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Credentials for one site on a hosted Lifeboat service:
 * - siteKey goes to that WordPress site only (LIFEBOAT_SERVICE_KEY);
 * - siteKeySha256 goes into the reviewed inventory (ingestKeySha256), so the
 *   inventory and the SITES namespace never hold a usable key;
 * - edgeSecret goes into the secrets file and the site's LIFEBOAT_EDGE_SECRET.
 */
export function generateSiteCredentials(random = randomBytes) {
  const siteKey = `lbk_${random(32).toString("base64url")}`;
  return {
    siteKey,
    siteKeySha256: createHash("sha256").update(siteKey).digest("hex"),
    edgeSecret: random(24).toString("base64url"),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write("Usage: node fleet/site-key.mjs\nPrints a new site key, its SHA-256 for the inventory, and an edge secret.\n");
    process.exitCode = process.argv.includes("--help") || process.argv.includes("-h") ? 0 : 1;
  } else {
    process.stdout.write(`${JSON.stringify(generateSiteCredentials(), null, 2)}\n`);
  }
}
