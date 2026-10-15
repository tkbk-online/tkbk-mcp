// Yandex Direct: campaigns (JSON service) and the campaign report (TSV, online or offline) with mocked fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialsFor } from '../src/hosted/credentials.mjs';
import { SERVICES } from '../src/index.mjs';
import { callJson, connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const ENV = { DIRECT_TOKEN: 'tok-d' };
const BASE = 'https://api.direct.yandex.com/json/v501';
const bodyOf = (call) => JSON.parse(call.init.body);
const sentSince = (n) => calls.slice(n);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const textCampaign = (id) => ({
  Id: id, Name: `Кампания ${id}`, Type: 'TEXT_CAMPAIGN', State: 'ON', Status: 'ACCEPTED', StatusPayment: 'ALLOWED', StatusClarification: 'Идут показы',
  StartDate: '2026-09-01', Currency: 'RUB', Statistics: { Clicks: 120, Impressions: 4000 },
  Funds: { Mode: 'CAMPAIGN_FUNDS', CampaignFunds: { Sum: 5000000000, Balance: 1234500000, BalanceBonus: 0 } },
  TextCampaign: {
    BiddingStrategy: {
      Search: { BiddingStrategyType: 'WB_MAXIMUM_CLICKS', WbMaximumClicks: { WeeklySpendLimit: 3000000000, BidCeiling: null } },
      Network: { BiddingStrategyType: 'SERVING_OFF' },
    },
  },
});
const unifiedCampaign = (id) => ({
  Id: id, Name: 'Единая', Type: 'UNIFIED_CAMPAIGN', State: 'SUSPENDED', Status: 'ACCEPTED', StatusPayment: 'ALLOWED', Currency: 'RUB',
  Funds: { Mode: 'SHARED_ACCOUNT_FUNDS', SharedAccountFunds: { Spend: 7000000, Refund: 0 } },
  UnifiedCampaign: { BiddingStrategy: { Search: { BiddingStrategyType: 'WB_MAXIMUM_CONVERSION_RATE', WbMaximumConversionRate: { CustomPeriodBudget: { SpendLimit: 9000000000, StartDate: '2026-10-01', EndDate: '2026-10-31' } } } } },
});

const TSV = [
  'CampaignId\tCampaignName\tImpressions\tClicks\tCtr\tCost\tConversions\tCostPerConversion',
  '101\tБренд\t10000\t500\t5\t12345.67\t25\t493.83',
  '102\tТовары\t4000\t80\t2\t2000.5\t--\t--',
  'Total rows: 2',
].join('\n');
const ARGS = { dateFrom: '2026-10-01', dateTo: '2026-10-07' };
const queued = (status) => ({ raw: '', status, headers: { retryIn: '0' } });

test('direct_campaigns: POST /campaigns method get with the token, language and field names; money in micros becomes currency', async () => {
  route(/\/campaigns$/, { result: { Campaigns: [textCampaign(1), unifiedCampaign(2)], LimitedBy: 2 } });
  const c = await connect('yandex-direct', ENV);
  const n = calls.length;
  const out = await callJson(c, 'direct_campaigns', { states: ['ON', 'SUSPENDED'], ids: [1, 2], limit: 2 });
  const [call] = sentSince(n);
  assert.equal(call.url, `${BASE}/campaigns`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer tok-d');
  assert.equal(call.init.headers['Accept-Language'], 'ru');
  assert.equal(call.init.headers['Client-Login'], undefined);
  const body = bodyOf(call);
  assert.equal(body.method, 'get');
  assert.deepEqual(body.params.SelectionCriteria, { Ids: [1, 2], States: ['ON', 'SUSPENDED'] });
  assert.deepEqual(body.params.Page, { Limit: 2, Offset: 0 });
  assert.ok(['Id', 'State', 'Status', 'Funds', 'Statistics'].every((f) => body.params.FieldNames.includes(f)));
  assert.deepEqual(body.params.TextCampaignFieldNames, ['BiddingStrategy']);
  assert.deepEqual(body.params.UnifiedCampaignFieldNames, ['BiddingStrategy']);
  assert.deepEqual(out.campaigns[0], {
    id: 1, name: 'Кампания 1', type: 'TEXT_CAMPAIGN', state: 'ON', status: 'ACCEPTED', payment: 'ALLOWED', note: 'Идут показы', start: '2026-09-01',
    currency: 'RUB', balance: 1234.5, weeklyBudget: 3000, impressions: 4000, clicks: 120,
  });
  assert.deepEqual(out.campaigns[1], { id: 2, name: 'Единая', type: 'UNIFIED_CAMPAIGN', state: 'SUSPENDED', status: 'ACCEPTED', payment: 'ALLOWED', currency: 'RUB', spent: 7, periodBudget: 9000 });
  assert.equal(out.nextOffset, 2, 'LimitedBy is the offset of the next page');
});

test('direct_campaigns: the agency client login goes in Client-Login; no LimitedBy means the last page', async () => {
  route(/\/campaigns$/, { result: { Campaigns: [textCampaign(5)] } });
  const c = await connect('yandex-direct', { ...ENV, DIRECT_CLIENT_LOGIN: 'client-login' });
  const n = calls.length;
  const out = await callJson(c, 'direct_campaigns', { offset: 10 });
  const [call] = sentSince(n);
  assert.equal(call.init.headers['Client-Login'], 'client-login');
  assert.deepEqual(bodyOf(call).params.SelectionCriteria, {});
  assert.deepEqual(bodyOf(call).params.Page, { Limit: 50, Offset: 10 });
  assert.equal(out.nextOffset, undefined);
});

test('direct_campaigns: an error inside an HTTP 200 answer is reported with its code; limit errors say "retry later"', async () => {
  route(/\/campaigns$/, { error: { request_id: '1', error_code: 53, error_string: 'Ошибка авторизации', error_detail: 'Invalid token' } });
  const c = await connect('yandex-direct', ENV);
  const r = await c.callTool({ name: 'direct_campaigns', arguments: {} });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Direct error 53: Ошибка авторизации: Invalid token');
  route(/\/campaigns$/, { error: { request_id: '2', error_code: 152, error_string: 'Недостаточно баллов', error_detail: '' } });
  const limited = await c.callTool({ name: 'direct_campaigns', arguments: {} });
  assert.equal(textOf(limited), 'Direct error 152: Недостаточно баллов (limit reached: retry later)');
});

test('direct_stats: POST /reports with the report headers and a CUSTOM_DATE campaign report; TSV is mapped, "--" dropped, totals added', async () => {
  route(/\/reports$/, { raw: TSV });
  const c = await connect('yandex-direct', { ...ENV, DIRECT_CLIENT_LOGIN: 'client-login' });
  const n = calls.length;
  const out = await callJson(c, 'direct_stats', { ...ARGS, campaignIds: [101, 102], limit: 2 });
  const [call] = sentSince(n);
  assert.equal(call.url, `${BASE}/reports`);
  assert.equal(call.init.method, 'POST');
  const h = call.init.headers;
  assert.deepEqual([h.Authorization, h['Client-Login'], h.processingMode, h.returnMoneyInMicros, h.skipReportHeader, h.skipReportSummary], ['Bearer tok-d', 'client-login', 'auto', 'false', 'true', 'true']);
  const p = bodyOf(call).params;
  assert.deepEqual(p.SelectionCriteria, { DateFrom: '2026-10-01', DateTo: '2026-10-07', Filter: [{ Field: 'CampaignId', Operator: 'IN', Values: ['101', '102'] }] });
  assert.deepEqual([p.ReportType, p.DateRangeType, p.Format, p.IncludeVAT], ['CAMPAIGN_PERFORMANCE_REPORT', 'CUSTOM_DATE', 'TSV', 'YES']);
  assert.deepEqual(p.Page, { Limit: 2 });
  assert.deepEqual(p.OrderBy, [{ Field: 'Cost', SortOrder: 'DESCENDING' }]);
  assert.ok(['CampaignId', 'Impressions', 'Clicks', 'Cost', 'Conversions'].every((f) => p.FieldNames.includes(f)));
  assert.match(p.ReportName, /^tkbk-[0-9a-f]{16}$/);
  assert.deepEqual(out.period, { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(out.rows, [
    { campaignId: 101, campaignName: 'Бренд', impressions: 10000, clicks: 500, ctr: 5, cost: 12345.67, conversions: 25, costPerConversion: 493.83 },
    { campaignId: 102, campaignName: 'Товары', impressions: 4000, clicks: 80, ctr: 2, cost: 2000.5 },
  ]);
  assert.deepEqual(out.totals, { impressions: 14000, clicks: 580, cost: 14346.17, conversions: 25, ctr: 4.14, costPerConversion: 573.85 });
  assert.equal(out.nextOffset, 2, 'a full page: ask again from offset 2');
});

test('direct_stats: a report is named by its parameters; VAT and offset go into the request; a short page has no nextOffset', async () => {
  route(/\/reports$/, { raw: TSV });
  const c = await connect('yandex-direct', ENV);
  const n = calls.length;
  await c.callTool({ name: 'direct_stats', arguments: ARGS });
  await c.callTool({ name: 'direct_stats', arguments: ARGS });
  const out = await callJson(c, 'direct_stats', { ...ARGS, includeVat: false, offset: 100, limit: 5 });
  const [a, b, d] = sentSince(n).map((x) => bodyOf(x).params);
  assert.equal(a.ReportName, b.ReportName, 'the same request keeps the name');
  assert.notEqual(a.ReportName, d.ReportName, 'another request gets another name');
  assert.equal(d.IncludeVAT, 'NO');
  assert.deepEqual(d.Page, { Limit: 5, Offset: 100 });
  assert.equal(out.nextOffset, undefined);
});

test('direct_stats: without dates it asks for the last 7 days including today', async () => {
  route(/\/reports$/, { raw: TSV });
  const c = await connect('yandex-direct', ENV);
  const n = calls.length;
  const before = Date.now();
  await c.callTool({ name: 'direct_stats', arguments: {} });
  const { DateFrom, DateTo } = bodyOf(sentSince(n)[0]).params.SelectionCriteria;
  const day = 86_400_000;
  assert.ok([isoDay(before), isoDay(Date.now())].includes(DateTo));
  assert.ok([isoDay(before - 6 * day), isoDay(Date.now() - 6 * day)].includes(DateFrom));
});

test('direct_stats: a queued (201) and then building (202) report is asked for again with the same request until it is ready', async () => {
  route(/\/reports$/, (url, init, n) => (n === 0 ? queued(201) : n === 1 ? queued(202) : { raw: TSV }));
  const c = await connect('yandex-direct', ENV);
  const n = calls.length;
  const out = await callJson(c, 'direct_stats', ARGS);
  const sent = sentSince(n);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((x) => x.init.body === sent[0].init.body), 'identical parameters on every poll');
  assert.equal(out.rows.length, 2);
});

test('direct_stats: a report that stays unready is not an error — the agent is told to call again', async () => {
  route(/\/reports$/, queued(202));
  const c = await connect('yandex-direct', ENV);
  const n = calls.length;
  const r = await c.callTool({ name: 'direct_stats', arguments: ARGS });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /still building this report.*Call direct_stats again/);
  const polls = sentSince(n).length;
  assert.ok(polls >= 3 && polls <= 20, `a bounded number of polls (${polls})`);
});

test('direct_stats: an empty report says so; errors of the service are readable; a 5xx on a read is repeated', async () => {
  route(/\/reports$/, { raw: 'CampaignId\tCampaignName\tImpressions\tClicks\tCtr\tCost\tConversions\tCostPerConversion\nTotal rows: 0' });
  const c = await connect('yandex-direct', ENV);
  const empty = await callJson(c, 'direct_stats', ARGS);
  assert.deepEqual(empty.rows ?? [], []);
  route(/\/reports$/, { error: { request_id: '3', error_code: 4000, error_string: 'Неверные параметры', error_detail: 'DateFrom is greater than DateTo' } }, 400);
  const bad = await c.callTool({ name: 'direct_stats', arguments: { dateFrom: '2026-10-09', dateTo: '2026-10-01' } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /HTTP 400: Неверные параметры: DateFrom is greater than DateTo/);
  route(/\/reports$/, (url, init, n) => (n === 0 ? { status: 500, body: { error: { error_code: 1000, error_string: 'Внутренняя ошибка' } }, headers: { 'retry-after': '0' } } : { raw: TSV }));
  const n = calls.length;
  assert.equal((await callJson(c, 'direct_stats', ARGS)).rows.length, 2);
  assert.equal(sentSince(n).length, 2);
});

test('input is validated: dates are YYYY-MM-DD; not configured names DIRECT_TOKEN; the API url can be overridden', async () => {
  const c = await connect('yandex-direct', ENV);
  const n = calls.length;
  const bad = await c.callTool({ name: 'direct_stats', arguments: { dateFrom: 'yesterday' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  assert.equal(bad.isError, true);
  assert.equal(calls.length, n);
  const bare = await connect('yandex-direct', {});
  const r = await bare.callTool({ name: 'direct_campaigns', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /DIRECT_TOKEN/);
  assert.equal(calls.length, n);
  route(/proxy\.test/, { result: { Campaigns: [] } });
  await (await connect('yandex-direct', { ...ENV, DIRECT_API_URL: 'https://proxy.test/direct/' })).callTool({ name: 'direct_campaigns', arguments: {} });
  assert.equal(calls.at(-1).url, 'https://proxy.test/direct/campaigns');
});

test('hosted: x-direct-token and x-direct-client-login map into the env; bad values are refused', () => {
  assert.deepEqual(credentialsFor(SERVICES.direct, { 'x-direct-token': 'y0_AgAAAA-token', 'x-direct-client-login': 'client.login-1' }), { env: { DIRECT_TOKEN: 'y0_AgAAAA-token', DIRECT_CLIENT_LOGIN: 'client.login-1' } });
  assert.deepEqual(credentialsFor(SERVICES['yandex-direct'], { 'x-direct-token': 't' }), { env: { DIRECT_TOKEN: 't' } });
  assert.match(credentialsFor(SERVICES.direct, { 'x-direct-token': 'two words' }).error, /x-direct-token/);
  for (const bad of ['a b', 'a/b', '-lead', 'x'.repeat(101)]) assert.match(credentialsFor(SERVICES.direct, { 'x-direct-client-login': bad }).error, /x-direct-client-login/, bad);
});
