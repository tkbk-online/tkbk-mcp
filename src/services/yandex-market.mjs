// Yandex Market Partner API. Partner cabinet → Settings → API and modules → API-key token. Header `Api-Key`.
// YM_BUSINESS_ID (optional) — cabinet id for orders and offers; without it the cabinet of the token's stores is used.
import { collectPages, DAY_MS, request, z } from '../core.mjs';

const YM_URL = 'https://api.partner.market.yandex.ru';
const CAMPAIGNS_PAGE = 100; // maximum of GET /v2/campaigns (page/pageSize were switched off on 05.10.2026)
const CAMPAIGNS_MAX = 500;
const ORDERS_PAGE = 50; // maximum of POST /v1/businesses/{businessId}/orders
const ORDERS_MAX = 500;
const ORDERS_DEFAULT = 50;
const ORDERS_MAX_DAYS = 30; // longest period of one orders request
const ORDERS_DEFAULT_DAYS = 7;
const OFFERS_PAGE = 100; // maximum of POST /v2/businesses/{businessId}/offer-mappings
const OFFERS_MAX = 500;
const OFFERS_DEFAULT = 50;
const ISO_DATE_LENGTH = 10;

const base = (env) => (env.YM_API_URL || YM_URL).replace(/\/+$/, '');
const auth = (env) => ({ 'Api-Key': env.YM_API_KEY });
const query = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
  return q.size ? `?${q}` : '';
};
const get = (env, path, params = {}) => request(`${base(env)}${path}${query(params)}`, { headers: auth(env) });
/** Lists sent as POST are reads: network errors and 5xx may be retried. */
const list = (env, path, params, body) => request(`${base(env)}${path}${query(params)}`, { method: 'POST', headers: auth(env), body, idempotent: true });
const isoDate = (ms) => new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH);
const money = (price) => price?.value;

/** Cabinet id: the argument, YM_BUSINESS_ID, or the cabinet of the token's stores (an Api-Key token belongs to one cabinet). */
async function businessIdOf(env, explicit) {
  if (explicit) return explicit;
  if (env.YM_BUSINESS_ID) return Number(env.YM_BUSINESS_ID);
  const d = await get(env, '/v2/campaigns', { limit: 1 });
  const id = d?.campaigns?.[0]?.business?.id;
  if (!id) throw new Error('No stores found for this API key: pass businessId (see ym_campaigns).');
  return id;
}

const orderOut = (o) => ({
  id: o.orderId ?? o.id,
  campaignId: o.campaignId,
  programType: o.programType,
  status: o.status,
  substatus: o.substatus,
  creationDate: o.creationDate,
  payment: money(o.prices?.payment),
  items: (o.items || []).map((i) => ({ offerId: i.offerId, name: i.offerName, count: i.count, payment: money(i.prices?.payment) })),
});

const businessIdInput = z.number().int().min(1).optional().describe('Cabinet id; default — YM_BUSINESS_ID or the cabinet of the API key');
const pageTokenInput = z.string().optional().describe('`next` of the previous call, to continue');

export default {
  name: 'yandex-market',
  title: 'Yandex Market',
  env: ['YM_API_KEY'],
  optionalEnv: ['YM_BUSINESS_ID'],
  tools: [
    {
      name: 'ym_campaigns',
      description: 'Your stores (campaigns): id, cabinet (business) id, placement type (FBS, FBY, DBS).',
      input: {},
      maxItems: CAMPAIGNS_MAX,
      run: async (_, env) => {
        const { items } = await collectPages(async (cursor, size) => {
          const d = await get(env, '/v2/campaigns', { limit: size, pageToken: cursor });
          return { items: d?.campaigns, next: d?.paging?.nextPageToken };
        }, { limit: CAMPAIGNS_MAX, pageSize: CAMPAIGNS_PAGE });
        return items.map((c) => ({ id: c.id, domain: c.domain, businessId: c.business?.id, placementType: c.placementType, apiAvailability: c.apiAvailability }));
      },
    },
    {
      name: 'ym_orders',
      description: 'Real (not test) orders of all stores of the cabinet created in the last days: id, store, status, substatus, items, payment. '
        + 'When next is returned, call again with pageToken=next for more.',
      input: {
        businessId: businessIdInput,
        campaignId: z.number().int().min(1).optional().describe('Only this store (id from ym_campaigns)'),
        status: z.string().optional().describe('e.g. PROCESSING, DELIVERY, DELIVERED, CANCELLED'),
        days: z.number().int().min(1).max(ORDERS_MAX_DAYS).optional().describe(`Created in the last N days, default ${ORDERS_DEFAULT_DAYS}`),
        limit: z.number().int().min(1).max(ORDERS_MAX).optional().describe(`Orders, default ${ORDERS_DEFAULT}`),
        pageToken: pageTokenInput,
      },
      maxItems: ORDERS_MAX,
      run: async ({ businessId, campaignId, status, days = ORDERS_DEFAULT_DAYS, limit = ORDERS_DEFAULT, pageToken }, env) => {
        const id = await businessIdOf(env, businessId);
        const now = Date.now();
        const body = {
          dates: { creationDateFrom: isoDate(now - (days - 1) * DAY_MS), creationDateTo: isoDate(now) },
          fake: false,
          ...(campaignId ? { campaignIds: [campaignId] } : {}),
          ...(status ? { statuses: [status] } : {}),
        };
        const { items, next } = await collectPages(async (cursor, size) => {
          const d = await list(env, `/v1/businesses/${id}/orders`, { limit: size, pageToken: cursor }, body);
          return { items: d?.orders, next: d?.paging?.nextPageToken };
        }, { limit, pageSize: ORDERS_PAGE, cursor: pageToken });
        return { orders: items.map(orderOut), ...(next ? { next } : {}) };
      },
    },
    {
      name: 'ym_offers',
      description: 'Catalog offers of the cabinet (offerId, name, price, card status, market SKU). '
        + 'When next is returned, call again with pageToken=next for more.',
      input: {
        businessId: businessIdInput,
        limit: z.number().int().min(1).max(OFFERS_MAX).optional().describe(`Offers, default ${OFFERS_DEFAULT}`),
        pageToken: pageTokenInput,
      },
      maxItems: OFFERS_MAX,
      run: async ({ businessId, limit = OFFERS_DEFAULT, pageToken }, env) => {
        const id = await businessIdOf(env, businessId);
        const { items, next } = await collectPages(async (cursor, size) => {
          const d = await list(env, `/v2/businesses/${id}/offer-mappings`, { limit: size, pageToken: cursor }, {});
          return { items: d?.result?.offerMappings, next: d?.result?.paging?.nextPageToken };
        }, { limit, pageSize: OFFERS_PAGE, cursor: pageToken });
        const offers = items.map((m) => ({ offerId: m.offer?.offerId, name: m.offer?.name, price: money(m.offer?.basicPrice), cardStatus: m.offer?.cardStatus, marketSku: m.mapping?.marketSku }));
        return { offers, ...(next ? { next } : {}) };
      },
    },
  ],
};
