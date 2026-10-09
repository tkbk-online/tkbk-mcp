// Ozon Seller API. Seller cabinet → Settings → API keys. Headers `Client-Id` and `Api-Key`.
import { request, z } from '../core.mjs';

const base = (env) => (env.OZON_API_URL || 'https://api-seller.ozon.ru').replace(/\/+$/, '');
const auth = (env) => ({ 'Client-Id': env.OZON_CLIENT_ID, 'Api-Key': env.OZON_API_KEY });
const post = (env, path, body) => request(`${base(env)}${path}`, { method: 'POST', headers: auth(env), body });

export default {
  name: 'ozon',
  title: 'Ozon',
  env: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
  tools: [
    {
      name: 'ozon_products',
      description: 'List of products (product_id, offer_id, archived).',
      input: { limit: z.number().int().min(1).max(1000).optional(), last_id: z.string().optional() },
      run: async ({ limit = 100, last_id = '' }, env) => {
        const d = await post(env, '/v3/product/list', { filter: { visibility: 'ALL' }, last_id, limit });
        return { items: d?.result?.items || [], last_id: d?.result?.last_id, total: d?.result?.total };
      },
    },
    {
      name: 'ozon_stocks',
      description: 'Stocks of products (offer_id, present, reserved, by warehouse type).',
      input: { offer_ids: z.array(z.string()).max(1000).optional() },
      run: async ({ offer_ids }, env) => {
        const d = await post(env, '/v4/product/info/stocks', { filter: offer_ids?.length ? { offer_id: offer_ids, visibility: 'ALL' } : { visibility: 'ALL' }, limit: 1000, cursor: '' });
        return (d?.items || []).map((i) => ({ offer_id: i.offer_id, product_id: i.product_id, stocks: (i.stocks || []).map((s) => ({ type: s.type, present: s.present, reserved: s.reserved })) }));
      },
    },
    {
      name: 'ozon_fbs_postings',
      description: 'FBS postings (orders) for a period with status, products and dates.',
      input: { since: z.string().describe('ISO datetime').optional(), to: z.string().optional(), status: z.string().optional().describe('e.g. awaiting_packaging, awaiting_deliver') },
      run: async ({ since, to, status }, env) => {
        const d = await post(env, '/v3/posting/fbs/list', {
          dir: 'DESC',
          filter: { since: since || new Date(Date.now() - 7 * 86_400_000).toISOString(), to: to || new Date().toISOString(), ...(status ? { status } : {}) },
          limit: 100,
          offset: 0,
        });
        return (d?.result?.postings || []).map((p) => ({ posting_number: p.posting_number, status: p.status, in_process_at: p.in_process_at, products: (p.products || []).map((x) => ({ offer_id: x.offer_id, name: x.name, quantity: x.quantity, price: x.price })) }));
      },
    },
    {
      name: 'ozon_update_price',
      description: 'Set a new price for a product (offer_id).',
      write: true,
      input: { offer_id: z.string(), price: z.string().describe('New price, e.g. "1490"'), old_price: z.string().optional() },
      run: async ({ offer_id, price, old_price }, env) => {
        const d = await post(env, '/v1/product/import/prices', { prices: [{ offer_id, price, old_price: old_price || '0', currency_code: 'RUB' }] });
        return d?.result || d;
      },
    },
  ],
};
