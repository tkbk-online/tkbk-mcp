import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('every service lists its tools with descriptions', async () => {
  for (const name of ['wb', 'ozon', 'yandex-market', 'bitrix24', 'amocrm', 'avito', 'dadata']) {
    const c = await connect(name, {});
    const { tools } = await c.listTools();
    assert.ok(tools.length >= 2, name);
    for (const t of tools) assert.ok(t.description.length > 20, `${name}/${t.name}`);
  }
});

test('the server reports the package version', async () => {
  const c = await connect('wb', {});
  assert.deepEqual(c.getServerVersion(), { name: 'tkbk-wildberries', version: pkg.version });
});

test('not configured → clear message, no request', async () => {
  const c = await connect('wb', {});
  const before = calls.length;
  const r = await c.callTool({ name: 'wb_new_orders', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /WB_TOKEN/);
  assert.equal(calls.length, before);
});

test('wildberries: orders use the token header, output is compact', async () => {
  route(/orders\/new/, { orders: [{ id: 1, article: 'A-1', nmId: 5, convertedPrice: 149000, warehouseId: 7, createdAt: '2026-10-10', extra: null }] });
  const c = await connect('wb', { WB_TOKEN: 'tok' });
  const r = await c.callTool({ name: 'wb_new_orders', arguments: {} });
  const out = JSON.parse(textOf(r));
  assert.deepEqual(out[0], { id: 1, article: 'A-1', nmId: 5, price: 1490, warehouseId: 7, createdAt: '2026-10-10' });
  assert.equal(calls.at(-1).init.headers.Authorization, 'tok');
});

test('write tools require confirm=true', async () => {
  const c = await connect('wb', { WB_TOKEN: 'tok' });
  const before = calls.length;
  const r = await c.callTool({ name: 'wb_answer_feedback', arguments: { id: 'f1', text: 'Спасибо!' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /confirm=true/);
  assert.equal(calls.length, before, 'nothing sent without confirmation');
  route(/feedbacks\/answer/, {});
  const ok = await c.callTool({ name: 'wb_answer_feedback', arguments: { id: 'f1', text: 'Спасибо!', confirm: true } });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { id: 'f1', text: 'Спасибо!' });
});

test('ozon: Client-Id and Api-Key headers; API errors are readable', async () => {
  route(/v3\/product\/list/, { message: 'Invalid Api-Key' }, 403);
  const c = await connect('ozon', { OZON_CLIENT_ID: '1', OZON_API_KEY: 'k' });
  const r = await c.callTool({ name: 'ozon_products', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 403: Invalid Api-Key/);
  assert.equal(calls.at(-1).init.headers['Client-Id'], '1');
});

test('bitrix24: webhook method url', async () => {
  route(/crm\.lead\.list\.json/, { result: [{ ID: '1', TITLE: 'Заявка' }] });
  const c = await connect('bitrix24', { BITRIX24_WEBHOOK_URL: 'https://x.bitrix24.ru/rest/1/abc/' });
  const r = await c.callTool({ name: 'b24_leads', arguments: { limit: 5 } });
  assert.deepEqual(JSON.parse(textOf(r)), [{ ID: '1', TITLE: 'Заявка' }]);
  assert.equal(calls.at(-1).url, 'https://x.bitrix24.ru/rest/1/abc/crm.lead.list.json');
});

test('amocrm and yandex market: auth headers', async () => {
  route(/api\/v4\/leads/, { _embedded: { leads: [{ id: 3, name: 'Сделка', price: 100, status_id: 1, pipeline_id: 2, created_at: 1791600000 }] } });
  const a = await connect('amocrm', { AMOCRM_DOMAIN: 'shop.amocrm.ru', AMOCRM_TOKEN: 't' });
  const r = await a.callTool({ name: 'amo_leads', arguments: {} });
  assert.equal(JSON.parse(textOf(r))[0].name, 'Сделка');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer t');
  assert.match(calls.at(-1).url, /order%5Bcreated_at%5D=desc/);
  route(/\/v2\/campaigns\?/, { campaigns: [{ id: 9, domain: 'shop', business: { id: 8 }, placementType: 'FBS' }], paging: {} });
  const y = await connect('yandex-market', { YM_API_KEY: 'ym' });
  const yr = await y.callTool({ name: 'ym_campaigns', arguments: {} });
  assert.deepEqual(JSON.parse(textOf(yr))[0], { id: 9, domain: 'shop', businessId: 8, placementType: 'FBS' });
  assert.equal(calls.at(-1).init.headers['Api-Key'], 'ym');
});
