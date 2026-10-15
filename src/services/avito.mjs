// Avito API for business (developers.avito.ru). Personal OAuth, client_credentials: client_id and client_secret come from
// the Avito cabinet (API for business). A token lives 24 hours: POST /token, then `Authorization: Bearer <token>`.
// The messenger methods need a tariff with Messenger API access.
import { ApiError, cachedPerEnv, forgetPerEnv, queryString, request, z } from '../core.mjs';

const AVITO_URL = 'https://api.avito.ru';
const FORM = 'application/x-www-form-urlencoded';
const TOKEN_KEY = 'token';
const USER_KEY = 'user-id';
const DEFAULT_TOKEN_TTL_S = 86_400; // documented lifetime: 24 hours
const TOKEN_MARGIN_MS = 60_000; // a token this close to its end is replaced before it is used
const MS_PER_SECOND = 1_000;
const HTTP_UNAUTHORIZED = 401;
const MESSENGER_MAX = 100; // maximum `limit` of the messenger lists
const CHATS_DEFAULT = 20;
const MESSAGES_DEFAULT = 30;
const MAX_OFFSET = 1_000; // the messenger lists do not serve offsets past 1000
const ITEMS_MAX = 99; // per_page is documented as «greater than 0 and less than 100»
const ITEMS_DEFAULT = 25;
const TEXT_MAX_CHARS = 10_000; // a sanity bound: Avito's own limit of a message is not documented
const ITEM_STATUSES = ['active', 'removed', 'old', 'blocked', 'rejected'];
const CHAT_TYPES = ['u2i', 'u2u', 'a2u'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const base = (env) => (env.AVITO_API_URL || AVITO_URL).replace(/\/+$/, '');
/** Unix seconds → ISO time. */
const at = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * MS_PER_SECOND).toISOString() : undefined);

async function fetchToken(env) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.AVITO_CLIENT_ID, client_secret: env.AVITO_CLIENT_SECRET }).toString();
  const d = await request(`${base(env)}/token`, { method: 'POST', headers: { 'content-type': FORM }, body, idempotent: true });
  if (!d?.access_token) throw new Error('Avito gave no access token: check AVITO_CLIENT_ID and AVITO_CLIENT_SECRET.');
  return { value: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || DEFAULT_TOKEN_TTL_S) * MS_PER_SECOND };
}

/** The token lives as long as the env object: the process on stdio, one request when hosted (nothing is stored). */
const accessToken = (env) => cachedPerEnv(env, TOKEN_KEY, () => fetchToken(env), (t) => t.expiresAt - Date.now() > TOKEN_MARGIN_MS);

/** Authorized call. A 401 (the token was revoked before its time) gets a fresh token and one more try. */
async function call(env, path, { method = 'GET', params, body } = {}) {
  const url = `${base(env)}${path}${queryString(params)}`;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(env);
    try {
      return await request(url, { method, headers: { Authorization: `Bearer ${token.value}` }, body });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== HTTP_UNAUTHORIZED || attempt > 0) throw e;
      forgetPerEnv(env, TOKEN_KEY);
    }
  }
}

/** The messenger methods are addressed by the id of your account. */
const userIdOf = (env) => cachedPerEnv(env, USER_KEY, async () => {
  const d = await call(env, '/core/v1/accounts/self');
  if (!Number.isInteger(d?.id)) throw new Error('Could not read the Avito account id (GET /core/v1/accounts/self).');
  return d.id;
});

/** A full page may have a successor — until the API's offset ceiling. */
const nextOffsetOf = (count, limit, offset) => (count === limit && offset + limit <= MAX_OFFSET ? { nextOffset: offset + limit } : {});

function chatOut(c, userId) {
  const v = c.context?.value;
  const last = c.last_message;
  const other = (c.users ?? []).find((u) => u.id !== userId);
  return {
    id: c.id,
    with: other ? { id: other.id, name: other.name } : undefined,
    item: v ? { id: v.id, title: v.title, price: v.price_string, url: v.url } : undefined,
    last: last ? { direction: last.direction, type: last.type, text: last.content?.text, at: at(last.created) } : undefined,
    updatedAt: at(c.updated),
  };
}

const messageOut = (m) => ({
  id: m.id,
  direction: m.direction,
  author: m.author_id,
  type: m.type,
  text: m.content?.text ?? m.content?.link?.text ?? m.content?.item?.title,
  at: at(m.created),
  read: m.is_read,
});

const itemOut = (i) => ({ id: i.id, title: i.title, price: i.price, status: i.status, category: i.category?.name, address: i.address, url: i.url });

const chatIdInput = z.string().min(1).max(200).describe('Chat id from avito_chats');
const offsetInput = z.number().int().min(0).max(MAX_OFFSET).optional();

