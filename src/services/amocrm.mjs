// amoCRM API v4. AMOCRM_DOMAIN = yourcompany.amocrm.ru, AMOCRM_TOKEN = long-lived token (integration settings).
import { request, z } from '../core.mjs';

const PAGE_MAX = 250; // maximum `limit` of amoCRM v4 lists
const PAGE_DEFAULT = 25;
const MS_PER_SECOND = 1000;

const base = (env) => `https://${env.AMOCRM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v4`;
const auth = (env) => ({ Authorization: `Bearer ${env.AMOCRM_TOKEN}` });
const pageInput = z.number().int().min(1).optional().describe('Page number, 1 by default');

export default {
  name: 'amocrm',
  title: 'amoCRM',
  env: ['AMOCRM_DOMAIN', 'AMOCRM_TOKEN'],
  tools: [
    {
      name: 'amo_leads',
      description: 'Recent deals (leads): id, name, price, status, pipeline, created. Use page for older ones.',
      input: { limit: z.number().int().min(1).max(PAGE_MAX).optional(), query: z.string().optional(), page: pageInput },
      maxItems: PAGE_MAX,
      run: async ({ limit = PAGE_DEFAULT, query, page = 1 }, env) => {
        const q = new URLSearchParams({ limit: String(limit), page: String(page), 'order[created_at]': 'desc', ...(query ? { query } : {}) });
        const d = await request(`${base(env)}/leads?${q}`, { headers: auth(env) });
        return (d?._embedded?.leads || []).map((l) => ({ id: l.id, name: l.name, price: l.price, status_id: l.status_id, pipeline_id: l.pipeline_id, created_at: new Date(l.created_at * MS_PER_SECOND).toISOString() }));
      },
    },
    {
      name: 'amo_contacts',
      description: 'Search contacts by name, phone or email.',
      input: { query: z.string(), limit: z.number().int().min(1).max(PAGE_MAX).optional(), page: pageInput },
      maxItems: PAGE_MAX,
      run: async ({ query, limit = PAGE_DEFAULT, page = 1 }, env) => {
        const d = await request(`${base(env)}/contacts?${new URLSearchParams({ query, limit: String(limit), page: String(page) })}`, { headers: auth(env) });
        return (d?._embedded?.contacts || []).map((c) => ({ id: c.id, name: c.name, fields: (c.custom_fields_values || []).map((f) => ({ field: f.field_code || f.field_name, values: (f.values || []).map((v) => v.value) })) }));
      },
    },
    {
      name: 'amo_add_note',
      description: 'Add a text note to a deal.',
      write: true,
      input: { leadId: z.number().int(), text: z.string().min(1) },
      run: async ({ leadId, text }, env) => {
        await request(`${base(env)}/leads/${leadId}/notes`, { method: 'POST', headers: auth(env), body: [{ note_type: 'common', params: { text } }] });
        return `Note added to deal ${leadId}.`;
      },
    },
  ],
};
