import test from 'node:test';
import assert from 'node:assert/strict';
import { anySubscription, createSiteAccess } from '../src/hosted/auth.mjs';

const KEY = `cr_${'a'.repeat(32)}`;
const ID = 'b'.repeat(64);

function fakeSite(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test('site access: sends the key with the secret, caches an active answer', async () => {
  let t = 0;
  const site = fakeSite([{ body: { ok: true, active: true, until: new Date(10 * 60_000).toISOString() } }]);
  const access = createSiteAccess({ url: 'https://tkbk.online/api/mcp/access', secret: 's'.repeat(32), fetchImpl: site.fetchImpl, now: () => t });
  assert.equal(await access.isSubscribed(ID, KEY), true);
  assert.equal(site.calls[0].init.headers['x-mcp-secret'], 's'.repeat(32));
  assert.deepEqual(JSON.parse(site.calls[0].init.body), { key: KEY });
  t = 60_000;
  assert.equal(await access.isSubscribed(ID, KEY), true);
  assert.equal(site.calls.length, 1, 'cached');
});

test('site access: an inactive answer is re-asked after a minute (a fresh purchase works)', async () => {
  let t = 0;
  const site = fakeSite([{ body: { ok: true, active: false, until: '' } }, { body: { ok: true, active: true, until: new Date(9e12).toISOString() } }]);
  const access = createSiteAccess({ url: 'https://x/a', secret: 's'.repeat(32), fetchImpl: site.fetchImpl, now: () => t });
  assert.equal(await access.isSubscribed(ID, KEY), false);
  t = 30_000;
  assert.equal(await access.isSubscribed(ID, KEY), false);
  t = 61_000;
  assert.equal(await access.isSubscribed(ID, KEY), true);
  assert.equal(site.calls.length, 2);
});

test('site access: the cache never outlives the paid end date', async () => {
  let t = 0;
  const site = fakeSite([{ body: { ok: true, active: true, until: new Date(1000).toISOString() } }, { body: { ok: true, active: false, until: '' } }]);
  const access = createSiteAccess({ url: 'https://x/a', secret: 's'.repeat(32), fetchImpl: site.fetchImpl, now: () => t });
  assert.equal(await access.isSubscribed(ID, KEY), true);
  t = 2000;
  assert.equal(await access.isSubscribed(ID, KEY), false);
});

test('site access: site down → stale active stays active, unknown key throws', async () => {
  let t = 0;
  const site = fakeSite([{ body: { ok: true, active: true, until: '' } }, new Error('down'), { status: 503, body: { ok: false } }]);
  const access = createSiteAccess({ url: 'https://x/a', secret: 's'.repeat(32), fetchImpl: site.fetchImpl, now: () => t });
  assert.equal(await access.isSubscribed(ID, KEY), true);
  t = 6 * 60_000;
  assert.equal(await access.isSubscribed(ID, KEY), true, 'stale while the site is down');
  await assert.rejects(access.isSubscribed('c'.repeat(64), `cr_${'c'.repeat(32)}`));
});

test('anySubscription: allow-list first, then the site; a failure only matters when nobody says yes', async () => {
  const yes = async () => true;
  const no = async () => false;
  const boom = async () => { throw new Error('down'); };
  assert.equal(await anySubscription(yes, boom)(ID, KEY), true);
  assert.equal(await anySubscription(no, yes)(ID, KEY), true);
  assert.equal(await anySubscription(no, no)(ID, KEY), false);
  await assert.rejects(anySubscription(no, boom)(ID, KEY));
});
