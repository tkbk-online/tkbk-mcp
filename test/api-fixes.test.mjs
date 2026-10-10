// Marketplace API changes of 2026: WB stocks report, Yandex Market business orders and v2 lists, Ozon FBS v4 / FBO v3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callJson, connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const DAY_MS = 86_400_000;
const after = (n) => calls.slice(n);
const bodyOf = (call) => JSON.parse(call.init.body);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const OZON = { OZON_CLIENT_ID: '1', OZON_API_KEY: 'k' };
const posting = (number) => ({
  posting_number: number, status: 'awaiting_packaging', in_process_at: '2026-10-10T10:00:00Z',
  products: [{ offer_id: 'A', name: 'Чехол', quantity: 2, price: { amount: '500.00', currency: 'RUB' } }],
});
const ymOrder = (id) => ({
  orderId: id, campaignId: 11, status: 'PROCESSING', creationDate: '2026-10-10T12:00:00+03:00', fake: false,
  prices: { payment: { value: 900, currencyId: 'RUR' } },
  items: [{ id: 1, offerId: 'A', offerName: 'Кружка', count: 2, prices: { payment: { value: 900 } } }],
});

test('wb_stocks: POST to the analytics stocks report, never the switched-off /api/v1/supplier/stocks', async () => {
  route(/stocks-report\/wb-warehouses/, (url, init) => ({
    data: { items: Array.from({ length: bodyOf({ init }).limit }, (_, i) => ({ nmId: 100 + i, chrtId: 7, warehouseName: 'Коледино', regionName: 'Центральный', quantity: 5, inWayToClient: 1, inWayFromClient: 0 })) },
  }));
  const c = await connect('wb', { WB_TOKEN: 'tok' });
  const n = calls.length;
  const out = await callJson(c, 'wb_stocks', { nmIds: [100, 101], limit: 2, offset: 4 });
  const [call] = after(n);
  assert.equal(call.url, 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'tok');
  assert.deepEqual(bodyOf(call), { nmIds: [100, 101], limit: 2, offset: 4 });
  assert.deepEqual(out.items[0], { nmId: 100, chrtId: 7, warehouse: 'Коледино', region: 'Центральный', quantity: 5, inWayToClient: 1, inWayFromClient: 0 });
  assert.equal(out.nextOffset, 6, 'a full page: call again from offset 6');
  assert.ok(!calls.some((x) => x.url.includes('/api/v1/supplier/stocks')));
});

test('wb_stocks: seller warehouses; a short page has no nextOffset; 429 + X-Ratelimit-Retry is repeated', async () => {
  route(/stocks-report\/seller-warehouses/, (url, init, n) => (n === 0
    ? { status: 429, body: { title: 'too many requests' }, headers: { 'x-ratelimit-retry': '0' } }
    : { data: { items: [{ nmId: 1, warehouseName: 'Мой склад', quantity: 3 }] } }));
  const c = await connect('wb', { WB_TOKEN: 'tok' });
  const n = calls.length;
  const out = await callJson(c, 'wb_stocks', { warehouses: 'seller' });
  assert.deepEqual(out, { items: [{ nmId: 1, warehouse: 'Мой склад', quantity: 3 }] });
  assert.equal(after(n).length, 2);
  assert.deepEqual(bodyOf(calls.at(-1)), { limit: 100, offset: 0 });
});

test('ozon_fbs_postings: /v4/posting/fbs/list, statuses filter, follows cursor while has_next', async () => {
  route(/\/v4\/posting\/fbs\/list$/, (url, init) => (bodyOf({ init }).cursor
    ? { postings: [posting('P-3')], cursor: '', has_next: false }
    : { postings: [posting('P-1'), posting('P-2')], cursor: 'c2', has_next: true }));
  const c = await connect('ozon', OZON);
  const n = calls.length;
  const out = await callJson(c, 'ozon_fbs_postings', { status: 'awaiting_packaging', since: '2026-10-01T00:00:00Z', to: '2026-10-11T00:00:00Z' });
  const bodies = after(n).map(bodyOf);
  assert.deepEqual(bodies[0], { filter: { since: '2026-10-01T00:00:00Z', to: '2026-10-11T00:00:00Z', statuses: ['awaiting_packaging'] }, limit: 50, sort_dir: 'DESC' });
  assert.equal(bodies[1].cursor, 'c2');
  assert.equal(bodies[1].limit, 48, 'only the missing postings are asked for');
  assert.deepEqual(out.postings.map((p) => p.posting_number), ['P-1', 'P-2', 'P-3']);
  assert.deepEqual(out.postings[0].products[0], { offer_id: 'A', name: 'Чехол', quantity: 2, price: '500.00' });
  assert.equal(out.next, undefined);
  assert.ok(!calls.some((x) => x.url.includes('/v3/posting/fbs/list')));
});

test('ozon_fbs_postings: limit reached → next to continue; ozon_fbo_postings uses /v3/posting/fbo/list', async () => {
  route(/\/v4\/posting\/fbs\/list$/, { postings: [posting('P-9')], cursor: 'more', has_next: true });
  route(/\/v3\/posting\/fbo\/list$/, { postings: [posting('F-1')], cursor: '', has_next: false });
  const c = await connect('ozon', OZON);
  assert.equal((await callJson(c, 'ozon_fbs_postings', { limit: 1 })).next, 'more');
  const n = calls.length;
  const fbo = await callJson(c, 'ozon_fbo_postings', { cursor: 'abc', status: 'delivered' });
  const [call] = after(n);
  assert.equal(call.url, 'https://api-seller.ozon.ru/v3/posting/fbo/list');
  assert.equal(call.init.headers['Api-Key'], 'k');
  assert.equal(bodyOf(call).cursor, 'abc');
  assert.deepEqual(bodyOf(call).filter.statuses, ['delivered']);
  assert.deepEqual(fbo.postings.map((p) => p.posting_number), ['F-1']);
});

