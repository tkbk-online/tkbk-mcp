// amoCRM API v4. AMOCRM_DOMAIN = yourcompany.amocrm.ru, AMOCRM_TOKEN = long-lived token (integration settings).
import { request, z } from '../core.mjs';

const base = (env) => `https://${env.AMOCRM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v4`;
const auth = (env) => ({ Authorization: `Bearer ${env.AMOCRM_TOKEN}` });

export default {
  name: 'amocrm',
  title: 'amoCRM',
  env: ['AMOCRM_DOMAIN', 'AMOCRM_TOKEN'],
  tools: [
    {
      name: 'amo_leads',
      description: 'Recent deals (leads): id, name, price, status, pipeline, created.',
      input: { limit: z.number().int().min(1).max(250).optional(), query: z.string().optional() },
      run: async ({ limit = 25, query }, env) => {
        const q = new URLSearchParams({ limit: String(limit), 'order[created_at]': 'desc', ...(query ? { query } : {}) });
        const d = await request(`${base(env)}/leads?${q}`, { headers: auth(env) });
        return (d?._embedded?.leads || []).map((l) => ({ id: l.id, name: l.name, price: l.price, status_id: l.status_id, pipeline_id: l.pipeline_id, created_at: new Date(l.created_at * 1000).toISOString() }));
      },
    },
    {
      name: 'amo_contacts',
      description: 'Search contacts by name, phone or email.',
      input: { query: z.string(), limit: z.number().int().min(1).max(250).optional() },
      run: async ({ query, limit = 25 }, env) => {
        const d = await request(`${base(env)}/contacts?${new URLSearchParams({ query, limit: String(limit) })}`, { headers: auth(env) });
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
