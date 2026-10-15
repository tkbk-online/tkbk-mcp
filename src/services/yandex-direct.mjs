// Yandex Direct API (JSON). OAuth token of a Direct user: header `Authorization: Bearer <token>`. For an agency account
// DIRECT_CLIENT_LOGIN is the login of the client (header Client-Login). Campaigns and Reports are served under /json/v501.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, DAY_MS, isoDate, request, z } from '../core.mjs';

const DIRECT_URL = 'https://api.direct.yandex.com/json/v501';
const MICROS = 1_000_000; // money of campaigns: the amount in the currency × 1 000 000
const CENT = 100;
const PERCENT = 100;
const MS_PER_SECOND = 1_000;
const CAMPAIGNS_MAX = 1_000;
const CAMPAIGNS_DEFAULT = 50;
const IDS_MAX = 1_000; // SelectionCriteria.Ids
const ROWS_MAX = 500;
const ROWS_DEFAULT = 50;
const REPORT_DEFAULT_DAYS = 7;
const HTTP_OK = 200;
const POLL_DEFAULT_S = 5; // when Direct does not say how long to wait (header retryIn)
const POLL_MAX_S = 20;
const POLL_MAX = 12;
const POLL_BUDGET_MS = 45_000; // one tool call waits for an offline report no longer than this
/** Errors that mean "later": the authorization server is down, not enough API units, too many parallel connections. */
const LATER_CODES = new Set([52, 152, 506]);
const STATES = ['ON', 'OFF', 'SUSPENDED', 'ENDED', 'ARCHIVED', 'CONVERTED'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const CAMPAIGN_FIELDS = ['Id', 'Name', 'Type', 'State', 'Status', 'StatusPayment', 'StatusClarification', 'StartDate', 'EndDate', 'Currency', 'Funds', 'Statistics'];
/** Budget limits live in the bidding strategy, and every campaign type has its own set of fields for it. */
const STRATEGY_FIELDS = {
  TextCampaignFieldNames: ['BiddingStrategy'],
  UnifiedCampaignFieldNames: ['BiddingStrategy'],
  MobileAppCampaignFieldNames: ['BiddingStrategy'],
  CpmBannerCampaignFieldNames: ['BiddingStrategy'],
};
const REPORT_FIELDS = ['CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Ctr', 'Cost', 'Conversions', 'CostPerConversion'];
/** Money in the currency (not micros), no report title and no summary line; Direct picks online or offline itself. */
const REPORT_HEADERS = { processingMode: 'auto', returnMoneyInMicros: 'false', skipReportHeader: 'true', skipReportSummary: 'true', accept: '*/*' };

const base = (env) => (env.DIRECT_API_URL || DIRECT_URL).replace(/\/+$/, '');
const headers = (env) => ({
  Authorization: `Bearer ${env.DIRECT_TOKEN}`,
  'Accept-Language': 'ru',
  'content-type': 'application/json; charset=utf-8',
  ...(env.DIRECT_CLIENT_LOGIN ? { 'Client-Login': env.DIRECT_CLIENT_LOGIN } : {}),
});

/** An error of Direct comes as HTTP 200 with {error: {error_code, error_string, error_detail}}. */
function directError(e) {
  const text = [e.error_string, e.error_detail].filter(Boolean).join(': ');
  return new ApiError(e.error_code, `Direct error ${e.error_code}: ${text}${LATER_CODES.has(e.error_code) ? ' (limit reached: retry later)' : ''}`);
}

/** A method of a JSON service; all of them used here are reads, so network errors and 5xx may be repeated. */
async function rpc(env, service, method, params) {
  const d = await request(`${base(env)}/${service}`, { method: 'POST', headers: headers(env), body: { method, params }, idempotent: true });
  if (d?.error) throw directError(d.error);
  return d?.result;
}

/** The first number stored under `key` anywhere inside `node`: strategies nest by type (Search → WbMaximumClicks → …). */
function findNumber(node, key) {
  if (!node || typeof node !== 'object') return undefined;
  if (typeof node[key] === 'number') return node[key];
  for (const child of Object.values(node)) {
    const found = findNumber(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
const money = (micros) => (typeof micros === 'number' ? micros / MICROS : undefined);
const round2 = (x) => Math.round(x * CENT) / CENT;
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

function campaignOut(c) {
  const strategy = (c.TextCampaign ?? c.UnifiedCampaign ?? c.MobileAppCampaign ?? c.CpmBannerCampaign)?.BiddingStrategy;
  const funds = c.Funds ?? {};
  return {
    id: c.Id,
    name: c.Name,
    type: c.Type,
    state: c.State,
    status: c.Status,
    payment: c.StatusPayment,
    note: c.StatusClarification,
    start: c.StartDate,
    end: c.EndDate,
    currency: c.Currency,
    balance: money(funds.CampaignFunds?.Balance),
    spent: money(funds.SharedAccountFunds?.Spend),
    weeklyBudget: money(findNumber(strategy, 'WeeklySpendLimit')),
    periodBudget: money(findNumber(strategy, 'SpendLimit')),
    impressions: c.Statistics?.Impressions,
    clicks: c.Statistics?.Clicks,
  };
}

function reportParams({ from, to, campaignIds, includeVat, limit, offset }) {
  const params = {
    SelectionCriteria: { DateFrom: from, DateTo: to, ...(campaignIds ? { Filter: [{ Field: 'CampaignId', Operator: 'IN', Values: campaignIds.map(String) }] } : {}) },
    FieldNames: REPORT_FIELDS,
    OrderBy: [{ Field: 'Cost', SortOrder: 'DESCENDING' }],
    Page: { Limit: limit, ...(offset ? { Offset: offset } : {}) },
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
    DateRangeType: 'CUSTOM_DATE',
    Format: 'TSV',
    IncludeVAT: includeVat ? 'YES' : 'NO',
  };
  // An offline report is known by its name: the same request keeps the name (polling), another request gets another one.
  return { ...params, ReportName: `tkbk-${createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16)}` };
}

/** Header retryIn: seconds until the report is worth asking for again. */
function retryInMs(h) {
  const seconds = Number.parseFloat(h.get('retryIn'));
  return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : POLL_DEFAULT_S, POLL_MAX_S) * MS_PER_SECOND;
}

/**
 * The report as TSV text, or null while Direct is still building it. 200 — ready; 201 — queued offline; 202 — being built:
 * the same request is repeated after retryIn until it is ready or the wait budget is spent.
 */
async function fetchReport(env, params) {
  const started = Date.now();
  for (let poll = 0; poll < POLL_MAX; poll++) {
    const r = await request(`${base(env)}/reports`, { method: 'POST', headers: { ...headers(env), ...REPORT_HEADERS }, body: { params }, idempotent: true, full: true });
    if (r.status === HTTP_OK) return r.data ?? '';
    const wait = retryInMs(r.headers);
    if (poll + 1 >= POLL_MAX || Date.now() - started + wait > POLL_BUDGET_MS) break;
    await delay(wait);
  }
  return null;
}

/** TSV → rows by column name; "--" (no data) is dropped. */
function parseReport(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l && !l.startsWith('Total rows'));
  const head = lines.findIndex((l) => l.includes('CampaignId'));
  if (head < 0) return [];
  const columns = lines[head].split('\t');
  return lines.slice(head + 1).map((line) => Object.fromEntries(line.split('\t').map((v, i) => [columns[i], v === '--' ? undefined : v])));
}

const statRow = (r) => ({
  campaignId: num(r.CampaignId),
  campaignName: r.CampaignName,
  impressions: num(r.Impressions),
  clicks: num(r.Clicks),
  ctr: num(r.Ctr),
  cost: num(r.Cost),
  conversions: num(r.Conversions),
  costPerConversion: num(r.CostPerConversion),
});

function totalsOf(rows) {
  const sum = (key) => round2(rows.reduce((s, r) => s + (r[key] ?? 0), 0));
  const t = { impressions: sum('impressions'), clicks: sum('clicks'), cost: sum('cost'), conversions: sum('conversions') };
  return {
    ...t,
    ...(t.impressions ? { ctr: round2((t.clicks / t.impressions) * PERCENT) } : {}),
    ...(t.conversions ? { costPerConversion: round2(t.cost / t.conversions) } : {}),
  };
}

const dateInput = (what) => z.string().regex(DATE, 'Expected YYYY-MM-DD').optional().describe(what);
const idsInput = z.array(z.number().int().min(1)).min(1).max(IDS_MAX).optional();

export default {
  name: 'yandex-direct',
  title: 'Yandex Direct',
  env: ['DIRECT_TOKEN'],
  optionalEnv: ['DIRECT_CLIENT_LOGIN'],
  tools: [
    {
      name: 'direct_campaigns',
      description: 'Yandex Direct campaigns: id, name, type, state (ON, OFF, SUSPENDED, ENDED, ARCHIVED), moderation status, payment status, dates, currency, '
        + 'balance (spend, when a shared account is used), weekly or period budget limit of the bidding strategy, lifetime impressions and clicks. '
        + 'The API has weekly and period budgets, no daily one. When nextOffset is returned, call again with offset=nextOffset.',
      input: {
        states: z.array(z.enum(STATES)).min(1).optional().describe('Only campaigns in these states'),
        ids: idsInput.describe('Only these campaign ids'),
        limit: z.number().int().min(1).max(CAMPAIGNS_MAX).optional().describe(`Campaigns, default ${CAMPAIGNS_DEFAULT}`),
        offset: z.number().int().min(0).optional(),
      },
      maxItems: CAMPAIGNS_MAX,
      run: async ({ states, ids, limit = CAMPAIGNS_DEFAULT, offset = 0 }, env) => {
        const params = {
          SelectionCriteria: { ...(ids ? { Ids: ids } : {}), ...(states ? { States: states } : {}) },
          FieldNames: CAMPAIGN_FIELDS,
          ...STRATEGY_FIELDS,
          Page: { Limit: limit, Offset: offset },
        };
        const r = await rpc(env, 'campaigns', 'get', params);
        return { campaigns: (r?.Campaigns ?? []).map(campaignOut), ...(r?.LimitedBy ? { nextOffset: r.LimitedBy } : {}) };
      },
    },
    {
      name: 'direct_stats',
      description: 'Yandex Direct statistics by campaign for a period (report CAMPAIGN_PERFORMANCE_REPORT), biggest spenders first: impressions, clicks, CTR %, '
        + 'cost, conversions (all Metrika goals), cost per conversion. Money is in the account currency; cost includes VAT unless includeVat=false. '
        + 'Direct may build the report offline: the call waits for it, and if it is still not ready it says so — then call again with the same arguments. '
        + 'When nextOffset is returned, call again with offset=nextOffset; totals sum the returned rows only.',
      input: {
        dateFrom: dateInput(`Start date, YYYY-MM-DD; default ${REPORT_DEFAULT_DAYS - 1} days ago`),
        dateTo: dateInput('End date, YYYY-MM-DD; default today'),
        campaignIds: idsInput.describe('Only these campaign ids'),
        includeVat: z.boolean().optional().describe('Money with VAT, default true'),
        limit: z.number().int().min(1).max(ROWS_MAX).optional().describe(`Campaigns, default ${ROWS_DEFAULT}`),
        offset: z.number().int().min(0).optional(),
      },
      maxItems: ROWS_MAX,
      run: async ({ dateFrom, dateTo, campaignIds, includeVat = true, limit = ROWS_DEFAULT, offset = 0 }, env) => {
        const now = Date.now();
        const from = dateFrom ?? isoDate(now - (REPORT_DEFAULT_DAYS - 1) * DAY_MS);
        const to = dateTo ?? isoDate(now);
        const text = await fetchReport(env, reportParams({ from, to, campaignIds, includeVat, limit, offset }));
        if (text === null) return 'Yandex Direct is still building this report (offline queue). Call direct_stats again with the same arguments in about a minute.';
        const rows = parseReport(text).map(statRow);
        return { period: { from, to }, rows, totals: totalsOf(rows), ...(rows.length === limit ? { nextOffset: offset + limit } : {}) };
      },
    },
  ],
};