test('ozon_stocks: /v4/product/info/stocks, a full page gives the cursor to continue', async () => {
  route(/\/v4\/product\/info\/stocks$/, { items: [{ offer_id: 'A', product_id: 1, stocks: [{ type: 'fbs', present: 4, reserved: 1 }] }, { offer_id: 'B', product_id: 2 }], cursor: 'p2', total: 5 });
  const c = await connect('ozon', OZON);
  const out = await callJson(c, 'ozon_stocks', { limit: 2 });
  assert.equal(out.next, 'p2');
  assert.deepEqual(out.items[0], { offer_id: 'A', product_id: 1, stocks: [{ type: 'fbs', present: 4, reserved: 1 }] });
  await callJson(c, 'ozon_stocks', { limit: 2, cursor: 'p2' });
  assert.deepEqual(bodyOf(calls.at(-1)), { filter: { visibility: 'ALL' }, limit: 2, cursor: 'p2' });
});

test('ym_orders: POST /v1/businesses/{businessId}/orders, pageToken pages, filters in the body', async () => {
  route(/\/v1\/businesses\/77\/orders\?/, (url) => (new URL(url).searchParams.get('pageToken')
    ? { orders: [ymOrder(3)], paging: {} }
    : { orders: [ymOrder(1), ymOrder(2)], paging: { nextPageToken: 'T2' } }));
  const c = await connect('yandex-market', { YM_API_KEY: 'ym', YM_BUSINESS_ID: '77' });
  const n = calls.length;
  const out = await callJson(c, 'ym_orders', { status: 'PROCESSING', days: 3, campaignId: 11 });
  const sent = after(n);
  assert.equal(sent.length, 2);
  const first = new URL(sent[0].url);
  assert.equal(`${sent[0].init.method} ${first.pathname}`, 'POST /v1/businesses/77/orders');
  assert.equal(first.searchParams.get('limit'), '50');
  assert.equal(sent[0].init.headers['Api-Key'], 'ym');
  const now = Date.now();
  assert.deepEqual(bodyOf(sent[0]), {
    dates: { creationDateFrom: isoDate(now - 2 * DAY_MS), creationDateTo: isoDate(now) },
    fake: false, campaignIds: [11], statuses: ['PROCESSING'],
  });
  const second = new URL(sent[1].url);
  assert.equal(second.searchParams.get('pageToken'), 'T2');
  assert.equal(second.searchParams.get('limit'), '48');
  assert.deepEqual(out.orders.map((o) => o.id), [1, 2, 3]);
  assert.deepEqual(out.orders[0], {
    id: 1, campaignId: 11, status: 'PROCESSING', creationDate: '2026-10-10T12:00:00+03:00', payment: 900,
    items: [{ offerId: 'A', name: 'Кружка', count: 2, payment: 900 }],
  });
  assert.ok(!calls.some((x) => /\/campaigns\/\d+\/orders/.test(x.url)), 'the deprecated per-store orders method is not used');
});

test('ym_orders: no business id → the cabinet of the key from GET /v2/campaigns; 420 is retried', async () => {
  route(/\/v2\/campaigns\?/, { campaigns: [{ id: 11, business: { id: 99 } }], paging: {} });
  route(/\/v1\/businesses\/99\/orders\?/, (url, init, n) => (n === 0
    ? { status: 420, body: { status: 'ERROR', errors: [{ code: 'LIMIT_EXCEEDED', message: 'limit' }] }, headers: { 'retry-after': '0' } }
    : { orders: [], paging: {} }));
  const c = await connect('yandex-market', { YM_API_KEY: 'ym' });
  const n = calls.length;
  const r = await c.callTool({ name: 'ym_orders', arguments: {} });
  assert.equal(textOf(r), 'Nothing found.', 'an empty list is said plainly, not as {}');
  assert.deepEqual(after(n).map((x) => `${x.init.method} ${new URL(x.url).pathname}`), [
    'GET /v2/campaigns', 'POST /v1/businesses/99/orders', 'POST /v1/businesses/99/orders',
  ]);
});

test('ym_campaigns and ym_offers: v2 methods with pageToken', async () => {
  route(/\/v2\/campaigns\?/, (url) => (new URL(url).searchParams.get('pageToken')
    ? { campaigns: [{ id: 2, business: { id: 5 } }], paging: {} }
    : { campaigns: [{ id: 1, business: { id: 5 } }], paging: { nextPageToken: 'n2' } }));
  route(/\/v2\/businesses\/5\/offer-mappings\?/, { status: 'OK', result: { offerMappings: [{ offer: { offerId: 'A', name: 'Кружка', basicPrice: { value: 450 }, cardStatus: 'HAS_CARD_CAN_UPDATE' }, mapping: { marketSku: 123 } }], paging: { nextPageToken: 'o2' } } });
  const c = await connect('yandex-market', { YM_API_KEY: 'ym' });
  assert.deepEqual((await callJson(c, 'ym_campaigns')).map((x) => x.id), [1, 2]);
  assert.equal(new URL(calls.at(-1).url).searchParams.get('pageToken'), 'n2');
  const offers = await callJson(c, 'ym_offers', { businessId: 5, limit: 1 });
  assert.deepEqual(offers, { offers: [{ offerId: 'A', name: 'Кружка', price: 450, cardStatus: 'HAS_CARD_CAN_UPDATE', marketSku: 123 }], next: 'o2' });
  assert.equal(new URL(calls.at(-1).url).searchParams.get('limit'), '1');
});
