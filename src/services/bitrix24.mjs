// Bitrix24 via an incoming webhook (Applications → Developer resources → Other → Incoming webhook).
// BITRIX24_WEBHOOK_URL = https://<portal>.bitrix24.ru/rest/<user_id>/<code>/
import { request, z } from '../core.mjs';

const call = (env, method, params = {}) => request(`${env.BITRIX24_WEBHOOK_URL.replace(/\/+$/, '')}/${method}.json`, { method: 'POST', body: params });

export default {
  name: 'bitrix24',
  title: 'Bitrix24',
  env: ['BITRIX24_WEBHOOK_URL'],
  tools: [
    {
      name: 'b24_leads',
      description: 'Recent CRM leads (id, title, name, phone, email, status, created).',
      input: { limit: z.number().int().min(1).max(50).optional(), status: z.string().optional().describe('STATUS_ID, e.g. NEW') },
      run: async ({ limit = 20, status }, env) => {
        const d = await call(env, 'crm.lead.list', { order: { DATE_CREATE: 'DESC' }, filter: status ? { STATUS_ID: status } : {}, select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'STATUS_ID', 'DATE_CREATE', 'OPPORTUNITY'] });
        return (d?.result || []).slice(0, limit);
      },
    },
    {
      name: 'b24_deals',
      description: 'Recent CRM deals (id, title, stage, amount, created).',
      input: { limit: z.number().int().min(1).max(50).optional(), stage: z.string().optional() },
      run: async ({ limit = 20, stage }, env) => {
        const d = await call(env, 'crm.deal.list', { order: { DATE_CREATE: 'DESC' }, filter: stage ? { STAGE_ID: stage } : {}, select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE', 'CONTACT_ID'] });
        return (d?.result || []).slice(0, limit);
      },
    },
    {
      name: 'b24_add_lead',
      description: 'Create a CRM lead.',
      write: true,
      input: { title: z.string(), name: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), comments: z.string().optional() },
      run: async ({ title, name, phone, email, comments }, env) => {
        const fields = { TITLE: title, NAME: name, COMMENTS: comments, ...(phone ? { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] } : {}), ...(email ? { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] } : {}) };
        const d = await call(env, 'crm.lead.add', { fields });
        return `Lead created, id ${d?.result}.`;
      },
    },
    {
      name: 'b24_add_task',
      description: 'Create a task for an employee.',
      write: true,
      input: { title: z.string(), responsibleId: z.number().int(), description: z.string().optional(), deadline: z.string().optional().describe('ISO datetime') },
      run: async ({ title, responsibleId, description, deadline }, env) => {
        const d = await call(env, 'tasks.task.add', { fields: { TITLE: title, RESPONSIBLE_ID: responsibleId, DESCRIPTION: description, DEADLINE: deadline } });
        return `Task created, id ${d?.result?.task?.id ?? d?.result}.`;
      },
    },
  ],
};
