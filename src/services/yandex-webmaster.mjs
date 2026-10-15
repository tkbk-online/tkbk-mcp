// Yandex Webmaster API v4. OAuth token with the webmaster:hostinfo scope: header `Authorization: OAuth <token>`.
// Every resource is addressed by the id of the user (GET /user) and the id of the site, e.g. https:example.com:443.
import { cachedPerEnv, queryString, request, z } from '../core.mjs';

const WEBMASTER_URL = 'https://api.webmaster.yandex.net/v4';
const USER_KEY = 'user-id';
const QUERIES_MAX = 500; // limit of search-queries/popular is 1—500
const QUERIES_DEFAULT = 50;
const DECIMAL = 10; // positions are shown with one decimal
const SITE_MAX_CHARS = 300;
/** scheme:host:port — the shape of a site id; it goes into a URL path, so nothing else is let in. */
const HOST_ID = /^(?:http|https):[a-z0-9._-]+:\d{1,5}$/i;
const USER_ID = /^\d{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEVERITIES = ['FATAL', 'CRITICAL', 'POSSIBLE_PROBLEM', 'RECOMMENDATION'];
const ORDER_BY = { shows: 'TOTAL_SHOWS', clicks: 'TOTAL_CLICKS' };
const INDICATORS = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'];
const DEVICES = ['ALL', 'DESKTOP', 'MOBILE_AND_TABLET', 'MOBILE', 'TABLET'];

const base = (env) => (env.WEBMASTER_API_URL || WEBMASTER_URL).replace(/\/+$/, '');
const get = (env, path, params) => request(`${base(env)}${path}${queryString(params)}`, { headers: { Authorization: `OAuth ${env.WEBMASTER_TOKEN}` } });
const round1 = (x) => (typeof x === 'number' ? Math.round(x * DECIMAL) / DECIMAL : x);

const userIdOf = (env) => cachedPerEnv(env, USER_KEY, async () => {
  const id = String((await get(env, '/user'))?.user_id ?? '');
  if (!USER_ID.test(id)) throw new Error('Could not read the Yandex Webmaster user id (GET /v4/user): check WEBMASTER_TOKEN.');
  return id;
});

async function hostsOf(env) {
  const d = await get(env, `/user/${await userIdOf(env)}/hosts`);
  return d?.hosts ?? [];
}

/** "https://www.Example.com/page" → "example.com": what sites are compared by. */
const nameOf = (url) => String(url ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
/** A verified site first, then an https one: example.com is often added as both http and https. */
const rank = (h) => (h.verified ? 2 : 0) + (String(h.host_id).startsWith('https:') ? 1 : 0);

/** The site id for a domain, an address or an id given by the agent. */
async function hostIdOf(env, site) {
  const wanted = site.trim();
  if (HOST_ID.test(wanted)) return wanted;
  const name = nameOf(wanted);
  const found = (await hostsOf(env)).filter((h) => [h.ascii_host_url, h.unicode_host_url].some((u) => nameOf(u) === name)).sort((a, b) => rank(b) - rank(a))[0];
  if (!found || !HOST_ID.test(found.host_id)) throw new Error(`The site "${site}" is not in your Yandex Webmaster account: see webmaster_hosts.`);
  return found.host_id;
}

/** The id of a site and the path of its resources. */
async function siteOf(env, site) {
  const hostId = await hostIdOf(env, site);
  return { hostId, path: `/user/${await userIdOf(env)}/hosts/${hostId}` };
}

const hostOut = (h) => ({
  id: h.host_id,
  url: h.unicode_host_url ?? h.ascii_host_url,
  verified: h.verified,
  mainMirror: h.main_mirror && h.main_mirror.host_id !== h.host_id ? h.main_mirror.host_id : undefined,
});

/** Problems that are present now, the most serious first. */
function presentProblems(diagnostics) {
  return Object.entries(diagnostics?.problems ?? {})
    .filter(([, p]) => p?.state === 'PRESENT')
    .map(([code, p]) => ({ code, severity: p.severity, since: p.last_state_update }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

function queryOut(q) {
  const i = q.indicators ?? {};
  return { query: q.query_text, shows: i.TOTAL_SHOWS, clicks: i.TOTAL_CLICKS, showPosition: round1(i.AVG_SHOW_POSITION), clickPosition: round1(i.AVG_CLICK_POSITION) };
}

const siteInput = z.string().min(1).max(SITE_MAX_CHARS).describe('The site: a domain (example.com), an address, or an id from webmaster_hosts');
const dateInput = (what) => z.string().regex(DATE, 'Expected YYYY-MM-DD').optional().describe(what);

export default {
  name: 'yandex-webmaster',
  title: 'Yandex Webmaster',
  env: ['WEBMASTER_TOKEN'],
  tools: [
    {
      name: 'webmaster_hosts',
      description: 'Sites of your Yandex Webmaster account: id (like https:example.com:443), address, whether the rights are verified, the main mirror. '
        + 'The other webmaster tools take a domain or this id as `site`.',
      input: {},
      run: async (_, env) => ({ hosts: (await hostsOf(env)).map(hostOut) }),
    },
    {
      name: 'webmaster_summary',
      description: 'Indexing summary of a site in Yandex Webmaster: SQI (ИКС), pages in the search, excluded pages, the number of problems by severity '
        + '(FATAL, CRITICAL, POSSIBLE_PROBLEM, RECOMMENDATION) and the problems that are present now with the date they appeared.',
      input: { site: siteInput },
      run: async ({ site }, env) => {
        const { hostId, path } = await siteOf(env, site);
        const [summary, diagnostics] = await Promise.all([get(env, `${path}/summary`), get(env, `${path}/diagnostics`)]);
        return {
          site: hostId,
          sqi: summary?.sqi,
          searchablePages: summary?.searchable_pages_count,
          excludedPages: summary?.excluded_pages_count,
          problemCounts: summary?.site_problems,
          problems: presentProblems(diagnostics),
        };
      },
    },
    {
      name: 'webmaster_queries',
      description: 'Popular search queries of a site in Yandex search (the top 3000 of the period, the last week by default): shows, clicks, average position '
        + 'of the shows and of the clicks. orderBy: shows (default) or clicks. When nextOffset is returned, call again with offset=nextOffset.',
      input: {
        site: siteInput,
        orderBy: z.enum(Object.keys(ORDER_BY)).optional(),
        device: z.enum(DEVICES).optional().describe('Device of the searcher, default ALL'),
        dateFrom: dateInput('Start of the period, YYYY-MM-DD; default the last week'),
        dateTo: dateInput('End of the period, YYYY-MM-DD'),
        limit: z.number().int().min(1).max(QUERIES_MAX).optional().describe(`Queries, default ${QUERIES_DEFAULT}`),
        offset: z.number().int().min(0).optional(),
      },
      maxItems: QUERIES_MAX,
      run: async ({ site, orderBy = 'shows', device, dateFrom, dateTo, limit = QUERIES_DEFAULT, offset = 0 }, env) => {
        const { path } = await siteOf(env, site);
        const params = { order_by: ORDER_BY[orderBy], query_indicator: INDICATORS, device_type_indicator: device, date_from: dateFrom, date_to: dateTo, offset, limit };
        const d = await get(env, `${path}/search-queries/popular`, params);
        const queries = (d?.queries ?? []).map(queryOut);
        const total = Number(d?.count) || 0;
        const next = offset + queries.length;
        return { period: { from: d?.date_from, to: d?.date_to }, total, queries, ...(next < total ? { nextOffset: next } : {}) };
      },
    },
  ],
};
