// Hosted mode building blocks: key check cache, subscription allow-list, credential headers, limits, client address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerKey, createAllowList, createKeyValidator, isKeyFormat, keyIdOf, parseKeyIds } from '../src/hosted/auth.mjs';
import { CREDENTIAL_HEADERS, credentialsFor, missingHeadersHint } from '../src/hosted/credentials.mjs';
import { bucketOf, clientIp, createRateLimiter } from '../src/hosted/limits.mjs';
import { HOSTED_PATHS } from '../src/http.mjs';
import { SERVICES } from '../src/index.mjs';

const KEY = `cr_${'a'.repeat(64)}`;
const MINUTE = 60_000;
const CHECK_URL = 'https://gw.test/openai/v1/models';

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

/** Fake gateway: answers with the next status of the list (the last one repeats); 'down' — no answer. */
function gateway(statuses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (s === 'down') throw new TypeError('fetch failed');
    return new Response('{}', { status: s, headers: s === 429 ? { 'retry-after': '120' } : {} });
  };
  return { calls, fetchImpl };
}

test('key check: a good key is cached 5 minutes; the gateway gets x-api-key and the client address', async () => {
  const now = clock();
  const g = gateway([200]);
  const v = createKeyValidator({ checkUrl: CHECK_URL, fetchImpl: g.fetchImpl, now });
  assert.equal((await v.check(KEY, { clientIp: '203.0.113.7' })).status, 'valid');
  assert.deepEqual(await v.check(KEY), { status: 'valid', cached: true });
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].url, CHECK_URL);
  assert.equal(g.calls[0].headers['x-api-key'], KEY);
  assert.equal(g.calls[0].headers['x-forwarded-for'], '203.0.113.7');
  now.advance(5 * MINUTE);
  await v.check(KEY);
  assert.equal(g.calls.length, 2, 'asked again after 5 minutes');
});

test('key check: a bad key is rejected, the rejection is cached for a minute', async () => {
  const now = clock();
  const g = gateway([401]);
  const v = createKeyValidator({ checkUrl: CHECK_URL, fetchImpl: g.fetchImpl, now });
  assert.equal((await v.check(KEY)).status, 'invalid');
  assert.equal((await v.check(KEY)).status, 'invalid');
  assert.equal(g.calls.length, 1);
  now.advance(MINUTE);
  await v.check(KEY);
  assert.equal(g.calls.length, 2);
});

test('key check: parallel checks of one key share one request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const v = createKeyValidator({ checkUrl: CHECK_URL, fetchImpl: async () => { calls += 1; await gate; return new Response('{}'); } });
  const both = Promise.all([v.check(KEY), v.check(KEY)]);
  release();
  assert.deepEqual((await both).map((r) => r.status), ['valid', 'valid']);
  assert.equal(calls, 1);
});

test('key check: gateway down → unavailable, but a key valid within the hour stays valid; 429 → limited', async () => {
  const now = clock();
  const g = gateway([200, 'down', 500]);
  const v = createKeyValidator({ checkUrl: CHECK_URL, fetchImpl: g.fetchImpl, now });
  await v.check(KEY);
  now.advance(6 * MINUTE);
  assert.deepEqual(await v.check(KEY), { status: 'valid', stale: true });
  now.advance(2 * 60 * MINUTE);
  assert.equal((await v.check(KEY)).status, 'unavailable');
  const limited = createKeyValidator({ checkUrl: CHECK_URL, fetchImpl: gateway([429]).fetchImpl });
  assert.deepEqual(await limited.check(KEY), { status: 'limited', retryAfter: 120 });
});

