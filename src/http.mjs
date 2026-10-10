// Hosted TKBK MCP (mcp.tkbk.online): Streamable HTTP, one stateless MCP server per request at POST /mcp/<service>.
// Access: a TKBK key (Authorization: Bearer cr_…) the gateway accepts + an MCP subscription (isSubscribed hook).
// Marketplace credentials come in x-* headers of every request and live only for that request: never logged or stored.
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, VERSION } from './core.mjs';
import { SERVICES } from './index.mjs';
import { bearerKey, createAllowList, createKeyValidator, isKeyFormat, keyIdOf } from './hosted/auth.mjs';
import { credentialsFor, missingHeadersHint } from './hosted/credentials.mjs';
import { bucketOf, clientIp, createRateLimiter, isInternalIp } from './hosted/limits.mjs';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '0.0.0.0';
/** The gateway checks the key with the panel here (401 when unknown); its /v1/models with x-api-key answers 200 to any key. */
const DEFAULT_KEY_CHECK_URL = 'https://api.tkbk.online/openai/v1/models';
const DEFAULT_RATE_PER_MIN = 60;
const DEFAULT_AUTH_FAILS = 20; // invalid keys from one address …
const AUTH_FAIL_WINDOW_MIN = 10; // … per this many minutes
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const SHUTDOWN_GRACE_MS = 10_000;
const RETRY_LATER_SEC = 30;
const KEY_ID_LOG_CHARS = 12;
const JSONRPC_SERVER_ERROR = -32000;
const ROUTE = /^\/mcp\/([a-z0-9-]+)\/?$/;
/** Documented endpoints; the long names (wildberries, yandex-market, bitrix24, amocrm) work too. */
export const HOSTED_PATHS = ['wb', 'ozon', 'ym', 'b24', 'amo'];

const writeLog = (entry) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);

function send(res, status, body, headers = {}) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
const rpcError = (message) => ({ jsonrpc: '2.0', error: { code: JSONRPC_SERVER_ERROR, message }, id: null });
const deny = (status, message, headers = {}, log = {}) => ({ ok: false, status, message, headers, log });
const retryAfter = (seconds) => ({ 'retry-after': String(seconds) });
const bearerChallenge = (error) => ({ 'www-authenticate': `Bearer realm="tkbk-mcp", error="${error}"` });

/** Subscription and per-key rate limit of a key the gateway accepted. */
async function entitle(keyId, ctx) {
  let subscribed;
  try {
    subscribed = await ctx.isSubscribed(keyId);
  } catch (e) {
    return deny(503, 'Subscription check is temporarily unavailable: retry in a minute.', retryAfter(RETRY_LATER_SEC), { reason: 'billing-down', err: e?.message });
  }
  if (!subscribed) return deny(403, 'No active MCP subscription for this key (490 ₽/month): https://tkbk.online/mcp', {}, { reason: 'no-subscription' });
  const wait = ctx.rateLimit.take(keyId);
  if (wait) return deny(429, `Rate limit: ${ctx.ratePerMin} requests a minute per key, retry in ${wait} s.`, retryAfter(wait), { reason: 'rate-limit' });
  return { ok: true };
}

/**
 * Gate of one MCP request: a well-formed key, the address not blocked for invalid keys, the key accepted by the
 * gateway, an active subscription, the key within its rate limit. Only key ids leave this function.
 * @returns {Promise<{ok: true, keyId: string} | {ok: false, status: number, message: string, headers: object, log: object, keyId?: string}>}
 */
async function admit(req, ctx) {
  const ip = clientIp(req);
  const watched = ctx.authFails.enabled && Boolean(ip) && !isInternalIp(ip);
  const bucket = bucketOf(ip);
  const key = bearerKey(req.headers);
  if (!key) return deny(401, 'Missing TKBK key: add the header Authorization: Bearer cr_… (https://tkbk.online/account).', bearerChallenge('invalid_request'));
  const blocked = watched ? ctx.authFails.blockedFor(bucket) : 0;
  if (blocked) return deny(429, `Too many invalid keys from your address: retry in ${blocked} s.`, retryAfter(blocked), { ip, reason: 'auth-limit' });
  const check = isKeyFormat(key) ? await ctx.validator.check(key, { clientIp: ip }) : { status: 'invalid' };
  if (check.status === 'invalid') {
    if (watched) ctx.authFails.take(bucket);
    return deny(401, 'Invalid or disabled TKBK key (Authorization: Bearer cr_…).', bearerChallenge('invalid_token'), { ip, reason: 'bad-key' });
  }
  if (check.status === 'limited') {
    return deny(429, `Too many invalid keys from your address: retry in ${check.retryAfter} s.`, retryAfter(check.retryAfter), { ip, reason: 'gateway-limit' });
  }
  if (check.status !== 'valid') return deny(503, 'Key check is temporarily unavailable: retry in a minute.', retryAfter(RETRY_LATER_SEC), { reason: 'gateway-down' });
  const keyId = keyIdOf(key);
  return { ...(await entitle(keyId, ctx)), keyId };
}

