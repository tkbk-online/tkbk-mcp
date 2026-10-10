// Ozon Seller API. Seller cabinet → Settings → API keys. Headers `Client-Id` and `Api-Key`.
import { collectPages, isoDaysAgo, request, z } from '../core.mjs';

const OZON_URL = 'https://api-seller.ozon.ru';
const PRODUCTS_MAX = 1000;
const PRODUCTS_DEFAULT = 100;
const STOCKS_PAGE = 1000; // maximum page of /v4/product/info/stocks
const STOCKS_MAX = 1000;
const STOCKS_DEFAULT = 100;
const STOCKS_MAX_OFFER_IDS = 1000;
const POSTINGS_PAGE = 100; // maximum page of /v4/posting/fbs/list and /v3/posting/fbo/list
const POSTINGS_MAX = 500;
const POSTINGS_DEFAULT = 50;
const POSTINGS_DEFAULT_DAYS = 7;
/** FBS list v4 and FBO list v3: cursor pagination ({cursor, has_next, postings}), filter.statuses. */
const POSTING_LISTS = { fbs: '/v4/posting/fbs/list', fbo: '/v3/posting/fbo/list' };

const base = (env) => (env.OZON_API_URL || OZON_URL).replace(/\/+$/, '');
const auth = (env) => ({ 'Client-Id': env.OZON_CLIENT_ID, 'Api-Key': env.OZON_API_KEY });
/** Lists and info are reads sent as POST: network errors and 5xx may be retried. */
const read = (env, path, body) => request(`${base(env)}${path}`, { method: 'POST', headers: auth(env), body, idempotent: true });

/** Unit price of a posting product: "123.00" in older answers, {amount, currency} in v3/v4. */
const unitPrice = (price) => (price && typeof price === 'object' ? price.amount : price);

const postingOut = (p) => ({
  posting_number: p.posting_number,
  status: p.status,
  in_process_at: p.in_process_at,
  shipment_date: p.shipment_date,
  products: (p.products || []).map((x) => ({ offer_id: x.offer_id, name: x.name, quantity: x.quantity, price: unitPrice(x.price) })),
});

/** Postings of one scheme for a period, newest first; next — cursor of the following page. */
async function postings(env, scheme, { since, to, status, limit = POSTINGS_DEFAULT, cursor }) {
  const filter = { since: since || isoDaysAgo(POSTINGS_DEFAULT_DAYS), to: to || new Date().toISOString(), ...(status ? { statuses: [status] } : {}) };
  const { items, next } = await collectPages(async (c, size) => {
    const d = await read(env, POSTING_LISTS[scheme], { filter, limit: size, sort_dir: 'DESC', ...(c ? { cursor: c } : {}) });
    return { items: d?.postings, next: d?.has_next ? d.cursor : null };
  }, { limit, pageSize: POSTINGS_PAGE, cursor });
  return { postings: items.map(postingOut), ...(next ? { next } : {}) };
}

const postingsInput = (statuses) => ({
  since: z.string().optional().describe(`ISO datetime, default ${POSTINGS_DEFAULT_DAYS} days ago`),
  to: z.string().optional().describe('ISO datetime, default now'),
  status: z.string().optional().describe(`e.g. ${statuses}`),
  limit: z.number().int().min(1).max(POSTINGS_MAX).optional().describe(`Postings, default ${POSTINGS_DEFAULT}`),
  cursor: z.string().optional().describe('`next` of the previous call, to continue'),
});

export default {
  name: 'ozon',
  title: 'Ozon',
  env: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
  tools: [
    {
      name: 'ozon_products',
      description: 'List of products (product_id, offer_id, archived). Pass last_id from the previous answer for the next page.',
      input: { limit: z.number().int().min(1).max(PRODUCTS_MAX).optional(), last_id: z.string().optional() },
      maxItems: PRODUCTS_MAX,
      run: async ({ limit = PRODUCTS_DEFAULT, last_id = '' }, env) => {
        const d = await read(env, '/v3/product/list', { filter: { visibility: 'ALL' }, last_id, limit });
        return { items: d?.result?.items || [], last_id: d?.result?.last_id, total: d?.result?.total };
      },
    },
    {
      name: 'ozon_stocks',
      description: 'Stocks of products on FBS/rFBS warehouses (offer_id, present, reserved, by warehouse type). '
        + 'When next is returned, call again with cursor=next for more.',
      input: {
        offer_ids: z.array(z.string()).max(STOCKS_MAX_OFFER_IDS).optional(),
        limit: z.number().int().min(1).max(STOCKS_MAX).optional().describe(`Products, default ${STOCKS_DEFAULT}`),
        cursor: z.string().optional(),
      },
      maxItems: STOCKS_MAX,
      run: async ({ offer_ids, limit = STOCKS_DEFAULT, cursor }, env) => {
        const filter = offer_ids?.length ? { offer_id: offer_ids, visibility: 'ALL' } : { visibility: 'ALL' };
        const { items, next } = await collectPages(async (c, size) => {
          const d = await read(env, '/v4/product/info/stocks', { filter, limit: size, ...(c ? { cursor: c } : {}) });
          const got = d?.items || [];
          return { items: got, next: got.length === size ? d?.cursor : null };
        }, { limit, pageSize: STOCKS_PAGE, cursor });
        const out = items.map((i) => ({ offer_id: i.offer_id, product_id: i.product_id, stocks: (i.stocks || []).map((s) => ({ type: s.type, present: s.present, reserved: s.reserved })) }));
        return { items: out, ...(next ? { next } : {}) };
      },
    },
    {
      name: 'ozon_fbs_postings',
      description: 'FBS postings (orders from your warehouse) for a period, newest first: status, products, dates. '
        + 'When next is returned, call again with cursor=next for more.',
      input: postingsInput('awaiting_packaging, awaiting_deliver, delivering, delivered, cancelled'),
      maxItems: POSTINGS_MAX,
      run: (args, env) => postings(env, 'fbs', args),
    },
    {
      name: 'ozon_fbo_postings',
      description: 'FBO postings (orders shipped from Ozon warehouses) for a period, newest first: status, products, dates. '
        + 'When next is returned, call again with cursor=next for more.',
      input: postingsInput('awaiting_packaging, awaiting_deliver, delivering, delivered, cancelled'),
      maxItems: POSTINGS_MAX,
      run: (args, env) => postings(env, 'fbo', args),
    },
    {
      name: 'ozon_update_price',
      description: 'Set a new price for a product (offer_id).',
      write: true,
      input: { offer_id: z.string(), price: z.string().describe('New price, e.g. "1490"'), old_price: z.string().optional() },
      run: async ({ offer_id, price, old_price }, env) => {
        const d = await request(`${base(env)}/v1/product/import/prices`, { method: 'POST', headers: auth(env), body: { prices: [{ offer_id, price, old_price: old_price || '0', currency_code: 'RUB' }] } });
        return d?.result || d;
      },
    },
  ],
};