test('bearer key, key format and key id', () => {
  assert.equal(bearerKey({ authorization: `Bearer ${KEY}` }), KEY);
  assert.equal(bearerKey({ authorization: `bearer  ${KEY} ` }), KEY);
  assert.equal(bearerKey({ authorization: KEY }), null);
  assert.equal(bearerKey({}), null);
  assert.ok(isKeyFormat(KEY));
  for (const bad of ['sk-123', 'cr_short', `cr_${'a'.repeat(64)}!`, '']) assert.ok(!isKeyFormat(bad), bad);
  assert.match(keyIdOf(KEY), /^[0-9a-f]{64}$/);
});

test('allow-list: inline ids, comments, "*" opens to every key', async () => {
  const id = keyIdOf(KEY);
  const { ids, skipped } = parseKeyIds(`# paid\n${id.toUpperCase()}, nonsense ; ${'b'.repeat(64)}`);
  assert.deepEqual([...ids], [id, 'b'.repeat(64)]);
  assert.equal(skipped, 1);
  assert.equal(await createAllowList({ ids: id }).isSubscribed(id), true);
  assert.equal(await createAllowList({ ids: id }).isSubscribed('c'.repeat(64)), false);
  assert.equal(await createAllowList({}).isSubscribed(id), false, 'nothing configured: nobody');
  assert.equal(await createAllowList({ ids: '*' }).isSubscribed(id), true);
});

