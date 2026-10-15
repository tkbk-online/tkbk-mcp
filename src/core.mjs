// Shared pieces of the TKBK MCP servers: an HTTP client with timeouts, rate-limit retries and readable errors,
// pagination, a compact output for agents (tokens are money), and the server builder with a confirmation gate for writes.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export { z };

/** Package version: every MCP server reports it to the client. */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const DEFAULT_MAX_ITEMS = 50;
/** Upper bound of pages one tool call follows (each page is one API request). */
export const MAX_PAGES = 20;
export const DAY_MS = 86_400_000;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
/** A longer wait asked by the service is not slept through: the agent gets "retry in N s" at once. */
const MAX_RETRY_WAIT_MS = 20_000;
/** Total time one request may spend waiting between attempts. */
const RETRY_BUDGET_MS = 60_000;
const ERROR_TEXT_MAX = 300;
const MS_PER_SECOND = 1_000;
const ISO_DATE_LENGTH = 10;
/** 429 — everyone; 420 "Method Failure" — Yandex Market's rate limit. The request was not processed: safe to repeat. */
const RATE_LIMIT_STATUSES = new Set([420, 429]);
/** Repeated only for idempotent requests (reads): a write may have gone through. */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const NETWORK_ERROR = 0;
const RETRY_HEADERS = ['retry-after', 'x-ratelimit-retry', 'x-ratelimit-reset'];

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Pause before the next attempt: Retry-After (seconds or HTTP date), Wildberries' X-Ratelimit-Retry / X-Ratelimit-Reset
 * (seconds), else exponential backoff 1 s, 2 s, 4 s …
 * @param {Headers|null} headers  answer headers (null — the request did not reach the service)
 * @param {number} attempt  0 for the first retry
 * @param {number} [now]
 * @returns {number} milliseconds
 */
export function retryDelayMs(headers, attempt, now = Date.now()) {
  for (const name of RETRY_HEADERS) {
    const raw = headers?.get(name)?.trim();
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * MS_PER_SECOND);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

/** Yandex Direct `{error: {error_string, error_detail}}` and Webmaster `{error_code, error_message}` answers. */
function yandexError(data) {
  if (data.error && typeof data.error === 'object') return [data.error.error_string, data.error.error_detail].filter(Boolean).join(': ');
  return data.error_message ? [data.error_code, data.error_message].filter(Boolean).join(': ') : '';
}

function errorText(data, text) {
  if (typeof data === 'object' && data) {
    return data.message || data.detail || data.title || data.error?.message || yandexError(data) || data.errors?.[0]?.message || data.error_description || JSON.stringify(data).slice(0, ERROR_TEXT_MAX);
  }
  return String(text).slice(0, ERROR_TEXT_MAX);
}

/** Objects go out as JSON; a string goes as it is (a form: send your own lowercase `content-type` header with it). */
const encodeBody = (body) => (body === undefined || typeof body === 'string' ? body : JSON.stringify(body));

/** One attempt: {ok: true, data, status, headers} or {ok: false, status (0 — not reachable), headers, message}. */
async function attemptOnce(url, { method, headers, body, timeoutMs }) {
  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: encodeBody(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: NETWORK_ERROR, headers: null, message: `service is not reachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})` };
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.ok) return { ok: true, data, status: res.status, headers: res.headers };
  return { ok: false, status: res.status, headers: res.headers, message: `HTTP ${res.status}: ${errorText(data, text)}` };
}

/**
 * JSON request with a timeout and retries: 429/420 always (after Retry-After), network errors and 5xx only when
 * idempotent (GET by default; reads sent as POST pass idempotent: true). The service's error text is kept short and
 * never contains our credentials.
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: unknown, timeoutMs?: number, idempotent?: boolean, full?: boolean, sleep?: (ms: number) => Promise<unknown>}} [options]
 *   body — an object (sent as JSON) or a string (sent as it is); full — resolve {data, status, headers} instead of the
 *   data alone (for services that answer 200, 201 and 202 differently)
 * @returns {Promise<any>} parsed JSON (text when the answer is not JSON, null when empty)
 * @throws {ApiError}
 */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS, idempotent = method === 'GET', full = false, sleep = delay } = {}) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const r = await attemptOnce(url, { method, headers, body, timeoutMs });
    if (r.ok) return full ? { data: r.data, status: r.status, headers: r.headers } : r.data;
    const limited = RATE_LIMIT_STATUSES.has(r.status);
    const retryable = limited || (idempotent && (r.status === NETWORK_ERROR || TRANSIENT_STATUSES.has(r.status)));
    const wait = retryDelayMs(r.headers, attempt);
    const tooLong = wait > MAX_RETRY_WAIT_MS || Date.now() - started + wait > RETRY_BUDGET_MS;
    if (!retryable || tooLong || attempt + 1 >= MAX_ATTEMPTS) {
      const hint = limited ? ` (rate limit: retry in ${Math.max(1, Math.ceil(wait / MS_PER_SECOND))} s)` : '';
      throw new ApiError(r.status, r.message + hint);
    }
    await sleep(wait);
  }
}

/**
 * Follow a paginated list until `limit` items or the last page. Each page asks for at most the items still missing,
 * so the returned cursor never skips anything.
 * @param {(cursor: string|undefined, size: number) => Promise<{items?: unknown[], next?: string|number|null}>} fetchPage
 *   one page from cursor (undefined — the first page) with at most `size` items; next — cursor of the following page
 * @param {{limit: number, pageSize: number, cursor?: string|number, maxPages?: number}} options
 * @returns {Promise<{items: unknown[], next: string|number|null}>} next — pass it back as cursor to continue; null — done
 */
