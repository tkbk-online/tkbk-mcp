// Avito: OAuth token, chats, messages, sending, own listings (fetch is mocked, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialsFor } from '../src/hosted/credentials.mjs';
import { SERVICES } from '../src/index.mjs';
import { callJson, connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
/** A fresh env per connection: tokens are cached per env object (stdio: the process, hosted: one request). */
const fresh = () => ({ AVITO_CLIENT_ID: 'cid-1', AVITO_CLIENT_SECRET: 'sec-1' });
const API = 'https://api.avito.ru';
const sentSince = (n) => calls.slice(n);
const countOf = (n, pattern) => sentSince(n).filter((c) => pattern.test(c.url)).length;

/** Token endpoint and the account of the seller (id 42). */
function stubAccount() {
  route(/\/token$/, { access_token: 'tok-1', expires_in: 86_400, token_type: 'Bearer' });
  route(/\/core\/v1\/accounts\/self$/, { id: 42, name: 'Shop', email: 'shop@example.com' });
}

const CHATS = {
  chats: [
    {
      id: 'u2i-1', created: 1700000000, updated: 1700000100,
      context: { type: 'item', value: { id: 777, title: 'Велосипед', price_string: '15 000 ₽', url: 'https://www.avito.ru/777', status_id: 10, user_id: 42, images: { count: 3 } } },
      last_message: { id: 'm1', author_id: 99, direction: 'in', type: 'text', created: 1700000050, content: { text: 'Ещё продаётся?' } },
      users: [{ id: 42, name: 'Shop' }, { id: 99, name: 'Иван' }],
    },
    { id: 'u2i-2', updated: 1700000200, users: [{ id: 99, name: 'Иван' }, { id: 42, name: 'Shop' }], last_message: { direction: 'out', type: 'image', created: 1700000200 } },
  ],
};

test('token: POST /token as a form with the client credentials; the bearer token is reused by the next call', async () => {
  stubAccount();
  route(/\/core\/v1\/items\?/, { meta: { page: 1, per_page: 25 }, resources: [] });
  const c = await connect('avito', fresh());
  const n = calls.length;
  await c.callTool({ name: 'avito_items', arguments: {} });
  await c.callTool({ name: 'avito_items', arguments: {} });
  const sent = sentSince(n);
  const [tokenCall] = sent;
  assert.equal(tokenCall.url, `${API}/token`);
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(tokenCall.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCall.init.body)), { grant_type: 'client_credentials', client_id: 'cid-1', client_secret: 'sec-1' });
  assert.equal(countOf(n, /\/token$/), 1, 'one token serves both calls');
  assert.ok(sent.slice(1).every((x) => x.init.headers.Authorization === 'Bearer tok-1'));
});

