// Yandex Market Partner API. Partner cabinet → Settings → API and modules → API-key. Header `Api-Key`.
import { request, z } from '../core.mjs';

const base = (env) => (env.YM_API_URL || 'https://api.partner.market.yandex.ru').replace(/\/+$/, '');
const auth = (env) => ({ 'Api-Key': env.YM_API_KEY });

export default {
  name: 'yandex-market',
  title: 'Yandex Market',
  env: ['YM_API_KEY'],
  tools: [
    {
      name: 'ym_campaigns',
      description: 'Your stores (campaigns): id, business id, placement type (FBS, FBY, DBS).',
      input: {},
      run: async (_, env) => {
        const d = await request(`${base(env)}/campaigns`, { headers: auth(env) });
        return (d?.campaigns || []).map((c) => ({ id: c.id, domain: c.domain, businessId: c.business?.id, placementType: c.placementType }));
      },
    },
    {
      name: 'ym_orders',
      description: 'Orders of a store for the last days (id, status, substatus, items, total).',
      input: { campaignId: z.number().int(), status: z.string().optional().describe('e.g. PROCESSING, DELIVERY'), days: z.number().int().min(1).max(30).optional() },
      run: async ({ campaignId, status, days = 7 }, env) => {
        const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        const q = new URLSearchParams({ fromDate: from.split('-').reverse().join('-'), ...(status ? { status } : {}) });
        const d = await request(`${base(env)}/campaigns/${campaignId}/orders?${q}`, { headers: auth(env) });
        return (d?.orders || []).map((o) => ({ id: o.id, status: o.status, substatus: o.substatus, creationDate: o.creationDate, itemsTotal: o.itemsTotal, items: (o.items || []).map((i) => ({ offerId: i.offerId, name: i.offerName, count: i.count, price: i.price })) }));
      },
    },
    {
      name: 'ym_offers',
      description: 'Catalog offers of a business (offerId, name, price, status).',
      input: { businessId: z.number().int(), limit: z.number().int().min(1).max(200).optional() },
      run: async ({ businessId, limit = 50 }, env) => {
        const d = await request(`${base(env)}/businesses/${businessId}/offer-mappings?limit=${limit}`, { method: 'POST', headers: auth(env), body: {} });
        return (d?.result?.offerMappings || []).map((m) => ({ offerId: m.offer?.offerId, name: m.offer?.name, price: m.offer?.basicPrice?.value, cardStatus: m.offer?.cardStatus }));
      },
    },
  ],
};