export async function collectPages(fetchPage, { limit, pageSize, cursor, maxPages = MAX_PAGES }) {
  const items = [];
  let next = cursor || null;
  for (let page = 0; page < maxPages && items.length < limit; page++) {
    const r = await fetchPage(next ?? undefined, Math.min(pageSize, limit - items.length));
    const got = r?.items ?? [];
    items.push(...got);
    next = r?.next || null;
    if (!next || !got.length) break;
  }
  return { items, next };
}

/** ISO date-time `days` ago. */
export const isoDaysAgo = (days, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();

/** `YYYY-MM-DD` (UTC) of a timestamp, today by default. */
export const isoDate = (ms = Date.now()) => new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH);

/** `?a=1&b=2` from the defined, non-empty values (an array repeats its key); '' when there is nothing to send. */
export function queryString(params = {}) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined && v !== null && v !== '') q.append(key, String(v));
    }
  }
  return q.size ? `?${q}` : '';
}

const perEnv = new WeakMap(); // env object → Map(key → {promise, value, done})

/**
 * Memoize an async lookup (an OAuth token, an account id) for the life of one env object. Stdio: the whole process (its
 * env is process.env). Hosted: one request (every request gets its own env), so nothing outlives the credentials it
 * was made with. Concurrent callers share one load; a failed load is not cached.
 * @template T
 * @param {object} env
 * @param {string} key
 * @param {() => Promise<T>} load
 * @param {(value: T) => boolean} [isFresh]  a finished value that is not fresh any more is loaded again
 * @returns {Promise<T>}
 */
export function cachedPerEnv(env, key, load, isFresh = () => true) {
  let slots = perEnv.get(env);
  if (!slots) {
    slots = new Map();
    perEnv.set(env, slots);
  }
  const hit = slots.get(key);
  if (hit && (!hit.done || isFresh(hit.value))) return hit.promise;
  const entry = { done: false, value: undefined, promise: undefined };
  entry.promise = Promise.resolve().then(load).then(
    (value) => {
      entry.value = value;
      entry.done = true;
      return value;
    },
    (e) => {
      if (slots.get(key) === entry) slots.delete(key);
      throw e;
    },
  );
  slots.set(key, entry);
  return entry.promise;
}

/** Drop a memoized value (a token the service has rejected). */
export function forgetPerEnv(env, key) {
  perEnv.get(env)?.delete(key);
}

/** Compact JSON for the model: drop empty values, cap long arrays. */
export function compact(value, maxItems = DEFAULT_MAX_ITEMS) {
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => compact(v, maxItems));
    return value.length > maxItems ? [...items, `… and ${value.length - maxItems} more`] : items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compact(v, maxItems);
    }
    return out;
  }
  return value;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const failure = (t) => ({ ...text(t), isError: true });
const envHint = (missing) => `Not configured: set ${missing.join(', ')} in the MCP server environment.`;
const NOTHING_FOUND = 'Nothing found.';

/** Tool output as text: compact JSON; a read whose result compacts to {} (only empty lists) says so plainly. */
function render(t, out) {
  if (typeof out === 'string') return out;
  const value = compact(out, t.maxItems ?? DEFAULT_MAX_ITEMS);
  const empty = value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length;
  return empty && !t.write ? NOTHING_FOUND : JSON.stringify(value);
}

/** MCP handler of one tool: configuration and confirmation gates, the call, compact output, onCall report. */
function toolHandler(t, env, notConfigured, onCall) {
  return async (args) => {
    if (notConfigured) return failure(notConfigured);
    if (t.write && args.confirm !== true) {
      return failure('This action changes data. Show the user exactly what will change and call again with confirm=true after they agree.');
    }
    const t0 = Date.now();
    try {
      const out = await t.run(args, env);
      onCall?.({ tool: t.name, ok: true, ms: Date.now() - t0 });
      return text(render(t, out));
    } catch (e) {
      onCall?.({ tool: t.name, ok: false, ms: Date.now() - t0, ...(e instanceof ApiError ? { status: e.status } : {}) });
      return failure(e instanceof ApiError ? e.message : `Error: ${e.message}`);
    }
  };
}

/**
 * Build an MCP server from a service definition:
 *   { name, title, env: ['WB_TOKEN'], optionalEnv?: [...], tools: [{ name, description, input: {zod shape}, write?: true, maxItems?, run(args, env) }] }
 * Write tools (change data in the customer's system) require `confirm: true` — the agent has to ask the user first.
 * @param {object} service
 * @param {Record<string, string|undefined>} [env]  credentials of the service (stdio: process.env; hosted: request headers)
 * @param {{configHint?: (missing: string[]) => string, onCall?: (call: {tool: string, ok: boolean, ms: number, status?: number}) => void}} [options]
 *   configHint — message for a call without credentials; onCall — told about every finished tool call (no arguments)
 */
export function buildServer(service, env = process.env, { configHint = envHint, onCall } = {}) {
  const server = new McpServer({ name: `tkbk-${service.name}`, version: VERSION });
  const missing = service.env.filter((k) => !env[k]);
  const notConfigured = missing.length ? configHint(missing) : null;
  for (const t of service.tools) {
    const input = t.write ? { ...t.input, confirm: z.boolean().optional().describe('Must be true: the user explicitly confirmed this change') } : t.input;
    server.registerTool(
      t.name,
      {
        title: t.title || t.name,
        description: t.description + (t.write ? ' Changes data: call only after the user confirmed, with confirm=true.' : ''),
        inputSchema: input,
        annotations: { readOnlyHint: !t.write, destructiveHint: Boolean(t.write) },
      },
      toolHandler(t, env, notConfigured, onCall),
    );
  }
  return server;
}
