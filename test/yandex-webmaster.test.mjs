// Yandex Webmaster: sites, indexing summary with problems, popular search queries (fetch is mocked, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialsFor } from '../src/hosted/credentials.mjs';
import { SERVICES } from '../src/index.mjs';
import { callJson, connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const API = 'https://api.webmaster.yandex.net/v4';
/** A fresh env per connection: the user id is cached per env object (stdio: the process, hosted: one request). */
const fresh = () => ({ WEBMASTER_TOKEN: 'tok-w' });
const sentSince = (n) => calls.slice(n);
const countOf = (n, pattern) => sentSince(n).filter((c) => pattern.test(c.url)).length;

const HOSTS = {
  hosts: [
    {
      host_id: 'http:example.com:80', ascii_host_url: 'http://example.com/', unicode_host_url: 'http://example.com/', verified: true,
      main_mirror: { host_id: 'https:example.com:443', verified: true, ascii_host_url: 'https://example.com/', unicode_host_url: 'https://example.com/' },
    },
    { host_id: 'https:example.com:443', ascii_host_url: 'https://example.com/', unicode_host_url: 'https://example.com/', verified: true },
    { host_id: 'https:blog.example.org:443', ascii_host_url: 'https://blog.example.org/', verified: false },
  ],
};
const SUMMARY = { sqi: 120, excluded_pages_count: 15, searchable_pages_count: 340, site_problems: { FATAL: 1, CRITICAL: 2 } };
const DIAGNOSTICS = {
  problems: {
    SLOW_AVG_RESPONSE_TIME: { severity: 'CRITICAL', state: 'PRESENT', last_state_update: '2026-10-05T00:00:00,000+0300' },
    DNS_ERROR: { severity: 'FATAL', state: 'ABSENT', last_state_update: '2026-09-01T00:00:00,000+0300' },
    NO_SITEMAPS: { severity: 'FATAL', state: 'PRESENT', last_state_update: '2026-10-01T00:00:00,000+0300' },
    NO_DESCRIPTION: { severity: 'RECOMMENDATION', state: 'UNDEFINED', last_state_update: '2026-10-01T00:00:00,000+0300' },
  },
};

/** The user, the sites, and the summary and diagnostics of https:example.com:443. */
function stubAccount() {
  route(/\/v4\/user$/, { user_id: 777 });
  route(/\/v4\/user\/777\/hosts$/, HOSTS);
  route(/\/hosts\/https:example\.com:443\/summary$/, SUMMARY);
  route(/\/hosts\/https:example\.com:443\/diagnostics$/, DIAGNOSTICS);
}

test('webmaster_hosts: user id once, then the sites with the OAuth header; mirrors are shown only when they differ', async () => {
  stubAccount();
  const c = await connect('yandex-webmaster', fresh());
  const n = calls.length;
  const out = await callJson(c, 'webmaster_hosts');
  const [userCall, hostsCall] = sentSince(n);
  assert.equal(userCall.url, `${API}/user`);
  assert.equal(hostsCall.url, `${API}/user/777/hosts`);
  assert.equal(hostsCall.init.headers.Authorization, 'OAuth tok-w');
  assert.deepEqual(out.hosts, [
    { id: 'http:example.com:80', url: 'http://example.com/', verified: true, mainMirror: 'https:example.com:443' },
    { id: 'https:example.com:443', url: 'https://example.com/', verified: true },
    { id: 'https:blog.example.org:443', url: 'https://blog.example.org/', verified: false },
  ]);
  await c.callTool({ name: 'webmaster_hosts', arguments: {} });
  assert.equal(countOf(n, /\/v4\/user$/), 1, 'the user id is looked up once');
});

test('webmaster_summary: a domain is resolved to the verified https site; summary and diagnostics are combined, present problems by severity', async () => {
  stubAccount();
  const c = await connect('yandex-webmaster', fresh());
  const n = calls.length;
  const out = await callJson(c, 'webmaster_summary', { site: 'https://www.Example.com/some/page' });
  assert.equal(countOf(n, /\/hosts\/https:example\.com:443\/summary$/), 1);
  assert.equal(countOf(n, /\/hosts\/https:example\.com:443\/diagnostics$/), 1);
  assert.deepEqual(out, {
    site: 'https:example.com:443', sqi: 120, searchablePages: 340, excludedPages: 15, problemCounts: { FATAL: 1, CRITICAL: 2 },
    problems: [
      { code: 'NO_SITEMAPS', severity: 'FATAL', since: '2026-10-01T00:00:00,000+0300' },
      { code: 'SLOW_AVG_RESPONSE_TIME', severity: 'CRITICAL', since: '2026-10-05T00:00:00,000+0300' },
    ],
  });
});

test('webmaster_summary: a site id is used as it is (no lookup of the sites); anything else that is unknown is refused before any resource call', async () => {
  stubAccount();
  const c = await connect('yandex-webmaster', fresh());
  const n = calls.length;
  await callJson(c, 'webmaster_summary', { site: 'https:example.com:443' });
  assert.equal(countOf(n, /\/hosts$/), 0);
  const m = calls.length;
  for (const bad of ['unknown.example.net', 'https:evil.com:443/../../user', 'a b']) {
    const r = await c.callTool({ name: 'webmaster_summary', arguments: { site: bad } });
    assert.equal(r.isError, true, bad);
    assert.match(textOf(r), /not in your Yandex Webmaster account: see webmaster_hosts/);
  }
  assert.equal(sentSince(m).filter((x) => /summary|diagnostics/.test(x.url)).length, 0);
});

test('webmaster_queries: popular queries with the order, indicators, device and period; positions rounded; nextOffset while the total is not reached', async () => {
  stubAccount();
  route(/\/hosts\/https:example\.com:443\/search-queries\/popular\?/, {
    queries: [
      { query_id: 'a1', query_text: 'купить чехол', indicators: { TOTAL_SHOWS: 1200, TOTAL_CLICKS: 80, AVG_SHOW_POSITION: 3.456, AVG_CLICK_POSITION: 2.1 } },
      { query_id: 'a2', query_text: 'чехол для телефона', indicators: { TOTAL_SHOWS: 900, TOTAL_CLICKS: 0, AVG_SHOW_POSITION: 7 } },
    ],
    date_from: '2026-10-08', date_to: '2026-10-14', count: 3000,
  });
  const c = await connect('yandex-webmaster', fresh());
  const n = calls.length;
  const out = await callJson(c, 'webmaster_queries', { site: 'example.com', orderBy: 'clicks', device: 'MOBILE', dateFrom: '2026-10-08', dateTo: '2026-10-14', limit: 2, offset: 4 });
  const call = sentSince(n).find((x) => x.url.includes('/search-queries/popular'));
  const q = new URL(call.url).searchParams;
  assert.equal(q.get('order_by'), 'TOTAL_CLICKS');
  assert.deepEqual(q.getAll('query_indicator'), ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']);
  assert.deepEqual([q.get('device_type_indicator'), q.get('date_from'), q.get('date_to'), q.get('limit'), q.get('offset')], ['MOBILE', '2026-10-08', '2026-10-14', '2', '4']);
  assert.equal(call.init.headers.Authorization, 'OAuth tok-w');
  assert.deepEqual(out.queries, [
    { query: 'купить чехол', shows: 1200, clicks: 80, showPosition: 3.5, clickPosition: 2.1 },
    { query: 'чехол для телефона', shows: 900, clicks: 0, showPosition: 7 },
  ]);
  assert.deepEqual(out.period, { from: '2026-10-08', to: '2026-10-14' });
  assert.equal(out.total, 3000);
  assert.equal(out.nextOffset, 6);
  const plain = await callJson(c, 'webmaster_queries', { site: 'example.com' });
  const q2 = new URL(calls.at(-1).url).searchParams;
  assert.deepEqual([q2.get('order_by'), q2.has('device_type_indicator'), q2.has('date_from'), q2.get('limit'), q2.get('offset')], ['TOTAL_SHOWS', false, false, '50', '0']);
  assert.equal(plain.nextOffset, 2);
  route(/\/search-queries\/popular\?/, { queries: [{ query_text: 'x', indicators: { TOTAL_SHOWS: 1 } }], count: '1', date_from: '2026-10-08', date_to: '2026-10-14' });
  assert.equal((await callJson(c, 'webmaster_queries', { site: 'example.com' })).nextOffset, undefined, 'the last page (the total may be a string)');
});

test('errors: the code and message of the service are shown; a 429 is repeated after Retry-After', async () => {
  stubAccount();
  route(/\/hosts\/https:example\.com:443\/summary$/, { error_code: 'HOST_NOT_LOADED', host_id: 'https:example.com:443', error_message: 'Data is not loaded yet' }, 404);
  const c = await connect('yandex-webmaster', fresh());
  const r = await c.callTool({ name: 'webmaster_summary', arguments: { site: 'example.com' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 404: HOST_NOT_LOADED: Data is not loaded yet/);
  route(/\/v4\/user$/, { error_code: 'TOO_MANY_REQUESTS_ERROR', error_message: 'Slow down' }, 403);
  const d = await connect('yandex-webmaster', fresh());
  assert.match(textOf(await d.callTool({ name: 'webmaster_hosts', arguments: {} })), /HTTP 403: TOO_MANY_REQUESTS_ERROR: Slow down/);
  route(/\/v4\/user$/, (url, init, n) => (n === 0
    ? { status: 429, body: { error_code: 'QUOTA_EXCEEDED', error_message: 'Quota exceeded', daily_quota: 1000 }, headers: { 'retry-after': '0' } }
    : { user_id: 777 }));
  route(/\/v4\/user\/777\/hosts$/, HOSTS);
  const n = calls.length;
  const e = await connect('yandex-webmaster', fresh());
  assert.equal((await callJson(e, 'webmaster_hosts')).hosts.length, 3);
  assert.equal(countOf(n, /\/v4\/user$/), 2);
  route(/\/v4\/user$/, { user_id: 'not-a-number' });
  const bad = await (await connect('yandex-webmaster', fresh())).callTool({ name: 'webmaster_hosts', arguments: {} });
  assert.match(textOf(bad), /Could not read the Yandex Webmaster user id/);
});

test('input is validated; not configured names WEBMASTER_TOKEN; the API url can be overridden', async () => {
  const c = await connect('yandex-webmaster', fresh());
  const n = calls.length;
  for (const args of [{ site: 'example.com', dateFrom: '08.10.2026' }, { site: 'example.com', limit: 501 }, { site: 'example.com', device: 'WATCH' }, { site: '' }]) {
    const r = await c.callTool({ name: 'webmaster_queries', arguments: args }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, n);
  const bare = await connect('yandex-webmaster', {});
  assert.match(textOf(await bare.callTool({ name: 'webmaster_hosts', arguments: {} })), /WEBMASTER_TOKEN/);
  assert.equal(calls.length, n);
  route(/proxy\.test/, (url) => (url.endsWith('/user') ? { user_id: 5 } : { hosts: [] }));
  await (await connect('yandex-webmaster', { ...fresh(), WEBMASTER_API_URL: 'https://proxy.test/wm/' })).callTool({ name: 'webmaster_hosts', arguments: {} });
  assert.equal(calls.at(-1).url, 'https://proxy.test/wm/user/5/hosts');
});

test('hosted: x-webmaster-token maps into the env; a bad value is refused', () => {
  assert.deepEqual(credentialsFor(SERVICES.webmaster, { 'x-webmaster-token': 'y0_AgAAAA-token' }), { env: { WEBMASTER_TOKEN: 'y0_AgAAAA-token' } });
  assert.deepEqual(credentialsFor(SERVICES['yandex-webmaster'], {}), { env: {} });
  assert.match(credentialsFor(SERVICES.webmaster, { 'x-webmaster-token': 'two words' }).error, /x-webmaster-token/);
});
