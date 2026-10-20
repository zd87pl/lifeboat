// In-memory stand-ins for the R2 and KV bindings, covering the API surface the
// Worker uses (get/head/put/delete/list and KV get with type "json").

export function r2Object(body, {
  contentType = "text/html; charset=UTF-8",
  cacheControl,
  customMetadata = {},
  etag,
} = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const httpMetadata = { contentType };
  if (cacheControl) httpMetadata.cacheControl = cacheControl;
  return storedObject(bytes, httpMetadata, customMetadata, etag);
}

function storedObject(bytes, httpMetadata, customMetadata, etag) {
  const tag = etag ?? `etag-${bytes.byteLength}-${Array.from(bytes.slice(0, 8)).join("")}`;
  return {
    bytes,
    size: bytes.byteLength,
    etag: tag,
    httpEtag: `"${tag}"`,
    httpMetadata: { ...httpMetadata },
    customMetadata: { ...customMetadata },
  };
}

function withBody(stored) {
  return {
    ...metadataView(stored),
    body: stored.bytes,
    async text() { return new TextDecoder().decode(stored.bytes); },
    async arrayBuffer() { return stored.bytes.slice().buffer; },
  };
}

function metadataView(stored) {
  return {
    size: stored.size,
    etag: stored.etag,
    httpEtag: stored.httpEtag,
    httpMetadata: { ...stored.httpMetadata },
    customMetadata: { ...stored.customMetadata },
    writeHttpMetadata(headers) {
      if (stored.httpMetadata.contentType) headers.set("Content-Type", stored.httpMetadata.contentType);
      if (stored.httpMetadata.cacheControl) headers.set("Cache-Control", stored.httpMetadata.cacheControl);
    },
  };
}

async function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export class FakeR2 {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.calls = [];
    this.ops = [];
  }

  async get(key) {
    this.calls.push(key);
    this.ops.push(["get", key]);
    const stored = this.entries.get(key);
    return stored ? withBody(stored) : null;
  }

  async head(key) {
    this.ops.push(["head", key]);
    const stored = this.entries.get(key);
    return stored ? metadataView(stored) : null;
  }

  async put(key, value, options = {}) {
    this.ops.push(["put", key]);
    const bytes = await toBytes(value);
    this.entries.set(key, storedObject(bytes, options.httpMetadata || {}, options.customMetadata || {}));
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.ops.push(["delete", key]);
      this.entries.delete(key);
    }
  }

  async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
    this.ops.push(["list", prefix]);
    const objects = [];
    const prefixes = new Set();
    for (const key of [...this.entries.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
      } else {
        objects.push({ key, size: this.entries.get(key).size, etag: this.entries.get(key).etag });
      }
    }
    const start = cursor ? Number(cursor) : 0;
    const page = objects.slice(start, start + limit);
    const truncated = start + limit < objects.length;
    return {
      objects: page,
      delimitedPrefixes: [...prefixes],
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }

  text(key) {
    const stored = this.entries.get(key);
    return stored ? new TextDecoder().decode(stored.bytes) : null;
  }
}

export function kv(records = {}) {
  return {
    lookups: [],
    async get(key) {
      this.lookups.push(key);
      return Object.hasOwn(records, key) ? records[key] : null;
    },
  };
}

export function pointer(host = "site.example", id = "20260901-140000", prefix = `sites/${host}/snapshots/${id}`, updatedAt) {
  const value = { snapshot_id: id, prefix, host };
  if (updatedAt) value.updated_at = updatedAt;
  return r2Object(JSON.stringify(value), { contentType: "application/json" });
}

/** A Cache API stand-in that records what was stored. */
export class FakeCache {
  constructor() {
    this.entries = new Map();
    this.puts = [];
  }

  async match(request) {
    const stored = this.entries.get(new Request(request).url);
    return stored ? new Response(stored.body, { status: stored.status, headers: stored.headers }) : undefined;
  }

  async put(request, response) {
    const url = new Request(request).url;
    this.puts.push(url);
    this.entries.set(url, { body: await response.arrayBuffer(), status: response.status, headers: new Headers(response.headers) });
  }
}

export function waitUntilCollector() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) { pending.push(promise); },
    async settle() { await Promise.all(pending.splice(0)); },
  };
}
