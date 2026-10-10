// Wildberries seller API. Token: seller cabinet → Settings → Access to API (categories: Marketplace, Prices, Analytics,
// Feedbacks). Header `Authorization: <token>`.
import { request, z } from '../core.mjs';

const MARKETPLACE_URL = 'https://marketplace-api.wildberries.ru';
const ANALYTICS_URL = 'https://seller-analytics-api.wildberries.ru';
const PRICES_URL = 'https://discounts-prices-api.wildberries.ru';
const FEEDBACKS_URL = 'https://feedbacks-api.wildberries.ru';
/**
 * Report «Остатки на складах» (Analytics API, 3 requests a minute, up to 250 000 rows a request). The old
 * /api/v1/supplier/stocks of the Statistics API was switched off on 23.06.2026.
 */
const STOCK_REPORTS = {
  wb: '/api/analytics/v1/stocks-report/wb-warehouses',
  seller: '/api/analytics/v1/stocks-report/seller-warehouses',
};
const KOPECKS_PER_RUBLE = 100;
const STOCKS_MAX_ROWS = 1000;
const STOCKS_DEFAULT_ROWS = 100;
const STOCKS_MAX_NM_IDS = 1000;
const PRICES_MAX = 1000;
const PRICES_DEFAULT = 100;
const FEEDBACKS_MAX = 100;
const FEEDBACKS_DEFAULT = 20;
const ANSWER_MIN_CHARS = 2;
const ANSWER_MAX_CHARS = 5000;

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
        const d = await request(`${host(env, 'MARKETPLACE', MARKETPLACE_URL)}/api/v3/orders/new`, { headers: auth(env) });
        return (d?.orders || []).map((o) => ({ id: o.id, article: o.article, nmId: o.nmId, price: (o.convertedPrice || o.price) / KOPECKS_PER_RUBLE, warehouseId: o.warehouseId, createdAt: o.createdAt }));
      },
    },
    {
      name: 'wb_stocks',
      description: 'Current stock (report «Остатки на складах»): nmId, size id, warehouse, region, quantity, in transit to/from customers. '
        + 'warehouses: "wb" — WB warehouses (default), "seller" — your own warehouses. WB allows 3 calls a minute: narrow with nmIds; '
        + 'when nextOffset is returned, call again with offset=nextOffset for more rows. Needs the token category Analytics.',
      input: {
        warehouses: z.enum(['wb', 'seller']).optional(),
        nmIds: z.array(z.number().int()).max(STOCKS_MAX_NM_IDS).optional().describe('WB articles (nmId) to show; empty — all'),
        limit: z.number().int().min(1).max(STOCKS_MAX_ROWS).optional().describe(`Rows, default ${STOCKS_DEFAULT_ROWS}`),
        offset: z.number().int().min(0).optional(),
      },
      maxItems: STOCKS_MAX_ROWS,
      run: async ({ warehouses = 'wb', nmIds, limit = STOCKS_DEFAULT_ROWS, offset = 0 }, env) => {
        const url = `${host(env, 'ANALYTICS', ANALYTICS_URL)}${STOCK_REPORTS[warehouses]}`;
        const d = await request(url, { method: 'POST', headers: auth(env), body: { ...(nmIds?.length ? { nmIds } : {}), limit, offset }, idempotent: true });
        const items = (d?.data?.items || []).map((s) => ({
          nmId: s.nmId, chrtId: s.chrtId, warehouse: s.warehouseName, region: s.regionName,
          quantity: s.quantity, inWayToClient: s.inWayToClient, inWayFromClient: s.inWayFromClient,
        }));
        return { items, ...(items.length === limit ? { nextOffset: offset + limit } : {}) };
      },
    },
    {
      name: 'wb_prices',
      description: 'Current prices and discounts of goods (nmId, price, discount). Page with offset (0, limit, 2×limit …).',
      input: { limit: z.number().int().min(1).max(PRICES_MAX).optional(), offset: z.number().int().min(0).optional() },
      run: async ({ limit = PRICES_DEFAULT, offset = 0 }, env) => {
        const d = await request(`${host(env, 'PRICES', PRICES_URL)}/api/v2/list/goods/filter?limit=${limit}&offset=${offset}`, { headers: auth(env) });
        return (d?.data?.listGoods || []).map((g) => ({ nmId: g.nmID, article: g.vendorCode, discount: g.discount, sizes: (g.sizes || []).map((s) => ({ size: s.techSizeName, price: s.price, discountedPrice: s.discountedPrice })) }));
      },
    },
    {
      name: 'wb_feedbacks',
      description: 'Customer reviews without an answer yet (id, product, rating, text, date). Page with skip.',
      input: { take: z.number().int().min(1).max(FEEDBACKS_MAX).optional(), skip: z.number().int().min(0).optional() },
      run: async ({ take = FEEDBACKS_DEFAULT, skip = 0 }, env) => {
        const d = await request(`${host(env, 'FEEDBACKS', FEEDBACKS_URL)}/api/v1/feedbacks?isAnswered=false&take=${take}&skip=${skip}`, { headers: auth(env) });
        return (d?.data?.feedbacks || []).map((f) => ({ id: f.id, product: f.productDetails?.productName, article: f.productDetails?.supplierArticle, rating: f.productValuation, text: f.text, pros: f.pros, cons: f.cons, createdDate: f.createdDate }));
      },
    },
    {
      name: 'wb_answer_feedback',
      description: 'Publish an answer to a customer review.',
      write: true,
      input: { id: z.string().describe('Review id from wb_feedbacks'), text: z.string().min(ANSWER_MIN_CHARS).max(ANSWER_MAX_CHARS) },
      run: async ({ id, text }, env) => {
        await request(`${host(env, 'FEEDBACKS', FEEDBACKS_URL)}/api/v1/feedbacks/answer`, { method: 'POST', headers: auth(env), body: { id, text } });
        return `Answer published to review ${id}.`;
      },
    },
  ],
};
