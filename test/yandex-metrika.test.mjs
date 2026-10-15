// Yandex Metrika: counters, summary of a counter and traffic sources (fetch is mocked, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialsFor } from '../src/hosted/credentials.mjs';
import { SERVICES } from '../src/index.mjs';
import { callJson, connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const ENV = { METRIKA_TOKEN: 'tok-m' };
const BASE = 'https://api-metrika.yandex.net';
const sentSince = (n) => calls.slice(n);
const paramsOf = (call) => new URL(call.url).searchParams;

const COUNTERS = {
  rows: 3,
  counters: [
    {
      id: 101, name: 'Магазин', status: 'Active', activity_status: 'high', type: 'simple', permission: 'own', owner_login: 'shop-owner',
      create_time: '2024-01-15T10:00:00+03:00', site2: { site: 'shop.example' }, goals: [{ id: 11, name: 'Заказ', type: 'action', default_price: 0 }],
    },
    { id: 102, name: 'Блог', status: 'Active', type: 'simple', permission: 'view', site: 'blog.example' },
  ],
};

test('metrika_counters: management API with the OAuth header; counters and goals are mapped; nextOffset while the total says more', async () => {
  route(/\/management\/v1\/counters\?/, COUNTERS);
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  const out = await callJson(c, 'metrika_counters', { search: 'shop', withGoals: true, limit: 2 });
  const [call] = sentSince(n);
  assert.equal(new URL(call.url).origin + new URL(call.url).pathname, `${BASE}/management/v1/counters`);
  assert.equal(call.init.headers.Authorization, 'OAuth tok-m');
  assert.deepEqual(Object.fromEntries(paramsOf(call)), { per_page: '2', offset: '1', search_string: 'shop', field: 'goals' });
  assert.deepEqual(out.counters[0], {
    id: 101, name: 'Магазин', site: 'shop.example', status: 'Active', activity: 'high', type: 'simple', permission: 'own', owner: 'shop-owner',
    createdAt: '2024-01-15T10:00:00+03:00', goals: [{ id: 11, name: 'Заказ', type: 'action' }],
  });
  assert.deepEqual(out.counters[1], { id: 102, name: 'Блог', site: 'blog.example', status: 'Active', type: 'simple', permission: 'view' });
  assert.equal(out.nextOffset, 3, 'counters 1 and 2 shown, the third is next');
  route(/\/management\/v1\/counters\?/, { rows: 3, counters: [COUNTERS.counters[1]] });
  const last = await callJson(c, 'metrika_counters', { offset: 3 });
  assert.equal(last.nextOffset, undefined);
  assert.equal(paramsOf(calls.at(-1)).has('field'), false, 'goals only when asked');
});

test('metrika_summary: /stat/v1/data with the base metrics and the goal metrics; values are zipped; the period comes from the answer', async () => {
  const values = [1200, 900, 3500, 37.256, 142.44, 30, 2.5, 12, 1];
  route(/\/stat\/v1\/data\?/, { query: { date1: '2026-10-01', date2: '2026-10-07' }, data: [{ dimensions: [], metrics: values }], totals: values, total_rows: 1, sampled: false });
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  const out = await callJson(c, 'metrika_summary', { counterId: 101, dateFrom: '2026-10-01', dateTo: '2026-10-07', goalIds: [11, 12] });
  const [call] = sentSince(n);
  assert.equal(call.init.headers.Authorization, 'OAuth tok-m');
  const q = paramsOf(call);
  assert.equal(q.get('ids'), '101');
  assert.equal(q.get('metrics'), 'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds,ym:s:goal11reaches,ym:s:goal11conversionRate,ym:s:goal12reaches,ym:s:goal12conversionRate');
  assert.deepEqual([q.get('date1'), q.get('date2'), q.get('lang')], ['2026-10-01', '2026-10-07', 'ru']);
  assert.equal(q.has('dimensions'), false);
  assert.deepEqual(out, {
    period: { from: '2026-10-01', to: '2026-10-07' }, visits: 1200, users: 900, pageviews: 3500, bounceRate: 37.26, avgVisitSeconds: 142.44,
    goals: [{ id: 11, reaches: 30, conversionRate: 2.5 }, { id: 12, reaches: 12, conversionRate: 1 }],
  });
});

test('metrika_summary: default dates are left to Metrika, a sampled answer is marked, totals fall back to the first row', async () => {
  route(/\/stat\/v1\/data\?/, { query: { date1: '2026-10-09', date2: '2026-10-15' }, data: [{ dimensions: [], metrics: [10, 8, 25, null, 60] }], sampled: true, sample_share: 0.1 });
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  const out = await callJson(c, 'metrika_summary', { counterId: 7 });
  const q = paramsOf(sentSince(n)[0]);
  assert.equal(q.has('date1') || q.has('date2'), false);
  assert.deepEqual(out, { period: { from: '2026-10-09', to: '2026-10-15' }, visits: 10, users: 8, pageviews: 25, avgVisitSeconds: 60, sampled: true, sampleShare: 0.1 });
});

test('metrika_sources: traffic types by default (last click), sorted by visits; rows and totals mapped; nextOffset from total_rows', async () => {
  route(/\/stat\/v1\/data\?/, {
    query: { date1: '2026-10-01', date2: '2026-10-07' },
    total_rows: 3,
    data: [
      { dimensions: [{ id: 'organic', name: 'Переходы из поисковых систем' }], metrics: [700, 500, 31.044, 2.6, 160.2] },
      { dimensions: [{ id: 'direct', name: 'Прямые заходы' }], metrics: [300, 250, 45, 1.9, 80] },
    ],
    totals: [1200, 900, 37.256, 2.4, 142.4],
  });
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  const out = await callJson(c, 'metrika_sources', { counterId: 101, dateFrom: '2026-10-01', dateTo: '2026-10-07', limit: 2 });
  const q = paramsOf(sentSince(n)[0]);
  assert.equal(q.get('dimensions'), 'ym:s:<attribution>TrafficSource');
  assert.equal(q.get('attribution'), 'last');
  assert.equal(q.get('metrics'), 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds');
  assert.deepEqual([q.get('sort'), q.get('limit'), q.get('offset')], ['-ym:s:visits', '2', '1']);
  assert.deepEqual(out.rows[0], { source: 'Переходы из поисковых систем', id: 'organic', visits: 700, users: 500, bounceRate: 31.04, pageDepth: 2.6, avgVisitSeconds: 160.2 });
  assert.deepEqual(out.totals, { visits: 1200, users: 900, bounceRate: 37.26, pageDepth: 2.4, avgVisitSeconds: 142.4 });
  assert.equal(out.nextOffset, 3, 'two rows seen of three: the next page starts at row 3');
});

test('metrika_sources: utm groups by three dimensions with a chosen attribution; the last page has no nextOffset', async () => {
  route(/\/stat\/v1\/data\?/, {
    total_rows: 1,
    data: [{ dimensions: [{ name: 'yandex' }, { name: 'cpc' }, { name: 'autumn' }], metrics: [50, 40, 20, 3, 100] }],
    totals: [50, 40, 20, 3, 100],
  });
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  const out = await callJson(c, 'metrika_sources', { counterId: 101, groupBy: 'utm', attribution: 'cross_device_last_significant' });
  const q = paramsOf(sentSince(n)[0]);
  assert.equal(q.get('dimensions'), 'ym:s:<attribution>UTMSource,ym:s:<attribution>UTMMedium,ym:s:<attribution>UTMCampaign');
  assert.equal(q.get('attribution'), 'cross_device_last_significant');
  assert.equal(out.rows[0].source, 'yandex / cpc / autumn');
  assert.equal(out.rows[0].id, undefined);
  assert.equal(out.nextOffset, undefined);
});

test('quota 429 is repeated after Retry-After; a long wait is reported at once; API errors are readable', async () => {
  route(/\/stat\/v1\/data\?/, (url, init, n) => (n === 0
    ? { status: 429, body: { code: 429, message: 'Quota exceeded', errors: [{ error_type: 'quota_requests_by_uid', message: 'Quota exceeded' }] }, headers: { 'retry-after': '0' } }
    : { data: [], totals: [1, 1, 1, 1, 1], query: {} }));
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  assert.equal((await callJson(c, 'metrika_summary', { counterId: 1 })).visits, 1);
  assert.equal(sentSince(n).length, 2);
  route(/\/stat\/v1\/data\?/, { code: 429, message: 'Quota exceeded' }, 429, { 'retry-after': '300' });
  const limited = await c.callTool({ name: 'metrika_summary', arguments: { counterId: 1 } });
  assert.equal(limited.isError, true);
  assert.match(textOf(limited), /HTTP 429: Quota exceeded \(rate limit: retry in 300 s\)/);
  route(/\/stat\/v1\/data\?/, { code: 403, message: 'Access is denied', errors: [{ error_type: 'access_denied', message: 'Access is denied' }] }, 403);
  const denied = await c.callTool({ name: 'metrika_sources', arguments: { counterId: 1 } });
  assert.match(textOf(denied), /HTTP 403: Access is denied/);
});

test('input is validated; not configured names METRIKA_TOKEN; the API url can be overridden', async () => {
  const c = await connect('yandex-metrika', ENV);
  const n = calls.length;
  for (const args of [{ counterId: 1, dateFrom: '01.10.2026' }, { counterId: 1, goalIds: [1, 2, 3, 4, 5, 6] }, { counterId: 1, groupBy: 'city' }]) {
    const tool = args.groupBy ? 'metrika_sources' : 'metrika_summary';
    const r = await c.callTool({ name: tool, arguments: args }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, n, 'nothing is sent for invalid input');
  for (const ok of ['today', 'yesterday', '7daysAgo', '2026-10-01']) {
    route(/\/stat\/v1\/data\?/, { totals: [], data: [] });
    const r = await c.callTool({ name: 'metrika_summary', arguments: { counterId: 1, dateFrom: ok } });
    assert.notEqual(r.isError, true, ok);
  }
  const bare = await connect('yandex-metrika', {});
  const missing = await bare.callTool({ name: 'metrika_counters', arguments: {} });
  assert.match(textOf(missing), /METRIKA_TOKEN/);
  route(/proxy\.test/, { rows: 0, counters: [] });
  await (await connect('yandex-metrika', { ...ENV, METRIKA_API_URL: 'https://proxy.test/metrika/' })).callTool({ name: 'metrika_counters', arguments: {} });
  assert.match(calls.at(-1).url, /^https:\/\/proxy\.test\/metrika\/management\/v1\/counters\?/);
});

test('hosted: x-metrika-token maps into the env; a bad value is refused', () => {
  assert.deepEqual(credentialsFor(SERVICES.metrika, { 'x-metrika-token': 'y0_AgAAAA-token' }), { env: { METRIKA_TOKEN: 'y0_AgAAAA-token' } });
  assert.deepEqual(credentialsFor(SERVICES['yandex-metrika'], {}), { env: {} });
  assert.match(credentialsFor(SERVICES.metrika, { 'x-metrika-token': 'two words' }).error, /x-metrika-token/);
});
