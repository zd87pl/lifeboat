#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_INVENTORY = "fleet/sites.json";
const DEFAULT_BINDING = "SITES";
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MODES = new Set(["failover", "edge"]);
const AI_POLICIES = new Set(["origin", "edge", "edge-only", "block"]);
const COOKIE_PREFIX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MAX_LIST_ENTRIES = 50;
const REDACTED = "[redacted]";

function usage() {
  return `Usage: node fleet/sync-sites.mjs [options]

Validate and compile the Lifeboat site inventory. This is a dry run unless
--apply is present.

Options:
  --inventory <file>   Inventory JSON (default: ${DEFAULT_INVENTORY})
  --secrets <file>     Per-site secrets JSON kept out of the inventory, e.g.
                       { "example.com": { "edgeSecret": "..." } }; redacted in output
  --binding <name>     Worker KV binding (default: ${DEFAULT_BINDING})
  --config <file>      Wrangler config file, if it is not in the current directory
  --wrangler <path>    Wrangler executable (default: wrangler)
  --development        Permit http:// origins for local development
  --apply              Write the compiled records to remote Workers KV
  --help               Show this help
`;
}

function fail(message) {
  throw new Error(message);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    inventory: DEFAULT_INVENTORY,
    secrets: null,
    binding: DEFAULT_BINDING,
    config: null,
    wrangler: "wrangler",
    development: false,
    apply: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--inventory":
        options.inventory = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--secrets":
        options.secrets = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--binding":
        options.binding = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--config":
        options.config = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--wrangler":
        options.wrangler = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--development":
        options.development = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`unknown option: ${argument}`);
    }
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.binding)) {
    fail(`invalid Wrangler binding name: ${options.binding}`);
  }

  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(object, allowed, context) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail(`${context} has unknown field ${JSON.stringify(key)}`);
    }
  }
}

function validateHost(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    fail(`${context} must not contain surrounding whitespace`);
  }
  if (value !== value.toLowerCase()) {
    fail(`${context} must be lowercase: ${value}`);
  }
  if (value.endsWith(".") || value.length > 253) {
    fail(`${context} is not a canonical hostname: ${value}`);
  }

  const labels = value.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) {
    fail(`${context} is not a valid hostname: ${value}`);
  }
  return value;
}

function validateOrigin(value, context, development) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty URL string`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${context} is not a valid URL: ${value}`);
  }

  const allowedProtocols = development ? new Set(["http:", "https:"]) : new Set(["https:"]);
  if (!allowedProtocols.has(url.protocol)) {
    const requirement = development ? "http:// or https://" : "https:// in production";
    fail(`${context} must use ${requirement}: ${value}`);
  }
  if (url.username || url.password) {
    fail(`${context} must not contain credentials; keep secrets out of inventory`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    fail(`${context} must be an origin only (no path, query, or fragment): ${value}`);
  }

  return url.origin;
}

function validatePrefix(value, canonicalHost, context) {
  const prefix = value === undefined ? `sites/${canonicalHost}` : value;
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > 512) {
    fail(`${context} must be a non-empty string of at most 512 characters`);
  }
  if (prefix.startsWith("/") || prefix.endsWith("/")) {
    fail(`${context} must not start or end with /: ${prefix}`);
  }

  const segments = prefix.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !PREFIX_SEGMENT.test(segment),
    )
  ) {
    fail(`${context} contains an unsafe path segment: ${prefix}`);
  }
  return prefix;
}

function validateMode(value, context) {
  if (value === undefined) return undefined;
  if (!MODES.has(value)) fail(`${context} must be one of ${[...MODES].join(", ")}`);
  return value;
}

function validateAi(value, context) {
  if (value === undefined) return undefined;
  if (!AI_POLICIES.has(value)) fail(`${context} must be one of ${[...AI_POLICIES].join(", ")}`);
  return value;
}

function validateList(value, context, isValid, description) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    fail(`${context} must be an array of at most ${MAX_LIST_ENTRIES} entries`);
  }
  value.forEach((item, index) => {
    if (!isValid(item)) fail(`${context}[${index}] must be ${description}`);
  });
  return [...value];
}