test('allow-list file: re-read after it changes, a missing file means nobody', async () => {
  const now = clock();
  const id = keyIdOf(KEY);
  const disk = { text: '', ino: 1, mtimeMs: 1, exists: true };
  const fs = {
    statSync: () => {
      if (!disk.exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { ino: disk.ino, mtimeMs: disk.mtimeMs, size: disk.text.length };
    },
    readFileSync: () => disk.text,
  };
  const list = createAllowList({ file: '/data/allowed-keys.txt', fs, now, reloadMs: 10_000 });
  assert.equal(await list.isSubscribed(id), false);
  Object.assign(disk, { text: `${id}\n`, mtimeMs: 2 });
  assert.equal(await list.isSubscribed(id), false, 'not re-read within reloadMs');
  now.advance(10_000);
  assert.equal(await list.isSubscribed(id), true);
  disk.exists = false;
  now.advance(10_000);
  assert.equal(await list.isSubscribed(id), false);
});

test('credentials: headers map into the env of the service, and only of that service', () => {
  const h = { 'x-wb-token': 'wb.jwt.token', 'x-ozon-api-key': 'oz', 'x-ym-api-key': 'ACMA:abc:def', 'x-ym-business-id': '77' };
  assert.deepEqual(credentialsFor(SERVICES.wb, h), { env: { WB_TOKEN: 'wb.jwt.token' } });
  assert.deepEqual(credentialsFor(SERVICES.ym, h), { env: { YM_API_KEY: 'ACMA:abc:def', YM_BUSINESS_ID: '77' } });
  assert.deepEqual(credentialsFor(SERVICES.ozon, { 'x-ozon-client-id': '123', 'x-ozon-api-key': 'k-1' }), { env: { OZON_CLIENT_ID: '123', OZON_API_KEY: 'k-1' } });
  assert.deepEqual(credentialsFor(SERVICES.amo, { 'x-amo-subdomain': 'Shop', 'x-amo-token': 't' }), { env: { AMOCRM_DOMAIN: 'shop.amocrm.ru', AMOCRM_TOKEN: 't' } });
  assert.deepEqual(credentialsFor(SERVICES.amo, { 'x-amo-subdomain': 'https://shop.kommo.com/' }), { env: { AMOCRM_DOMAIN: 'shop.kommo.com' } });
  assert.deepEqual(credentialsFor(SERVICES.b24, { 'x-b24-webhook': 'https://My-Co.bitrix24.ru/rest/1/abc123xyz' }), { env: { BITRIX24_WEBHOOK_URL: 'https://my-co.bitrix24.ru/rest/1/abc123xyz/' } });
  assert.deepEqual(credentialsFor(SERVICES.wb, {}), { env: {} });
  assert.match(missingHeadersHint(['OZON_CLIENT_ID', 'OZON_API_KEY']), /headers x-ozon-client-id, x-ozon-api-key/);
});

test('credentials: no header can point a request at our own network or another host', () => {
  const amo = ['tkbk-gateway:8080', '169.254.169.254', 'evil.com', 'shop.amocrm.ru.evil.com', 'shop.amocrm.ru/api'];
  for (const v of amo) assert.match(credentialsFor(SERVICES.amo, { 'x-amo-subdomain': v }).error, /x-amo-subdomain/, v);
  const b24 = [
    'http://x.bitrix24.ru/rest/1/abcd/', 'https://169.254.169.254/rest/1/abcd/', 'https://tkbk-gateway/rest/1/abcd/',
    'https://x.bitrix24.ru:8443/rest/1/abcd/', 'https://u:p@x.bitrix24.ru/rest/1/abcd/', 'https://x.bitrix24.ru.evil.com/rest/1/abcd/',
    'https://x.bitrix24.ru/admin/', 'https://x.bitrix24.ru/rest/1/abcd/?a=1', 'not a url',
  ];
  for (const v of b24) assert.match(credentialsFor(SERVICES.b24, { 'x-b24-webhook': v }).error, /x-b24-webhook/, v);
  const onPremise = credentialsFor(SERVICES.b24, { 'x-b24-webhook': 'https://crm.shop.ru/rest/1/abcd/' }, { b24Hosts: new Set(['crm.shop.ru']) });
  assert.deepEqual(onPremise, { env: { BITRIX24_WEBHOOK_URL: 'https://crm.shop.ru/rest/1/abcd/' } });
  assert.match(credentialsFor(SERVICES.ozon, { 'x-ozon-client-id': '12a' }).error, /x-ozon-client-id/);
  assert.match(credentialsFor(SERVICES.wb, { 'x-wb-token': 'two words' }).error, /x-wb-token/);
});

test('hosted: every documented path is a service with tools; the new services take each credential from a header', () => {
  for (const path of HOSTED_PATHS) assert.ok(SERVICES[path]?.tools.length > 0, path);
  for (const path of ['avito', 'direct', 'metrika', 'webmaster', 'dadata']) {
    const service = SERVICES[path];
    for (const name of [...service.env, ...(service.optionalEnv ?? [])]) {
      assert.deepEqual(credentialsFor(service, { [CREDENTIAL_HEADERS[name]]: 'abc123' }), { env: { [name]: 'abc123' } }, `${path}: ${name}`);
    }
  }
  assert.match(missingHeadersHint(['AVITO_CLIENT_ID', 'AVITO_CLIENT_SECRET']), /headers x-avito-client-id, x-avito-client-secret/);
});

test('rate limiter: a burst of perMinute, then retry-after; tokens come back over time; 0 — off', () => {
  const now = clock();
  const rl = createRateLimiter({ perMinute: 60, now });
  for (let i = 0; i < 60; i++) assert.equal(rl.take('k'), 0);
  assert.equal(rl.take('k'), 1, 'one more in a second');
  assert.equal(rl.blockedFor('k'), 1);
  assert.equal(rl.take('other'), 0, 'per id');
  now.advance(1_000);
  assert.equal(rl.take('k'), 0);
  const off = createRateLimiter({ perMinute: 0, now });
  for (let i = 0; i < 1000; i++) assert.equal(off.take('k'), 0);
});

test('client address: X-Forwarded-For only from our own proxy; IPv6 counted per /64', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('172.18.0.5', '1.2.3.4, 203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('::ffff:172.18.0.5', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('198.51.100.1', '203.0.113.9')), '198.51.100.1', 'a public peer cannot spoof its address');
  assert.equal(clientIp(req('172.18.0.5', 'garbage<script>')), '172.18.0.5');
  assert.equal(bucketOf('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(bucketOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(bucketOf('203.0.113.9'), '203.0.113.9');
});