test('avito_chats: account id once, unread filter and types in the query, the other person and the last message are mapped', async () => {
  stubAccount();
  route(/\/messenger\/v2\/accounts\/42\/chats\?/, CHATS);
  const c = await connect('avito', fresh());
  const n = calls.length;
  const out = await callJson(c, 'avito_chats', { unreadOnly: true, chatTypes: ['u2i', 'u2u'], itemId: 777, limit: 2 });
  const chatCall = sentSince(n).find((x) => x.url.includes('/chats?'));
  const q = new URL(chatCall.url).searchParams;
  assert.deepEqual([q.get('unread_only'), q.get('chat_types'), q.get('item_ids'), q.get('limit'), q.get('offset')], ['true', 'u2i,u2u', '777', '2', '0']);
  assert.equal(chatCall.init.headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(out.chats[0], {
    id: 'u2i-1', with: { id: 99, name: 'Иван' },
    item: { id: 777, title: 'Велосипед', price: '15 000 ₽', url: 'https://www.avito.ru/777' },
    last: { direction: 'in', type: 'text', text: 'Ещё продаётся?', at: '2023-11-14T22:14:10.000Z' }, updatedAt: '2023-11-14T22:15:00.000Z',
  });
  assert.deepEqual(out.chats[1].last, { direction: 'out', type: 'image', at: '2023-11-14T22:16:40.000Z' });
  assert.equal(out.nextOffset, 2, 'a full page: ask again from offset 2');
  const short = await callJson(c, 'avito_chats', { limit: 5, offset: 10 });
  assert.equal(short.nextOffset, undefined, 'a short page is the last one');
  const capped = await callJson(c, 'avito_chats', { limit: 2, offset: 999 });
  assert.equal(capped.nextOffset, undefined, 'Avito serves offsets up to 1000');
  assert.equal(countOf(n, /\/accounts\/self$/), 1, 'the account id is looked up once');
  const plain = sentSince(n).filter((x) => x.url.includes('/chats?')).at(-1);
  assert.equal(new URL(plain.url).searchParams.has('unread_only'), false, 'no filter unless asked');
});

test('avito_messages: the chat id is path-encoded, messages are mapped, a full page gives nextOffset', async () => {
  stubAccount();
  route(/\/messenger\/v3\/accounts\/42\/chats\/.*\/messages\/\?/, [
    { id: 'm2', author_id: 42, direction: 'out', type: 'text', created: 1700000100, is_read: true, content: { text: 'Да, продаётся' } },
    { id: 'm1', author_id: 99, direction: 'in', type: 'link', created: 1700000050, is_read: false, content: { link: { text: 'https://example.com', url: 'https://example.com' } } },
  ]);
  const c = await connect('avito', fresh());
  const n = calls.length;
  const out = await callJson(c, 'avito_messages', { chatId: 'u2i-a/b c', limit: 2 });
  const call = sentSince(n).find((x) => x.url.includes('/messages/'));
  assert.equal(new URL(call.url).pathname, '/messenger/v3/accounts/42/chats/u2i-a%2Fb%20c/messages/');
  assert.equal(new URL(call.url).searchParams.get('limit'), '2');
  assert.deepEqual(out.messages, [
    { id: 'm2', direction: 'out', author: 42, type: 'text', text: 'Да, продаётся', at: '2023-11-14T22:15:00.000Z', read: true },
    { id: 'm1', direction: 'in', author: 99, type: 'link', text: 'https://example.com', at: '2023-11-14T22:14:10.000Z', read: false },
  ]);
  assert.equal(out.nextOffset, 2);
});

test('avito_send_message: nothing is sent without confirm=true; with it one POST that is not repeated after a 5xx', async () => {
  stubAccount();
  route(/\/messenger\/v1\/accounts\/42\/chats\/u2i-1\/messages$/, { id: 'm9', type: 'text', direction: 'out', created: 1700000300, content: { text: 'Здравствуйте!' } });
  const c = await connect('avito', fresh());
  const n = calls.length;
  const denied = await c.callTool({ name: 'avito_send_message', arguments: { chatId: 'u2i-1', text: 'Здравствуйте!' } });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /confirm=true/);
  assert.equal(calls.length, n, 'not even a token is requested');
  const ok = await c.callTool({ name: 'avito_send_message', arguments: { chatId: 'u2i-1', text: 'Здравствуйте!', confirm: true } });
  assert.equal(textOf(ok), 'Message sent to chat u2i-1, message id m9.');
  const post = calls.at(-1);
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { message: { text: 'Здравствуйте!' }, type: 'text' });
  assert.equal(post.init.headers.Authorization, 'Bearer tok-1');
  route(/\/messenger\/v1\/accounts\/42\/chats\/u2i-2\/messages$/, { error: { code: 503, message: 'busy' } }, 503);
  const m = calls.length;
  const failed = await c.callTool({ name: 'avito_send_message', arguments: { chatId: 'u2i-2', text: 'Привет', confirm: true } });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /HTTP 503: busy/);
  assert.equal(sentSince(m).filter((x) => x.init.method === 'POST').length, 1, 'a write may have gone through: not repeated');
});

