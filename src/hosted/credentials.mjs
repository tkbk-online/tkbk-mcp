// Marketplace and CRM credentials of one hosted request: taken from the MCP connection headers, validated (a request
// may not be pointed at our own network: amoCRM and Bitrix24 hosts are allow-listed), mapped into the service env.
// They live only for that request: never logged, never stored.

/** Service env variable → connection header. */
export const CREDENTIAL_HEADERS = Object.freeze({
  WB_TOKEN: 'x-wb-token',
  OZON_CLIENT_ID: 'x-ozon-client-id',
  OZON_API_KEY: 'x-ozon-api-key',
  YM_API_KEY: 'x-ym-api-key',
  YM_BUSINESS_ID: 'x-ym-business-id',
  AMOCRM_DOMAIN: 'x-amo-subdomain',
  AMOCRM_TOKEN: 'x-amo-token',
  BITRIX24_WEBHOOK_URL: 'x-b24-webhook',
  AVITO_CLIENT_ID: 'x-avito-client-id',
  AVITO_CLIENT_SECRET: 'x-avito-client-secret',
  DADATA_API_KEY: 'x-dadata-key',
  DADATA_SECRET: 'x-dadata-secret',
});

const MAX_SECRET_LENGTH = 4096;
const SECRET = /^[\x21-\x7e]+$/; // printable ASCII without spaces
const NUMERIC_ID = /^\d{1,20}$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const AMO_SUBDOMAIN = new RegExp(`^${LABEL}$`);
const AMO_HOST = new RegExp(`^${LABEL}\\.(?:amocrm\\.ru|amocrm\\.com|kommo\\.com)$`);
const AMO_DEFAULT_ZONE = 'amocrm.ru';
/** Cloud Bitrix24 zones (DNS of these is Bitrix24's); on-premise portals are added by MCP_B24_HOSTS. */
const B24_HOST = new RegExp(`^${LABEL}\\.bitrix24\\.(?:ru|by|kz|ua|com|de|eu|es|fr|it|pl|uk|in|com\\.br|jp|cn|com\\.tr|id|vn)$`);
const B24_PATH = /^\/rest\/(\d{1,12})\/([A-Za-z0-9_]{4,64})\/?$/;

const secret = (v) => (v.length <= MAX_SECRET_LENGTH && SECRET.test(v) ? v : null);
const numericId = (v) => (NUMERIC_ID.test(v) ? v : null);

/** "shop", "shop.amocrm.ru", "https://shop.kommo.com/" → host; anything else → null. */
function amoDomain(v) {
  const host = v.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (AMO_SUBDOMAIN.test(host)) return `${host}.${AMO_DEFAULT_ZONE}`;
  return AMO_HOST.test(host) ? host : null;
}

/** https://<portal>.bitrix24.<zone>/rest/<user>/<code>/ (or an allowed on-premise host) → normalized URL; else null. */
function b24Webhook(v, extraHosts) {
  let url;
  try { url = new URL(v); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const path = B24_PATH.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !path) return null;
  if (!B24_HOST.test(host) && !extraHosts.has(host)) return null;
  return `https://${host}/rest/${path[1]}/${path[2]}/`;
}

const RULES = {
  WB_TOKEN: { parse: secret, expected: 'the Wildberries API token' },
  OZON_CLIENT_ID: { parse: numericId, expected: 'the Ozon Client-Id (digits)' },
  OZON_API_KEY: { parse: secret, expected: 'the Ozon API key' },
  YM_API_KEY: { parse: secret, expected: 'the Yandex Market Api-Key token' },
  YM_BUSINESS_ID: { parse: numericId, expected: 'the cabinet (business) id, digits' },
  AMOCRM_DOMAIN: { parse: amoDomain, expected: 'yourcompany or yourcompany.amocrm.ru' },
  AMOCRM_TOKEN: { parse: secret, expected: 'the amoCRM long-lived token' },
  BITRIX24_WEBHOOK_URL: { parse: b24Webhook, expected: 'https://<portal>.bitrix24.ru/rest/<user id>/<code>/' },
  AVITO_CLIENT_ID: { parse: secret, expected: 'the Avito client_id' },
  AVITO_CLIENT_SECRET: { parse: secret, expected: 'the Avito client_secret' },
  DADATA_API_KEY: { parse: secret, expected: 'the DaData API key' },
  DADATA_SECRET: { parse: secret, expected: 'the DaData secret key' },
};

/**
 * Service env from the connection headers: only the variables the service uses; absent headers stay absent (the tool
 * then says which header to add).
 * @param {{env: string[], optionalEnv?: string[]}} service
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {{b24Hosts?: Set<string>}} [options]  on-premise Bitrix24 hosts allowed by the operator
 * @returns {{env: Record<string, string>} | {error: string}}
 */
export function credentialsFor(service, headers, { b24Hosts = new Set() } = {}) {
  const env = {};
  for (const name of [...service.env, ...(service.optionalEnv ?? [])]) {
    const header = CREDENTIAL_HEADERS[name];
    const raw = headers[header];
    if (raw === undefined || raw === '') continue;
    const value = typeof raw === 'string' ? RULES[name].parse(raw.trim(), b24Hosts) : null;
    if (!value) return { error: `Invalid header ${header}: expected ${RULES[name].expected}.` };
    env[name] = value;
  }
  return { env };
}

/** Tool answer when credentials are missing: which connection headers to add. */
export const missingHeadersHint = (missing) =>
  `Not configured: add the header${missing.length > 1 ? 's' : ''} ${missing.map((k) => CREDENTIAL_HEADERS[k] ?? k).join(', ')} to the MCP connection (https://tkbk.online/mcp).`;