function isPathPrefix(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateKeyHash(value, context) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${context} must be the lowercase hex SHA-256 of the site key (see fleet/site-key.mjs)`);
  }
  return value;
}

function validateSecrets(raw, canonicalHosts) {
  if (raw === undefined || raw === null) return new Map();
  if (!isPlainObject(raw)) fail("secrets root must be a JSON object keyed by canonical hostname");
  const secrets = new Map();
  for (const [host, entry] of Object.entries(raw)) {
    if (!canonicalHosts.has(host)) fail(`secrets has an entry for ${host}, which is not a canonical site in the inventory`);
    if (!isPlainObject(entry)) fail(`secrets.${host} must be an object`);
    rejectUnknownKeys(entry, new Set(["edgeSecret"]), `secrets.${host}`);
    if (typeof entry.edgeSecret !== "string" || !/^[\x21-\x7e]{16,256}$/.test(entry.edgeSecret)) {
      fail(`secrets.${host}.edgeSecret must be 16 to 256 visible ASCII characters`);
    }
    secrets.set(host, entry.edgeSecret);
  }
  return secrets;
}

/** Copy only the routing fields an operator actually set, so defaults stay with the Worker. */
function routingFields(site) {
  const fields = {};
  for (const name of ["mode", "ai", "bypassPaths", "bypassCookies"]) {
    if (site[name] !== undefined) fields[name] = site[name];
  }
  return fields;
}

export function compileInventory(raw, { development = false, secrets: rawSecrets } = {}) {
  if (!isPlainObject(raw)) {
    fail("inventory root must be a JSON object");
  }
  rejectUnknownKeys(raw, new Set(["version", "sites"]), "inventory");
  if (raw.version !== 1) {
    fail("inventory.version must be 1");
  }
  if (!Array.isArray(raw.sites) || raw.sites.length === 0) {
    fail("inventory.sites must be a non-empty array");
  }

  const sites = raw.sites.map((site, index) => {
    const context = `sites[${index}]`;
    if (!isPlainObject(site)) {
      fail(`${context} must be an object`);
    }
    rejectUnknownKeys(
      site,
      new Set(["canonicalHost", "origin", "prefix", "aliases", "mode", "ai", "bypassPaths", "bypassCookies", "ingestKeySha256"]),
      context,
    );

    const canonicalHost = validateHost(site.canonicalHost, `${context}.canonicalHost`);
    const origin = validateOrigin(site.origin, `${context}.origin`, development);
    const prefix = validatePrefix(site.prefix, canonicalHost, `${context}.prefix`);
    const aliases = site.aliases === undefined ? [] : site.aliases;
    if (!Array.isArray(aliases)) {
      fail(`${context}.aliases must be an array`);
    }

    return {
      canonicalHost,
      origin,
      prefix,
      aliases: aliases.map((alias, aliasIndex) =>
        validateHost(alias, `${context}.aliases[${aliasIndex}]`),
      ),
      mode: validateMode(site.mode, `${context}.mode`),
      ai: validateAi(site.ai, `${context}.ai`),
      bypassPaths: validateList(site.bypassPaths, `${context}.bypassPaths`, isPathPrefix, 'a decoded path prefix starting with "/"'),
      bypassCookies: validateList(site.bypassCookies, `${context}.bypassCookies`, (item) => typeof item === "string" && COOKIE_PREFIX.test(item), "a cookie-name prefix"),
      ingestKeySha256: validateKeyHash(site.ingestKeySha256, `${context}.ingestKeySha256`),
    };
  });

  const keyOwners = new Map();
  const prefixes = new Map();
  for (const site of sites) {
    if (keyOwners.has(site.canonicalHost)) {
      fail(
        `hostname ${site.canonicalHost} is used by both ${keyOwners.get(site.canonicalHost)} and a canonical site`,
      );
    }
    keyOwners.set(site.canonicalHost, `canonical site ${site.canonicalHost}`);

    if (prefixes.has(site.prefix)) {
      fail(
        `prefix ${site.prefix} is shared by ${prefixes.get(site.prefix)} and ${site.canonicalHost}`,
      );
    }
    prefixes.set(site.prefix, site.canonicalHost);
  }

  // A site's key may write anything under its prefix, so one prefix inside
  // another would let the outer site overwrite the inner site's snapshots.
  for (const [prefix, host] of prefixes) {
    const segments = prefix.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = segments.slice(0, length).join("/");
      if (prefixes.has(ancestor)) {
        fail(`prefix ${prefix} of ${host} lies inside prefix ${ancestor} of ${prefixes.get(ancestor)}; prefixes must not nest`);
      }
    }
  }

  for (const site of sites) {
    for (const alias of site.aliases) {
      if (keyOwners.has(alias)) {
        fail(`hostname ${alias} is used by both ${keyOwners.get(alias)} and alias of ${site.canonicalHost}`);
      }
      keyOwners.set(alias, `alias of ${site.canonicalHost}`);
    }
  }

  const secrets = validateSecrets(rawSecrets, new Set(sites.map((site) => site.canonicalHost)));
  const records = [];
  for (const site of sites) {
    const edgeSecret = secrets.get(site.canonicalHost);
    const shared = { ...routingFields(site), ...(edgeSecret ? { edgeSecret } : {}) };
    records.push({
      key: site.canonicalHost,
      value: {
        origin: site.origin,
        prefix: site.prefix,
        force_fallback: false,
        ...shared,
        // Only the canonical record accepts snapshot uploads; aliases share its snapshot.
        ...(site.ingestKeySha256 ? { ingestKeySha256: site.ingestKeySha256 } : {}),
      },
    });
    for (const alias of site.aliases) {
      records.push({
        key: alias,
        value: {
          canonicalHost: site.canonicalHost,
          origin: site.origin,
          prefix: site.prefix,
          force_fallback: false,
          ...shared,
        },
      });
    }
  }

  const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  records.sort((left, right) => compareText(left.key, right.key));
  sites.sort((left, right) => compareText(left.canonicalHost, right.canonicalHost));
  return { sites, records };
}

function gcd(left, right) {
  let a = left;
  let b = right;
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function scheduleSites(sites) {
  const slotLoads = Array.from({ length: 360 }, () => 0);
  return sites.map((site) => {
    const digest = createHash("sha256").update(site.canonicalHost).digest();
    const base = digest.readUInt32BE(0) % slotLoads.length;
    let step = (digest.readUInt32BE(4) % (slotLoads.length - 1)) + 1;
    while (gcd(step, slotLoads.length) !== 1) {
      step = (step % (slotLoads.length - 1)) + 1;
    }

    const minimumLoad = Math.min(...slotLoads);
    let slot = base;
    for (let probe = 0; probe < slotLoads.length; probe += 1) {
      const candidate = (base + probe * step) % slotLoads.length;
      if (slotLoads[candidate] === minimumLoad) {
        slot = candidate;
        break;
      }
    }
    slotLoads[slot] += 1;

    const minute = slot % 60;
    const firstHour = Math.floor(slot / 60);
    return {
      canonicalHost: site.canonicalHost,
      expression: `${minute} ${firstHour}-23/6 * * *`,
      command: "wp lifeboat build --quiet",
    };
  });
}

function readInventory(path, label = "inventory") {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read ${label} ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`invalid JSON in ${path}: ${error.message}`);
  }
}

/** Records as printed by a dry run: secrets never reach terminals or CI logs. */
export function redactRecords(records) {
  return records.map(({ key, value }) => ({
    key,
    value: value.edgeSecret === undefined ? value : { ...value, edgeSecret: REDACTED },
  }));
}

function wranglerPayload(records) {
  return records.map(({ key, value }) => ({ key, value: JSON.stringify(value) }));
}

function applyRecords(records, options) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lifeboat-sites-"));
  const payloadPath = join(temporaryDirectory, "kv-bulk-put.json");

  try {
    writeFileSync(payloadPath, `${JSON.stringify(wranglerPayload(records), null, 2)}\n`, {
      mode: 0o600,
    });
    const arguments_ = [
      "kv",
      "bulk",
      "put",
      payloadPath,
      "--binding",
      options.binding,
      "--remote",
    ];
    if (options.config) {
      arguments_.push("--config", resolve(options.config));
    }

    const result = spawnSync(options.wrangler, arguments_, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    if (result.error) {
      fail(`could not run Wrangler (${options.wrangler}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`Wrangler exited with status ${result.status ?? "unknown"}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const inventoryPath = resolve(options.inventory);
  const { sites, records } = compileInventory(readInventory(inventoryPath), {
    development: options.development,
    secrets: options.secrets ? readInventory(resolve(options.secrets), "secrets file") : undefined,
  });
  const aliasCount = records.length - sites.length;
  const plan = {
    mode: options.development ? "development" : "production",
    binding: options.binding,
    canonicalSites: sites.length,
    aliases: aliasCount,
    records: redactRecords(records),
    cron: scheduleSites(sites),
  };

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (!options.apply) {
    process.stderr.write(
      `Dry run: validated ${sites.length} canonical site(s) and ${aliasCount} alias(es); no Cloudflare changes made.\n`,
    );
    return;
  }

  process.stderr.write(
    `Applying ${records.length} record(s) to remote Workers KV binding ${options.binding}...\n`,
  );
  applyRecords(records, options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
