const DEFAULT_ORIGIN_TIMEOUT_MS = 7_000;
const BREAKER_TTL_MS = 30_000;
const MAX_POINTER_BYTES = 64 * 1024;

// Cloudflare may reuse an isolate for many requests. This intentionally remains
// local to the isolate: it is a fast pressure-release valve, not durable state.
const breakerUntil = new Map();

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
 * - DEFAULT_HOST / DEFAULT_ORIGIN: single-site demo configuration.
 * - CRAWL_SECRET (optional): exact secret required for crawler pass-through.
 */
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env = {}) {
  let url;
  let decodedPath;
  try {
    url = new URL(request.url);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return badRequest(request.method);
  }

  const incomingHost = url.hostname.toLowerCase();
  let site;
  try {
    site = await resolveSite(incomingHost, env);
  } catch {
    return readOnlyResponse(request.method);
  }

  // An unconfigured hostname must never inherit another site's origin or R2
  // prefix. This is the central isolation rule for multi-site deployments.
  if (!site) {
    return readOnlyResponse(request.method);
  }

  if (site.redirectTo) {
    const location = redirectLocation(site.redirectTo, url);
    return location ? new Response(null, { status: 301, headers: { Location: location } }) : readOnlyResponse(request.method);
  }

  if (!site.origin) {
    return readOnlyResponse(request.method);
  }

  const bypass = isBypassRequest(request, decodedPath, env.CRAWL_SECRET);
  const breakerKey = `${site.canonicalHost}\u0000${site.origin}`;
  const skipOrigin = site.forceFallback || isBreakerOpen(breakerKey);

  if (!skipOrigin) {
    try {
      const originResponse = await fetchOrigin(request, site.origin, originTimeout(env));
      if (originResponse.status < 500) {
        breakerUntil.delete(breakerKey);
        return originResponse;
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
  if (bypass) {
    return readOnlyResponse(request.method);
  }

  return serveSnapshot(request, env, site, decodedPath);
}

async function resolveSite(incomingHost, env) {
  if (env.SITES && typeof env.SITES.get === "function") {
    const value = await env.SITES.get(incomingHost, { type: "json" });
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
  const bootstrapHost = !configuredHost && incomingHost.endsWith(".workers.dev") ? incomingHost : null;
  const canonicalHost = configuredHost || bootstrapHost;
  if (!canonicalHost || canonicalHost !== incomingHost) return null;

  const origin = configuredOrigin(env.DEFAULT_ORIGIN);
  if (!origin) return null;

  return {
    origin,
    canonicalHost,
    prefix: `sites/${canonicalHost}`,
    forceFallback: false,
    redirectTo: null,
  };
}

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

  return {
    origin,
    canonicalHost,
    prefix,
    forceFallback: record.force_fallback === true,
    redirectTo,
  };
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

export function isBypassRequest(request, decodedPath, crawlSecret) {
  if (request.method !== "GET" && request.method !== "HEAD") return true;
  if (
    decodedPath === "/wp-admin" || decodedPath.startsWith("/wp-admin/") ||
    decodedPath === "/wp-login.php" ||
    decodedPath === "/wp-json" || decodedPath.startsWith("/wp-json/") ||
    decodedPath === "/wp-cron.php"
  ) return true;

  const cookie = request.headers.get("Cookie") || "";
  if (/(?:^|;\s*)wordpress_logged_in_[^=;\s]*=/.test(cookie)) return true;

  const suppliedSecret = request.headers.get("X-Lifeboat-Crawl");
  return typeof crawlSecret === "string" && crawlSecret !== "" && suppliedSecret === crawlSecret;
}

async function fetchOrigin(request, origin, timeoutMs) {
  const sourceUrl = new URL(request.url);
  const forwardedHost = sourceUrl.host;
  const forwardedProto = sourceUrl.protocol.slice(0, -1);
  const originUrl = new URL(origin);
  sourceUrl.protocol = originUrl.protocol;
  sourceUrl.host = originUrl.host;
  sourceUrl.hash = "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Origin timeout"), timeoutMs);
  try {
    const originRequest = new Request(sourceUrl.toString(), request);
    originRequest.headers.set("X-Forwarded-Host", forwardedHost);
    originRequest.headers.set("X-Forwarded-Proto", forwardedProto);
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

async function serveSnapshot(request, env, site, decodedPath) {
  if (!env.SNAPSHOTS || typeof env.SNAPSHOTS.get !== "function") {
    return readOnlyResponse(request.method);
  }

  try {
    const current = await readCurrent(env.SNAPSHOTS, site, site.canonicalHost);
    if (!current) return readOnlyResponse(request.method);

    const key = pathToKey(decodedPath);
    let object = await env.SNAPSHOTS.get(`${current.prefix}/${key}`);
    let status = 200;

    if (!object) {
      object = await env.SNAPSHOTS.get(`${current.prefix}/__404.html`);
      status = 404;
    }
    if (!object) return readOnlyResponse(request.method);

    const redirect = object.customMetadata?.["lifeboat-redirect"];
    if (status === 200 && typeof redirect === "string" && redirect !== "") {
      const headers = objectHeaders(object);
      headers.delete("Content-Length");
      headers.set("Location", redirect);
      headers.set("X-Lifeboat", current.snapshotId);
      return new Response(null, { status: 301, headers });
    }

    return snapshotObjectResponse(request.method, object, status, current.snapshotId);
  } catch {
    return readOnlyResponse(request.method);
  }
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

  return { snapshotId: pointer.snapshot_id, prefix: pointer.prefix };
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

function snapshotObjectResponse(method, object, status, snapshotId) {
  const headers = objectHeaders(object);
  headers.set("X-Lifeboat", snapshotId);
  const contentType = headers.get("Content-Type") || "";
  if (method === "GET" && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType) && typeof globalThis.HTMLRewriter === "function") {
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
  return new Response(method === "HEAD" ? null : object.body, { status, headers });
}

function badRequest(method) {
  const body = method === "HEAD" ? null : "Malformed request path";
  return new Response(body, {
    status: 400,
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
