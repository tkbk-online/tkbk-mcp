// Wildberries seller API. Token: personal cabinet → Settings → Access to API (categories: Content, Prices, Marketplace,
// Statistics, Feedbacks). Header `Authorization: <token>`.
import { request, z } from '../core.mjs';

const host = (env, name, def) => (env[`WB_${name}_URL`] || def).replace(/\/+$/, '');
const auth = (env) => ({ Authorization: env.WB_TOKEN });

export default {
  name: 'wildberries',
  title: 'Wildberries',
  env: ['WB_TOKEN'],
  tools: [
    {
      name: 'wb_new_orders',
      description: 'New FBS orders waiting for assembly (id, article, price, warehouse, created time).',
      input: {},
      run: async (_, env) => {
        const d = await request(`${host(env, 'MARKETPLACE', 'https://marketplace-api.wildberries.ru')}/api/v3/orders/new`, { headers: auth(env) });
        return (d?.orders || []).map((o) => ({ id: o.id, article: o.article, nmId: o.nmId, price: o.convertedPrice ? o.convertedPrice / 100 : o.price / 100, warehouseId: o.warehouseId, createdAt: o.createdAt }));
      },
    },
    {
      name: 'wb_stocks',
      description: 'Stock balances on WB warehouses changed since a date (article, size, warehouse, quantity).',
      input: { dateFrom: z.string().describe('ISO date, e.g. 2026-10-01').optional() },
      run: async ({ dateFrom }, env) => {
        const from = dateFrom || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const d = await request(`${host(env, 'STATISTICS', 'https://statistics-api.wildberries.ru')}/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(from)}`, { headers: auth(env) });
        return (d || []).map((s) => ({ article: s.supplierArticle, nmId: s.nmId, size: s.techSize, warehouse: s.warehouseName, quantity: s.quantity, inWayToClient: s.inWayToClient }));
      },
    },
    {
      name: 'wb_prices',
      description: 'Current prices and discounts of goods (nmId, price, discount).',
      input: { limit: z.number().int().min(1).max(1000).optional() },
      run: async ({ limit = 100 }, env) => {
        const d = await request(`${host(env, 'PRICES', 'https://discounts-prices-api.wildberries.ru')}/api/v2/list/goods/filter?limit=${limit}`, { headers: auth(env) });
        return (d?.data?.listGoods || []).map((g) => ({ nmId: g.nmID, article: g.vendorCode, discount: g.discount, sizes: (g.sizes || []).map((s) => ({ size: s.techSizeName, price: s.price, discountedPrice: s.discountedPrice })) }));
      },
    },
    {
      name: 'wb_feedbacks',
      description: 'Customer reviews without an answer yet (id, product, rating, text, date).',
      input: { take: z.number().int().min(1).max(100).optional() },
      run: async ({ take = 20 }, env) => {
        const d = await request(`${host(env, 'FEEDBACKS', 'https://feedbacks-api.wildberries.ru')}/api/v1/feedbacks?isAnswered=false&take=${take}&skip=0`, { headers: auth(env) });
        return (d?.data?.feedbacks || []).map((f) => ({ id: f.id, product: f.productDetails?.productName, article: f.productDetails?.supplierArticle, rating: f.productValuation, text: f.text, pros: f.pros, cons: f.cons, createdDate: f.createdDate }));
      },
    },
    {
      name: 'wb_answer_feedback',
      description: 'Publish an answer to a customer review.',
      write: true,
      input: { id: z.string().describe('Review id from wb_feedbacks'), text: z.string().min(2).max(5000) },
      run: async ({ id, text }, env) => {
        await request(`${host(env, 'FEEDBACKS', 'https://feedbacks-api.wildberries.ru')}/api/v1/feedbacks/answer`, { method: 'POST', headers: auth(env), body: { id, text } });
        return `Answer published to review ${id}.`;
      },
    },
  ],
};
