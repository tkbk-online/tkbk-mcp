// Who may use the hosted MCP: a TKBK key (Authorization: Bearer cr_…) that the TKBK gateway accepts, and an MCP
// subscription for it. Keys are never stored: caches and the allow-list hold key ids (sha256 hex of the key).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { remember } from './limits.mjs';

export const KEY_CACHE_TTL_MS = 5 * 60_000;
export const INVALID_KEY_TTL_MS = 60_000;
/** A key the gateway accepted this recently stays valid while the gateway cannot answer. */
export const STALE_IF_ERROR_MS = 60 * 60_000;
const KEY_CHECK_TIMEOUT_MS = 5_000;
const MAX_CACHED_KEYS = 20_000;
const ALLOW_LIST_RELOAD_MS = 10_000;
const DEFAULT_RETRY_AFTER_SEC = 60;
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const INVALID_KEY_STATUSES = new Set([401, 403]);
const KEY_FORMAT = /^cr_[A-Za-z0-9_-]{16,256}$/;
const KEY_ID_FORMAT = /^[0-9a-f]{64}$/;
const OPEN = '*';

/** Key id: sha256 hex of the key — what the allow-list, caches and logs use instead of the key. */
export const keyIdOf = (key) => createHash('sha256').update(key, 'utf8').digest('hex');

/** TKBK client key format: cr_ + letters, digits, _ or -. */
export const isKeyFormat = (key) => KEY_FORMAT.test(key);

/** The token of `Authorization: Bearer <token>`; null when there is none. */
export function bearerKey(headers) {
  return /^Bearer\s+(\S+)$/i.exec(String(headers.authorization ?? '').trim())?.[1] ?? null;
}

/**
 * Ask the gateway: GET checkUrl with x-api-key → 200 valid, 401/403 invalid, 429 limited (the client address is
 * blocked by the gateway's invalid-key limit), anything else or no answer — unavailable.
 */
async function askGateway(fetchImpl, checkUrl, key, { clientIp, timeoutMs, userAgent }) {
  let res;
  try {
    res = await fetchImpl(checkUrl, {
      headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': userAgent, ...(clientIp ? { 'x-forwarded-for': clientIp } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'unavailable' };
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === HTTP_OK) return { status: 'valid' };
  if (INVALID_KEY_STATUSES.has(res.status)) return { status: 'invalid' };
  if (res.status === HTTP_TOO_MANY_REQUESTS) return { status: 'limited', retryAfter: Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_SEC };
  return { status: 'unavailable' };
}

/**
 * Key check against the TKBK gateway with a cache: valid answers live ttlMs (5 min), invalid ones invalidTtlMs (1 min);
 * a key valid within staleMs (1 h) stays valid while the gateway is unavailable. Parallel checks of one key share one
 * request. The client address goes to the gateway in X-Forwarded-For (it trusts it from a private address only).
 * @param {{checkUrl: string, fetchImpl?: typeof fetch, now?: () => number, ttlMs?: number, invalidTtlMs?: number,
 *   staleMs?: number, timeoutMs?: number, maxKeys?: number, userAgent?: string}} options
 * @returns {{check: (key: string, ctx?: {clientIp?: string}) => Promise<{status: 'valid'|'invalid'|'limited'|'unavailable', retryAfter?: number, cached?: boolean, stale?: boolean}>, size: () => number}}
 */
export function createKeyValidator({
  checkUrl, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = KEY_CACHE_TTL_MS, invalidTtlMs = INVALID_KEY_TTL_MS,
  staleMs = STALE_IF_ERROR_MS, timeoutMs = KEY_CHECK_TIMEOUT_MS, maxKeys = MAX_CACHED_KEYS, userAgent = 'tkbk-mcp',
}) {
  if (!checkUrl) throw new Error('createKeyValidator: checkUrl is required');
  const cache = new Map(); // key id -> {valid: boolean, at: number}
  const inflight = new Map(); // key id -> Promise of the gateway answer
  async function check(key, { clientIp } = {}) {
    const id = keyIdOf(key);
    const hit = cache.get(id);
    if (hit && now() - hit.at < (hit.valid ? ttlMs : invalidTtlMs)) return { status: hit.valid ? 'valid' : 'invalid', cached: true };
    let pending = inflight.get(id);
    if (!pending) {
      pending = askGateway(fetchImpl, checkUrl, key, { clientIp, timeoutMs, userAgent }).finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    const r = await pending;
    if (r.status === 'valid' || r.status === 'invalid') {
      remember(cache, id, { valid: r.status === 'valid', at: now() }, maxKeys);
      return r;
    }
    if (hit?.valid && now() - hit.at < staleMs) return { status: 'valid', stale: true };
    return r;
  }
  return { check, size: () => cache.size };
}

/**
 * Key ids in text: sha256 hex (any case) or "*" — every valid key. Separators: commas, semicolons, spaces, new lines;
 * "#" starts a comment.
 * @returns {{ids: Set<string>, skipped: number}} skipped — tokens that are neither
 */
export function parseKeyIds(text) {
  const ids = new Set();
  let skipped = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const token of line.replace(/#.*/, '').split(/[\s,;]+/)) {
      if (!token) continue;
      const t = token.toLowerCase();
      if (t === OPEN || KEY_ID_FORMAT.test(t)) ids.add(t);
      else skipped += 1;
    }
  }
  return { ids, skipped };
}

/**
 * Default subscription hook: an allow-list of key ids from MCP_ALLOWED_KEYS (inline) and MCP_ALLOWED_KEYS_FILE (one id
 * per line, re-read within reloadMs after it changes — the bot or billing can rewrite it). "*" opens the server to
 * every valid key. A missing file means nobody from the file; a file that cannot be read keeps the last good list.
 * Billing replaces it with its own isSubscribed(keyId).
 * @param {{ids?: string, file?: string, reloadMs?: number, now?: () => number, fs?: {readFileSync: Function, statSync: Function}, log?: (entry: object) => void}} [options]
 */
export function createAllowList({ ids = '', file = '', reloadMs = ALLOW_LIST_RELOAD_MS, now = Date.now, fs = { readFileSync, statSync }, log = () => {} } = {}) {
  const inline = parseKeyIds(ids).ids;
  let fromFile = new Set();
  let stamp = null;
  let checkedAt = -Infinity;
  function reload() {
    if (!file || now() - checkedAt < reloadMs) return;
    checkedAt = now();
    try {
      const st = fs.statSync(file);
      const next = `${st.ino}:${st.mtimeMs}:${st.size}`;
      if (next === stamp) return;
      const parsed = parseKeyIds(fs.readFileSync(file, 'utf8'));
      fromFile = parsed.ids;
      stamp = next;
      log({ kind: 'allow-list', ids: parsed.ids.size, skipped: parsed.skipped });
    } catch (e) {
      if (e.code === 'ENOENT') fromFile = new Set();
      if (stamp !== e.code) log({ kind: 'allow-list', error: e.code || e.message });
      stamp = e.code;
    }
  }
  const has = (id) => inline.has(OPEN) || inline.has(id) || fromFile.has(OPEN) || fromFile.has(id);
  return {
    /** @param {string} keyId sha256 hex of the key */
    isSubscribed: async (keyId) => {
      reload();
      return has(keyId);
    },
    describe: () => {
      reload();
      return { open: has(OPEN), ids: new Set([...inline, ...fromFile].filter((id) => id !== OPEN)).size };
    },
  };
}
