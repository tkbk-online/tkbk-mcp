// Hosted server end to end over real HTTP: gates (key, subscription, limits), header credentials, a real MCP client.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.mjs';
import { createKeyValidator, keyIdOf } from '../src/hosted/auth.mjs';
import { installFetchMock, realFetch } from './helpers.mjs';

const api = installFetchMock(); // marketplace APIs; local HTTP goes through realFetch
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const key = (digit) => `cr_${String(digit).repeat(64)}`;
const [E2E, CACHED, NO_SUB, BAD, RATE, DOWN] = [1, 2, 3, 4, 5, 6].map(key);
const SUBSCRIBED = new Set([E2E, CACHED, RATE, DOWN].map(keyIdOf));
const WB_SECRET = 'wb-secret-token';

const gateway = { calls: [], down: false };
const gatewayFetch = async (url, init) => {
  gateway.calls.push({ key: init.headers['x-api-key'], ip: init.headers['x-forwarded-for'] });
  if (gateway.down) throw new TypeError('fetch failed');
  return new Response('{}', { status: init.headers['x-api-key'] === BAD ? 401 : 200 });
};
const checksOf = (k) => gateway.calls.filter((c) => c.key === k).length;

const logs = [];
const servers = [];
async function start(options = {}) {
  const server = createHttpServer({
    validator: createKeyValidator({ checkUrl: 'https://gw.test/openai/v1/models', fetchImpl: gatewayFetch }),
    isSubscribed: async (id) => SUBSCRIBED.has(id),
    log: (entry) => logs.push(entry),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); }))));

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
async function post(base, path, headers = {}, body = INIT) {
  const res = await realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}
const bearer = (k) => ({ authorization: `Bearer ${k}` });

