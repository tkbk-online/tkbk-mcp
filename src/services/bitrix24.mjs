// Bitrix24 via an incoming webhook (Applications → Developer resources → Other → Incoming webhook).
// BITRIX24_WEBHOOK_URL = https://<portal>.bitrix24.ru/rest/<user_id>/<code>/
import { request, z } from '../core.mjs';

const LIST_PAGE = 50; // Bitrix24 list methods return 50 records a page; `start` is the offset
const LIST_DEFAULT = 20;

/** REST call; lists are reads (retried on 5xx, which also is Bitrix24's QUERY_LIMIT_EXCEEDED), adds are not. */
const call = (env, method, params = {}, { idempotent = false } = {}) =>
  request(`${env.BITRIX24_WEBHOOK_URL.replace(/\/+$/, '')}/${method}.json`, { method: 'POST', body: params, idempotent });

const listInput = {
  limit: z.number().int().min(1).max(LIST_PAGE).optional(),
  start: z.number().int().min(0).optional().describe(`Offset for older records: 0, ${LIST_PAGE}, ${LIST_PAGE * 2} …`),
};

export default {
  name: 'bitrix24',
  title: 'Bitrix24',
  env: ['BITRIX24_WEBHOOK_URL'],
  tools: [
    {
      name: 'b24_leads',
      description: 'Recent CRM leads (id, title, name, phone, email, status, created).',
      input: { ...listInput, status: z.string().optional().describe('STATUS_ID, e.g. NEW') },
      run: async ({ limit = LIST_DEFAULT, start = 0, status }, env) => {
        const d = await call(env, 'crm.lead.list', { order: { DATE_CREATE: 'DESC' }, filter: status ? { STATUS_ID: status } : {}, select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'STATUS_ID', 'DATE_CREATE', 'OPPORTUNITY'], start }, { idempotent: true });
        return (d?.result || []).slice(0, limit);
      },
    },
    {
      name: 'b24_deals',
      description: 'Recent CRM deals (id, title, stage, amount, created).',
      input: { ...listInput, stage: z.string().optional() },
      run: async ({ limit = LIST_DEFAULT, start = 0, stage }, env) => {
        const d = await call(env, 'crm.deal.list', { order: { DATE_CREATE: 'DESC' }, filter: stage ? { STAGE_ID: stage } : {}, select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE', 'CONTACT_ID'], start }, { idempotent: true });
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