test('avito_items: query parameters, mapping, next page only after a full page', async () => {
  stubAccount();
  route(/\/core\/v1\/items\?/, {
    meta: { page: 2, per_page: 2 },
    resources: [
      { id: 1, title: 'Велосипед', price: 15000, status: 'active', category: { id: 5, name: 'Велосипеды' }, address: 'Москва', url: 'https://www.avito.ru/1' },
      { id: 2, title: 'Самокат', price: 3000, status: 'blocked', category: { id: 6, name: 'Самокаты' }, url: 'https://www.avito.ru/2' },
    ],
  });
  const c = await connect('avito', fresh());
  const n = calls.length;
  const out = await callJson(c, 'avito_items', { status: ['active', 'blocked'], category: 5, updatedFrom: '2026-10-01', limit: 2, page: 2 });
  const q = new URL(sentSince(n).find((x) => x.url.includes('/core/v1/items')).url).searchParams;
  assert.deepEqual(Object.fromEntries(q), { per_page: '2', page: '2', status: 'active,blocked', category: '5', updatedAtFrom: '2026-10-01' });
  assert.deepEqual(out.items[0], { id: 1, title: 'Велосипед', price: 15000, status: 'active', category: 'Велосипеды', address: 'Москва', url: 'https://www.avito.ru/1' });
  assert.equal(out.next, 3, 'a full page: ask again with page=3');
  assert.equal((await callJson(c, 'avito_items', { limit: 5 })).next, undefined, 'a short page is the last one');
  const bad = await c.callTool({ name: 'avito_items', arguments: { updatedFrom: 'yesterday' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  assert.equal(bad.isError, true);
});

test('a 401 refreshes the token once and repeats the call; a second 401 is reported', async () => {
  let issued = 0;
  route(/\/token$/, () => ({ access_token: `tok-${++issued}`, expires_in: 86_400 }));
  route(/\/core\/v1\/items\?/, (url, init) => (init.headers.Authorization === 'Bearer tok-2'
    ? { resources: [{ id: 1, title: 'A', price: 1, status: 'active' }] }
    : { status: 401, body: { error: { code: 401, message: 'access token expired' } } }));
  const c = await connect('avito', fresh());
  assert.equal((await callJson(c, 'avito_items')).items[0].id, 1);
  assert.equal(issued, 2);
  route(/\/core\/v1\/items\?/, { error: { code: 401, message: 'Unauthorized' } }, 401);
  const n = calls.length;
  const d = await connect('avito', fresh());
  const r = await d.callTool({ name: 'avito_items', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 401: Unauthorized/);
  assert.equal(countOf(n, /\/core\/v1\/items\?/), 2, 'one repeat with a fresh token, then the error');
});

test('a token about to expire is replaced before the next call; env objects do not share tokens', async () => {
  let issued = 0;
  route(/\/token$/, () => ({ access_token: `short-${++issued}`, expires_in: 30 }));
  route(/\/core\/v1\/items\?/, { resources: [] });
  const c = await connect('avito', fresh());
  await c.callTool({ name: 'avito_items', arguments: {} });
  await c.callTool({ name: 'avito_items', arguments: {} });
  assert.equal(issued, 2, 'a 30 s token is inside the refresh margin');
  issued = 0;
  route(/\/token$/, () => ({ access_token: `day-${++issued}`, expires_in: 86_400 }));
  await (await connect('avito', fresh())).callTool({ name: 'avito_items', arguments: {} });
  await (await connect('avito', fresh())).callTool({ name: 'avito_items', arguments: {} });
  assert.equal(issued, 2, 'each env object (hosted: each request) gets its own token');
});

test('token errors are readable: a rejected client, an answer without a token', async () => {
  route(/\/token$/, { error: 'invalid_client', error_description: 'Client not found' }, 401);
  const c = await connect('avito', fresh());
  const r = await c.callTool({ name: 'avito_items', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 401: Client not found/);
  route(/\/token$/, { token_type: 'Bearer' });
  const d = await connect('avito', fresh());
  const no = await d.callTool({ name: 'avito_items', arguments: {} });
  assert.match(textOf(no), /AVITO_CLIENT_ID and AVITO_CLIENT_SECRET/);
});

test('429 is repeated after Retry-After; not configured names both variables; the API url can be overridden', async () => {
  stubAccount();
  route(/\/core\/v1\/items\?/, (url, init, n) => (n === 0
    ? { status: 429, body: { message: 'Too many requests' }, headers: { 'retry-after': '0' } }
    : { resources: [{ id: 1, title: 'A', price: 1, status: 'active' }] }));
  const c = await connect('avito', fresh());
  const n = calls.length;
  assert.equal((await callJson(c, 'avito_items')).items[0].id, 1);
  assert.equal(countOf(n, /\/core\/v1\/items\?/), 2);
  const bare = await connect('avito', {});
  const m = calls.length;
  const r = await bare.callTool({ name: 'avito_chats', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /AVITO_CLIENT_ID, AVITO_CLIENT_SECRET/);
  assert.equal(calls.length, m);
  route(/proxy\.test\/avito\/token$/, { access_token: 'p', expires_in: 3600 });
  route(/proxy\.test\/avito\/core\/v1\/items\?/, { resources: [] });
  await (await connect('avito', { ...fresh(), AVITO_API_URL: 'https://proxy.test/avito/' })).callTool({ name: 'avito_items', arguments: {} });
  assert.equal(calls.at(-1).url.startsWith('https://proxy.test/avito/core/v1/items?'), true);
});

test('hosted: x-avito-client-id and x-avito-client-secret map into the env; bad values are refused', () => {
  assert.deepEqual(credentialsFor(SERVICES.avito, { 'x-avito-client-id': 'cid_1-A', 'x-avito-client-secret': 's3cr3t' }), { env: { AVITO_CLIENT_ID: 'cid_1-A', AVITO_CLIENT_SECRET: 's3cr3t' } });
  assert.match(credentialsFor(SERVICES.avito, { 'x-avito-client-id': 'two words' }).error, /x-avito-client-id/);
  assert.match(credentialsFor(SERVICES.avito, { 'x-avito-client-secret': 'a\tb' }).error, /x-avito-client-secret/);
});