async function mcpClient(base, path, headers) {
  const client = new Client({ name: 'claude-code-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { fetch: realFetch, requestInit: { headers } }));
  return client;
}

const base = await start();

test('healthz answers with the version; unknown paths 404; GET on an endpoint 405 without a key check', async () => {
  const health = await realFetch(`${base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true, version: pkg.version });
  assert.equal((await post(base, '/mcp/nope', bearer(E2E))).status, 404);
  assert.equal((await post(base, '/mcp/constructor', bearer(E2E))).status, 404);
  const before = gateway.calls.length;
  const get = await realFetch(`${base}/mcp/wb`, { headers: { accept: 'text/event-stream', ...bearer(E2E) } });
  assert.equal(get.status, 405);
  assert.equal(gateway.calls.length, before);
});

test('auth: no key, a malformed key and a key the gateway rejects all get 401; the rejection is cached', async () => {
  const none = await post(base, '/mcp/wb');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Bearer /);
  assert.match(none.body.error.message, /Authorization: Bearer cr_/);
  const before = gateway.calls.length;
  assert.equal((await post(base, '/mcp/wb', bearer('sk-not-a-tkbk-key'))).status, 401);
  assert.equal(gateway.calls.length, before, 'a malformed key never reaches the gateway');
  assert.equal((await post(base, '/mcp/wb', bearer(BAD))).status, 401);
  assert.equal((await post(base, '/mcp/wb', bearer(BAD))).status, 401);
  assert.equal(checksOf(BAD), 1);
});

test('auth: a good key is checked with the gateway once, then cached', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post(base, '/mcp/wb', bearer(CACHED))).status, 200);
  assert.equal(checksOf(CACHED), 1);
  assert.equal(gateway.calls.find((c) => c.key === CACHED).ip, '127.0.0.1', 'the client address goes to the gateway');
});

test('subscription gate: a valid key without an MCP subscription gets 403', async () => {
  const r = await post(base, '/mcp/wb', bearer(NO_SUB));
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /subscription/);
  assert.equal(checksOf(NO_SUB), 1, 'the key itself was valid');
});

test('end to end: an MCP client lists tools and calls one; x-wb-token reaches Wildberries, nothing else does', async () => {
  api.route(/orders\/new/, { orders: [{ id: 7, article: 'A-7', nmId: 70, convertedPrice: 99000, warehouseId: 1, createdAt: '2026-10-11' }] });
  const client = await mcpClient(base, '/mcp/wb', { ...bearer(E2E), 'x-wb-token': WB_SECRET, 'x-ozon-api-key': 'not-for-wb' });
  assert.deepEqual(client.getServerVersion(), { name: 'tkbk-wildberries', version: pkg.version });
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'wb_stocks'));
  const r = await client.callTool({ name: 'wb_new_orders', arguments: {} });
  assert.deepEqual(JSON.parse(r.content[0].text), [{ id: 7, article: 'A-7', nmId: 70, price: 990, warehouseId: 1, createdAt: '2026-10-11' }]);
  const call = api.calls.at(-1);
  assert.equal(call.url, 'https://marketplace-api.wildberries.ru/api/v3/orders/new');
  assert.deepEqual(Object.keys(call.init.headers).sort(), ['Authorization', 'accept']);
  assert.equal(call.init.headers.Authorization, WB_SECRET);
  await client.close();
});

test('header credentials: amoCRM subdomain → https://<sub>.amocrm.ru; a tool without credentials names the header', async () => {
  api.route(/shop\.amocrm\.ru\/api\/v4\/leads/, { _embedded: { leads: [] } });
  const amo = await mcpClient(base, '/mcp/amo', { ...bearer(E2E), 'x-amo-subdomain': 'shop', 'x-amo-token': 'amo-secret' });
  await amo.callTool({ name: 'amo_leads', arguments: {} });
  assert.match(api.calls.at(-1).url, /^https:\/\/shop\.amocrm\.ru\/api\/v4\/leads\?/);
  assert.equal(api.calls.at(-1).init.headers.Authorization, 'Bearer amo-secret');
  await amo.close();
  const bare = await mcpClient(base, '/mcp/ozon', bearer(E2E));
  const r = await bare.callTool({ name: 'ozon_stocks', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /x-ozon-client-id, x-ozon-api-key/);
  await bare.close();
});

test('header credentials: a webhook into our own network is refused with 400 and never fetched', async () => {
  const before = api.calls.length;
  const r = await post(base, '/mcp/b24', { ...bearer(E2E), 'x-b24-webhook': 'http://169.254.169.254/rest/1/abcd/' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /x-b24-webhook/);
  assert.equal(api.calls.length, before);
});

test('rate limit per key: 429 with retry-after once the minute is used up', async () => {
  const limited = await start({ ratePerMin: 2 });
  assert.equal((await post(limited, '/mcp/wb', bearer(RATE))).status, 200);
  assert.equal((await post(limited, '/mcp/wb', bearer(RATE))).status, 200);
  const third = await post(limited, '/mcp/wb', bearer(RATE));
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  assert.match(third.body.error.message, /2 requests a minute/);
});

test('invalid keys per address: blocked with 429 before the gateway is asked', async () => {
  const guarded = await start({ authFailLimit: 2 });
  const from = { 'x-forwarded-for': '198.51.100.9' }; // the test client is "our proxy" (127.0.0.1)
  assert.equal((await post(guarded, '/mcp/wb', { ...bearer('cr_wrong_format_key_1!'), ...from })).status, 401);
  assert.equal((await post(guarded, '/mcp/wb', { ...bearer('cr_wrong_format_key_2!'), ...from })).status, 401);
  const before = gateway.calls.length;
  const blocked = await post(guarded, '/mcp/wb', { ...bearer(key(9)), ...from });
  assert.equal(blocked.status, 429);
  assert.equal(gateway.calls.length, before);
  assert.equal((await post(guarded, '/mcp/wb', { ...bearer(E2E), 'x-forwarded-for': '198.51.100.10' })).status, 200, 'other addresses go on');
});

test('gateway unavailable: an unknown key gets 503 with retry-after', async () => {
  gateway.down = true;
  try {
    const r = await post(base, '/mcp/wb', bearer(DOWN));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '30');
  } finally {
    gateway.down = false;
  }
});

test('logs: key ids and tool names, never keys or marketplace credentials', () => {
  const text = JSON.stringify(logs);
  for (const secret of [E2E, CACHED, BAD, NO_SUB, WB_SECRET, 'amo-secret', 'not-for-wb']) assert.ok(!text.includes(secret), secret);
  assert.ok(logs.some((l) => l.kind === 'tool' && l.tool === 'wb_new_orders' && l.ok && l.key === keyIdOf(E2E).slice(0, 12)));
  assert.ok(logs.some((l) => l.kind === 'mcp' && l.status === 403 && l.reason === 'no-subscription'));
});