/** One stateless MCP exchange: a fresh server with this request's credentials, JSON answers (no SSE). */
async function serveMcp(req, res, service, env, ctx) {
  const key = ctx.keyId.slice(0, KEY_ID_LOG_CHARS);
  const server = buildServer(service, env, {
    configHint: missingHeadersHint,
    onCall: (call) => ctx.log({ kind: 'tool', service: service.name, key, ...call }),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
  res.once('close', () => void server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function serviceOf(pathname) {
  const name = ROUTE.exec(pathname)?.[1];
  return name && Object.hasOwn(SERVICES, name) ? SERVICES[name] : null;
}

async function handle(req, res, ctx) {
  const t0 = Date.now();
  let pathname;
  try { ({ pathname } = new URL(req.url ?? '/', 'http://mcp.invalid')); } catch { return send(res, 400, rpcError('Bad request URL')); }
  if (pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
  const service = serviceOf(pathname);
  if (!service) return send(res, 404, rpcError(`Not found. MCP endpoints: ${HOSTED_PATHS.map((p) => `/mcp/${p}`).join(', ')}`));
  if (req.method !== 'POST') return send(res, 405, rpcError('Method not allowed: this MCP server is stateless, use POST.'), { allow: 'POST' });
  const gate = await admit(req, ctx);
  const done = (extra = {}) => ctx.log({
    kind: 'mcp', service: service.name, status: res.statusCode, ms: Date.now() - t0,
    ...(gate.keyId ? { key: gate.keyId.slice(0, KEY_ID_LOG_CHARS) } : {}), ...extra,
  });
  if (!gate.ok) {
    send(res, gate.status, rpcError(gate.message), gate.headers);
    return done(gate.log);
  }
  const creds = credentialsFor(service, req.headers, { b24Hosts: ctx.b24Hosts });
  if (creds.error) {
    send(res, 400, rpcError(creds.error));
    return done({ reason: 'bad-credentials' });
  }
  res.once('close', () => done());
  return serveMcp(req, res, service, creds.env, { ...ctx, keyId: gate.keyId });
}

/**
 * The hosted MCP HTTP server (call listen() yourself).
 * @param {{validator: {check: (key: string, ctx?: {clientIp?: string}) => Promise<{status: string, retryAfter?: number}>},
 *   isSubscribed: (keyId: string) => boolean|Promise<boolean>, ratePerMin?: number, authFailLimit?: number,
 *   b24Hosts?: Iterable<string>, log?: (entry: object) => void, now?: () => number}} options
 *   validator — key check (createKeyValidator); isSubscribed — the billing hook, gets the key id (sha256 hex of the key);
 *   ratePerMin — requests a minute per key (0 — off); authFailLimit — invalid keys per address per 10 min (0 — off);
 *   b24Hosts — on-premise Bitrix24 hosts allowed in x-b24-webhook
 * @returns {import('node:http').Server}
 */
export function createHttpServer({ validator, isSubscribed, ratePerMin = DEFAULT_RATE_PER_MIN, authFailLimit = DEFAULT_AUTH_FAILS, b24Hosts = [], log = writeLog, now = Date.now }) {
  if (!validator || typeof isSubscribed !== 'function') throw new Error('createHttpServer: validator and isSubscribed are required');
  const ctx = {
    validator,
    isSubscribed,
    log,
    ratePerMin,
    b24Hosts: new Set([...b24Hosts].map((h) => h.toLowerCase())),
    rateLimit: createRateLimiter({ perMinute: ratePerMin, now }),
    authFails: createRateLimiter({ perMinute: authFailLimit / AUTH_FAIL_WINDOW_MIN, burst: authFailLimit, now }),
  };
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      log({ kind: 'crash', path: String(req.url ?? '').split('?')[0], err: e?.message ?? String(e) });
      send(res, 500, rpcError('Internal error'));
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

const intOr = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Server options from the environment: PORT, HOST, TKBK_KEY_CHECK_URL, MCP_ALLOWED_KEYS, MCP_ALLOWED_KEYS_FILE,
 * MCP_RATE_LIMIT_PER_MIN, MCP_AUTH_FAIL_LIMIT, MCP_B24_HOSTS.
 */
export function configFromEnv(env = process.env, log = writeLog) {
  const keyCheckUrl = new URL(env.TKBK_KEY_CHECK_URL || DEFAULT_KEY_CHECK_URL).href;
  const allowList = createAllowList({ ids: env.MCP_ALLOWED_KEYS, file: env.MCP_ALLOWED_KEYS_FILE, log });
  return {
    port: intOr(env.PORT, DEFAULT_PORT),
    host: env.HOST || DEFAULT_HOST,
    keyCheckUrl,
    allowList,
    validator: createKeyValidator({ checkUrl: keyCheckUrl, userAgent: `tkbk-mcp/${VERSION}` }),
    isSubscribed: allowList.isSubscribed,
    ratePerMin: intOr(env.MCP_RATE_LIMIT_PER_MIN, DEFAULT_RATE_PER_MIN),
    authFailLimit: intOr(env.MCP_AUTH_FAIL_LIMIT, DEFAULT_AUTH_FAILS),
    b24Hosts: String(env.MCP_B24_HOSTS ?? '').split(/[\s,]+/).filter(Boolean),
    log,
  };
}

/** Listen on PORT (8787) and stop gracefully on SIGTERM / SIGINT. */
export function startHttpServer(env = process.env) {
  const config = configFromEnv(env);
  const server = createHttpServer(config);
  server.listen(config.port, config.host, () => {
    const check = new URL(config.keyCheckUrl);
    const subscriptions = config.allowList.describe();
    config.log({ kind: 'start', version: VERSION, port: server.address().port, keyCheck: `${check.origin}${check.pathname}`, subscriptions, ratePerMin: config.ratePerMin });
    if (!subscriptions.open && !subscriptions.ids) config.log({ kind: 'warn', msg: 'no subscriptions: set MCP_ALLOWED_KEYS or MCP_ALLOWED_KEYS_FILE, every key gets 403' });
  });
  const stop = (signal) => {
    config.log({ kind: 'stop', signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}