export default {
  name: 'avito',
  title: 'Avito',
  env: ['AVITO_CLIENT_ID', 'AVITO_CLIENT_SECRET'],
  tools: [
    {
      name: 'avito_chats',
      description: 'Avito messenger chats of your account: chat id, the other person, the listing, the last message. unreadOnly=true — only chats with '
        + 'unread messages. When nextOffset is returned, call again with offset=nextOffset (Avito serves offsets up to 1000). Needs the Messenger API of your tariff.',
      input: {
        unreadOnly: z.boolean().optional().describe('Only chats with unread messages'),
        chatTypes: z.array(z.enum(CHAT_TYPES)).min(1).optional().describe('u2i — about listings (the default), u2u — between users, a2u — from Avito'),
        itemId: z.number().int().min(1).optional().describe('Only chats about this listing'),
        limit: z.number().int().min(1).max(MESSENGER_MAX).optional().describe(`Chats, default ${CHATS_DEFAULT}`),
        offset: offsetInput,
      },
      maxItems: MESSENGER_MAX,
      run: async ({ unreadOnly, chatTypes, itemId, limit = CHATS_DEFAULT, offset = 0 }, env) => {
        const userId = await userIdOf(env);
        const params = { unread_only: unreadOnly ? 'true' : undefined, chat_types: chatTypes?.join(','), item_ids: itemId, limit, offset };
        const d = await call(env, `/messenger/v2/accounts/${userId}/chats`, { params });
        const chats = (d?.chats ?? []).map((c) => chatOut(c, userId));
        return { chats, ...nextOffsetOf(chats.length, limit, offset) };
      },
    },
    {
      name: 'avito_messages',
      description: 'Message history of one Avito chat: author, direction (in — from the other person, out — yours), type, text, time, read flag. '
        + 'Does not mark the chat as read. When nextOffset is returned, call again with offset=nextOffset.',
      input: {
        chatId: chatIdInput,
        limit: z.number().int().min(1).max(MESSENGER_MAX).optional().describe(`Messages, default ${MESSAGES_DEFAULT}`),
        offset: offsetInput,
      },
      maxItems: MESSENGER_MAX,
      run: async ({ chatId, limit = MESSAGES_DEFAULT, offset = 0 }, env) => {
        const userId = await userIdOf(env);
        const d = await call(env, `/messenger/v3/accounts/${userId}/chats/${encodeURIComponent(chatId)}/messages/`, { params: { limit, offset } });
        const messages = (Array.isArray(d) ? d : d?.messages ?? []).map(messageOut);
        return { messages, ...nextOffsetOf(messages.length, limit, offset) };
      },
    },
    {
      name: 'avito_send_message',
      description: 'Send a text message to an Avito chat as your account.',
      write: true,
      input: { chatId: chatIdInput, text: z.string().min(1).max(TEXT_MAX_CHARS) },
      run: async ({ chatId, text }, env) => {
        const userId = await userIdOf(env);
        const path = `/messenger/v1/accounts/${userId}/chats/${encodeURIComponent(chatId)}/messages`;
        const d = await call(env, path, { method: 'POST', body: { message: { text }, type: 'text' } });
        return `Message sent to chat ${chatId}${d?.id ? `, message id ${d.id}` : ''}.`;
      },
    },
    {
      name: 'avito_items',
      description: 'Your own Avito listings: id, title, price, status (active, removed, old, blocked, rejected), category, address, url. '
        + 'Several statuses may be asked at once (Avito returns active ones by default). Avito allows 25 calls a minute here. '
        + 'When next is returned, call again with page=next and the same limit.',
      input: {
        status: z.array(z.enum(ITEM_STATUSES)).min(1).optional(),
        category: z.number().int().min(1).optional().describe('Avito category id'),
        updatedFrom: z.string().regex(DATE, 'Expected YYYY-MM-DD').optional().describe('Only listings updated on or after this date, YYYY-MM-DD'),
        limit: z.number().int().min(1).max(ITEMS_MAX).optional().describe(`Listings per page, default ${ITEMS_DEFAULT}`),
        page: z.number().int().min(1).optional().describe('Page number, 1 by default'),
      },
      maxItems: ITEMS_MAX,
      run: async ({ status, category, updatedFrom, limit = ITEMS_DEFAULT, page = 1 }, env) => {
        const params = { per_page: limit, page, status: status?.join(','), category, updatedAtFrom: updatedFrom };
        const d = await call(env, '/core/v1/items', { params });
        const items = (d?.resources ?? []).map(itemOut);
        return { items, ...(items.length === limit ? { next: page + 1 } : {}) };
      },
    },
  ],
};
