import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, cachedPerEnv, collectPages, compact, forgetPerEnv, isoDate, queryString, request, retryDelayMs } from '../src/core.mjs';
import { connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const noSleep = async () => {};
const countCalls = (pattern) => calls.filter((c) => pattern.test(c.url)).length;

test('retryDelayMs: Retry-After in seconds or as a date, WB X-Ratelimit-Retry, else exponential backoff', () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  assert.equal(retryDelayMs(new Headers({ 'retry-after': '3' }), 0, now), 3000);
  assert.equal(retryDelayMs(new Headers({ 'retry-after': 'Sun, 11 Oct 2026 10:00:05 GMT' }), 0, now), 5000);
  assert.equal(retryDelayMs(new Headers({ 'x-ratelimit-retry': '2' }), 0, now), 2000);
  assert.equal(retryDelayMs(new Headers(), 0, now), 1000);
  assert.equal(retryDelayMs(null, 2, now), 4000);
});

test('request: 429 is retried after Retry-After, then the answer is returned', async () => {
  route(/rl-429/, (url, init, n) => (n === 0 ? { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } } : { ok: true }));
  assert.deepEqual(await request('https://api.test/rl-429'), { ok: true });
  assert.equal(countCalls(/rl-429/), 2);
});

test('request: Yandex Market 420 is a rate limit as well — even a POST is repeated', async () => {
  const waits = [];
  route(/rl-420/, (url, init, n) => (n === 0 ? { status: 420, body: { status: 'ERROR' } } : { done: 1 }));
  const out = await request('https://api.test/rl-420', { method: 'POST', body: {}, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(out, { done: 1 });
  assert.deepEqual(waits, [1000], 'no Retry-After: backoff from 1 s');
});

test('request: a wait longer than 20 s is not slept through — "retry in N s" at once', async () => {
  route(/rl-long/, { message: 'Too many requests' }, 429, { 'x-ratelimit-retry': '61' });
  await assert.rejects(
    request('https://api.test/rl-long', { sleep: () => assert.fail('must not sleep') }),
    (e) => e instanceof ApiError && e.status === 429 && /Too many requests \(rate limit: retry in 61 s\)/.test(e.message),
  );
  assert.equal(countCalls(/rl-long/), 1);
});

test('request: gives up after 3 attempts', async () => {
  route(/always-429/, { message: 'no' }, 429, { 'retry-after': '0' });
  await assert.rejects(request('https://api.test/always-429'), (e) => e.status === 429);
  assert.equal(countCalls(/always-429/), 3);
});

test('request: 5xx and network errors are retried for reads, never for writes', async () => {
  route(/flaky-read/, (url, init, n) => (n === 0 ? { status: 503, body: { message: 'busy' } } : { ok: 1 }));
  assert.deepEqual(await request('https://api.test/flaky-read', { sleep: noSleep }), { ok: 1 });
  route(/flaky-list/, (url, init, n) => (n === 0 ? { status: 502, body: {} } : { ok: 2 }));
  assert.deepEqual(await request('https://api.test/flaky-list', { method: 'POST', body: {}, idempotent: true, sleep: noSleep }), { ok: 2 });
  route(/net-down/, (url, init, n) => {
    if (n === 0) throw new TypeError('fetch failed');
    return { ok: 3 };
  });
  assert.deepEqual(await request('https://api.test/net-down', { sleep: noSleep }), { ok: 3 });
  route(/write-5xx/, { message: 'busy' }, 503);
  await assert.rejects(request('https://api.test/write-5xx', { method: 'POST', body: {}, sleep: noSleep }), /HTTP 503: busy/);
  assert.equal(countCalls(/write-5xx/), 1, 'a write may have gone through: not repeated');
});

test('collectPages: follows cursors, asks only for the missing items, returns where to continue', async () => {
  const all = [1, 2, 3, 4, 5];
  const asked = [];
  const fetchPage = async (cursor, size) => {
    asked.push([cursor, size]);
    const from = Number(cursor ?? 0);
    const items = all.slice(from, from + size);
    return { items, next: from + items.length < all.length ? String(from + items.length) : null };
  };
  const first = await collectPages(fetchPage, { limit: 3, pageSize: 2 });
  assert.deepEqual(first, { items: [1, 2, 3], next: '3' });
  assert.deepEqual(asked, [[undefined, 2], ['2', 1]]);
  const rest = await collectPages(fetchPage, { limit: 10, pageSize: 2, cursor: first.next });
  assert.deepEqual(rest, { items: [4, 5], next: null });
});

test('collectPages: stops at maxPages', async () => {
  let pages = 0;
  const r = await collectPages(async () => ({ items: [pages++], next: 'more' }), { limit: 100, pageSize: 1, maxPages: 3 });
  assert.deepEqual(r, { items: [0, 1, 2], next: 'more' });
});

test('compact: drops empty values, caps arrays at maxItems', () => {
  assert.deepEqual(compact({ a: null, b: '', c: [], d: [1, 2, 3] }, 2), { d: [1, 2, '… and 1 more'] });
});

test('buildServer: onCall reports tool, outcome and time — never the arguments; configHint replaces the message', async () => {
  const seen = [];
  route(/orders\/new/, { orders: [] });
  const c = await connect('wb', { WB_TOKEN: 'secret-token' }, { onCall: (call) => seen.push(call) });
  await c.callTool({ name: 'wb_new_orders', arguments: {} });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['ms', 'ok', 'tool']);
  assert.equal(seen[0].tool, 'wb_new_orders');
  const bare = await connect('wb', {}, { configHint: (missing) => `need ${missing.join('+')}` });
  assert.equal(textOf(await bare.callTool({ name: 'wb_new_orders', arguments: {} })), 'need WB_TOKEN');
});

test('request: a string body goes as it is under the caller content-type; full gives status and headers', async () => {
  route(/echo-form/, (url, init) => ({ got: init.body, type: init.headers['content-type'] }));
  const form = await request('https://api.test/echo-form', { method: 'POST', body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.deepEqual(form, { got: 'a=1&b=2', type: 'application/x-www-form-urlencoded' });
  route(/queued-202/, { queued: true }, 202, { retryin: '3' });
  const full = await request('https://api.test/queued-202', { method: 'POST', body: {}, full: true });
  assert.equal(full.status, 202);
  assert.equal(full.headers.get('retryIn'), '3');
  assert.deepEqual(full.data, { queued: true });
});

test('request: Yandex Direct and Webmaster error shapes are readable', async () => {
  route(/direct-error/, { error: { error_code: 53, error_string: 'Ошибка авторизации', error_detail: 'Bad token' } }, 400);
  await assert.rejects(request('https://api.test/direct-error', { method: 'POST', body: {} }), /HTTP 400: Ошибка авторизации: Bad token/);
  route(/webmaster-error/, { error_code: 'HOST_NOT_VERIFIED', error_message: 'not verified' }, 404);
  await assert.rejects(request('https://api.test/webmaster-error'), /HTTP 404: HOST_NOT_VERIFIED: not verified/);
});

test('queryString: skips empty values, repeats the key of an array, encodes', () => {
  assert.equal(queryString({ a: 1, b: '', c: undefined, d: null, e: ['x', 'y'], f: 'a b' }), '?a=1&e=x&e=y&f=a+b');
  assert.equal(queryString({}), '');
  assert.equal(queryString(), '');
});

test('isoDate: the UTC day of a timestamp', () => {
  assert.equal(isoDate(Date.parse('2026-10-15T23:59:59Z')), '2026-10-15');
  assert.match(isoDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('cachedPerEnv: concurrent callers share one load; stale values reload; failures and other envs are not cached', async () => {
  const env = {};
  let loads = 0;
  const load = async () => ({ n: ++loads, fresh: true });
  const [a, b] = await Promise.all([cachedPerEnv(env, 'k', load), cachedPerEnv(env, 'k', load)]);
  assert.equal(a, b);
  assert.equal(loads, 1);
  assert.equal((await cachedPerEnv({}, 'k', load)).n, 2, 'another env loads on its own');
  a.fresh = false;
  assert.equal((await cachedPerEnv(env, 'k', load, (v) => v.fresh)).n, 3, 'a value that is not fresh is loaded again');
  forgetPerEnv(env, 'k');
  assert.equal((await cachedPerEnv(env, 'k', load)).n, 4);
  const failing = {};
  await assert.rejects(cachedPerEnv(failing, 'x', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cachedPerEnv(failing, 'x', async () => 'ok'), 'ok', 'a failed load is not cached');
});
